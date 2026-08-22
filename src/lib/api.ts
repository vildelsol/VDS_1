/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single API client, with brief-interruption resilience.
 *
 * On the property's two-PC setup the link between the Kamrui client and the HP
 * server can blip for a few seconds (a switch, Wi-Fi, or Tailscale hiccup). This
 * client is built so that does not lose the user's work:
 *
 *  - A dropped request is not failed immediately. The client waits for the server
 *    to come back (polling /api/health) and retries the *same* request.
 *  - Every mutating request carries a stable Idempotency-Key that is reused across
 *    those retries, so if the first attempt actually reached the server and only
 *    the reply was lost, the retry is a safe no-op — no duplicate payment, ever.
 *  - Connection state is published so the app can show a reconnecting banner.
 *
 * This deliberately covers short interruptions, not extended offline working:
 * financial entry against stale data over a long outage needs conflict handling
 * this app does not attempt. After the cap, the request fails cleanly and the
 * form keeps what was typed, so nothing is lost — the user simply retries.
 */

import { describeAction, enqueue, markAttempt, pendingActions, removeQueued } from './queue';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * A machine-readable marker for refusals the screen must react to rather than
     * merely display — offering the acknowledgement that turns a refusal into a
     * deliberate act. Matching on the message text would break the first time
     * anyone rewords it.
     */
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isAuthError() {
    return this.status === 401;
  }
  get isNetwork() {
    return this.status === 0;
  }
  /**
   * Set when the action could not be sent but has been written down and will be
   * sent automatically when the server returns. The caller has not lost the work
   * — but it is emphatically not done yet, and must never be reported as if it
   * were.
   */
  queued = false;
}

/**
 * The server refused a receipt because the account it names has already been
 * settled — most often because somebody else banked the same money while this
 * form was open. The screen turns this into an explicit acknowledgement rather
 * than a dead end. Kept in step with `ALREADY_SETTLED` in server.ts.
 */
export const ALREADY_SETTLED = 'account-already-settled';

/**
 * The server refused a correction because it would change the receipt's
 * currency. Nothing converts the amount and the receipt moves to the other
 * currency's account, so it is refused once and has to be confirmed. Kept in
 * step with `CURRENCY_CHANGE` in server.ts.
 */
export const CURRENCY_CHANGE = 'currency-change-not-confirmed';

/**
 * The server refused a change of tenant because it cannot tell which of two
 * quite different things is being asked for.
 *
 * Replacing the name because it was typed wrong and replacing it because
 * somebody new moved in look identical over the wire, and they must not do the
 * same thing: a changeover closes the tenancy, dates the new one, and bills first
 * and last month's rent, while a correction should do none of that. Guessing it
 * from the dates was tried and reverted — a real handover very often follows a
 * tenant who had no move-in date recorded either. So the screen asks, and sends
 * the answer as `tenantChangeIntent`. Kept in step with `TENANT_INTENT` in
 * server.ts.
 */
export const TENANT_INTENT = 'tenant-change-intent-required';

/**
 * The same refusal for the proprietor, and it reaches further than the tenant
 * one. Contributions are levied on proprietors and Form 13B reports what each
 * owes against their strata lot, so a villa that changes hands mid-year leaves
 * its arrears with the seller. A corrected spelling must not look like a sale,
 * and a sale must not look like a typo. Kept in step with `OWNER_INTENT` in
 * server.ts.
 */
export const OWNER_INTENT = 'owner-change-intent-required';

let onUnauthenticated: (() => void) | null = null;

/** Registered by App so an expired session bounces the user to the sign-in screen. */
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

/* ------------------------------------------------------------------ *
 * Connection state
 * ------------------------------------------------------------------ */

export type ConnectionState = 'online' | 'reconnecting';

let connection: ConnectionState = 'online';
let pendingWrites = 0;
const listeners = new Set<(s: ConnectionState, pending: number) => void>();

function publish() {
  for (const fn of listeners) fn(connection, pendingWrites);
}

function setConnection(state: ConnectionState) {
  if (connection !== state) {
    connection = state;
    publish();
  }
}

export function subscribeConnection(fn: (state: ConnectionState, pendingWrites: number) => void): () => void {
  listeners.add(fn);
  fn(connection, pendingWrites);
  return () => listeners.delete(fn);
}

export function getConnection(): ConnectionState {
  return connection;
}

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

const RETRY_EVERY_MS = 2000;
// How long to keep trying a dropped request before giving up. Comfortably covers
// a "few seconds" blip; long enough that a brief Tailscale re-handshake recovers.
const MAX_WAIT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 4000;

/**
 * How long any single attempt may sit there before it is treated as a drop.
 *
 * Without this the client could wait forever. A refused connection rejects
 * immediately, but a socket that is *accepted and then never answered* — a server
 * still finishing its start-up, a wedged process, or a half-open Tailscale
 * connection — leaves `fetch` pending with no timeout of its own. The retry cap
 * below never came into play, because a request that never settles never throws:
 * the application simply sat on its loading spinner indefinitely. Every attempt is
 * now bounded, so a stall is detected and handled like any other interruption.
 */
const ATTEMPT_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function serverReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve once the server answers /api/health again, or throw after the cap. */
async function waitForServer(deadline: number): Promise<void> {
  setConnection('reconnecting');
  while (Date.now() < deadline) {
    await sleep(RETRY_EVERY_MS);
    if (await serverReachable()) {
      setConnection('online');
      return;
    }
  }
  throw new ApiError(0, 'The connection to the server was lost. Your entry has not been saved — check the network and try again.');
}

// The browser's own signals are a useful hint, though not authoritative here.
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setConnection('reconnecting'));
  window.addEventListener('online', () => {
    void serverReachable().then(ok => ok && setConnection('online'));
  });
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const MUTATING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface RequestOptions {
  /**
   * Give up as soon as the server cannot be reached, instead of waiting out the
   * reconnect window. Used for the start-up session probe: there is nothing to
   * lose by failing fast, and a silent wait there is indistinguishable from the
   * application being broken.
   */
  failFast?: boolean;
  /** Internal: this call is a replay of an already-queued action. */
  replayOf?: string;
  /** Internal: reuse the queued action's original idempotency key. */
  replayKey?: string;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const isMutation = MUTATING.has(method);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // One key per logical action, reused for every attempt of it — including a
  // replay hours later, after a restart. That is what makes replaying safe.
  const idempotencyKey = opts.replayKey || newIdempotencyKey();
  if (isMutation) headers['Idempotency-Key'] = idempotencyKey;

  /**
   * Write the action down before trying to send it, so it survives the tab or
   * the machine dying mid-request. A replay is already in the queue and must not
   * be added to it twice.
   */
  const queued =
    isMutation && !opts.replayOf
      ? enqueue({ method, path, body, idempotencyKey, label: describeAction(method, path) })
      : null;
  const queueId = opts.replayOf || queued?.id || null;

  const deadline = Date.now() + MAX_WAIT_MS;
  if (isMutation) {
    pendingWrites++;
    publish();
  }

  try {
    for (;;) {
      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        res = await fetch(path, {
          method,
          headers,
          credentials: 'same-origin',
          signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch {
        // Unreachable, or accepted and left hanging past the attempt timeout.
        // Either way the attempt is over.
        if (opts.failFast) {
          setConnection('reconnecting');
          throw new ApiError(0, 'The server is not responding yet.');
        }
        if (queueId) markAttempt(queueId);
        try {
          // Wait for it to return, then retry the identical request — safe
          // because of the idempotency key.
          await waitForServer(deadline);
        } catch (waitErr) {
          // The server did not come back inside the window. For a mutation the
          // action stays in the queue and is sent when it does; the caller is
          // told it is kept, not that it is done.
          if (queueId) {
            const err = new ApiError(0, 'Saved on this computer. It will be sent automatically when the server is back.');
            err.queued = true;
            throw err;
          }
          throw waitErr;
        }
        continue;
      } finally {
        clearTimeout(timer);
      }

      // The request reached the server: we are online.
      setConnection('online');

      const payload = await parse(res);
      if (!res.ok) {
        const serverMessage =
          payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : '';
        const message = serverMessage || `Request failed (HTTP ${res.status}).`;
        const code =
          payload && typeof payload === 'object' && 'code' in payload ? String((payload as { code: unknown }).code) : undefined;
        if (res.status === 401 && onUnauthenticated) onUnauthenticated();
        // A "still processing" duplicate (idempotent in-flight) — wait and retry.
        if (res.status === 409 && res.headers.get('Idempotent-Replayed') === null && /still being processed/i.test(message)) {
          await sleep(RETRY_EVERY_MS);
          if (Date.now() < deadline) continue;
        }
        // The server answered. Whether it accepted or refused, this action is
        // settled and must not be replayed: a rejected request will be rejected
        // again, and replaying it forever would block everything behind it.
        if (queueId) removeQueued(queueId);
        throw new ApiError(res.status, message, code);
      }
      if (queueId) removeQueued(queueId);
      return payload as T;
    }
  } finally {
    if (isMutation) {
      pendingWrites = Math.max(0, pendingWrites - 1);
      publish();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Replaying work that was entered while the server was away
 * ------------------------------------------------------------------ */

export type SyncState =
  | { phase: 'idle'; pending: number }
  | { phase: 'syncing'; pending: number; done: number; total: number; current: string }
  | { phase: 'done'; uploaded: string[] }
  | { phase: 'failed'; pending: number; message: string };

let syncState: SyncState = { phase: 'idle', pending: 0 };
const syncListeners = new Set<(s: SyncState) => void>();

function publishSync(next: SyncState) {
  syncState = next;
  for (const fn of syncListeners) fn(next);
}

export function subscribeSync(fn: (state: SyncState) => void): () => void {
  syncListeners.add(fn);
  fn(syncState);
  return () => syncListeners.delete(fn);
}

export function getPendingCount(): number {
  return pendingActions().length;
}

let flushing = false;

/**
 * Send everything that was entered while the server was unreachable.
 *
 * Strictly in the order it was entered, and strictly one at a time: a payment
 * confirmation entered after the payment it confirms has to arrive after it, and
 * firing the queue off in parallel would race them. Each carries the idempotency
 * key it was first given, so anything that actually did reach the server before
 * the connection dropped is recognised and not recorded twice.
 *
 * Stops at the first item that still cannot be sent, leaving it and everything
 * behind it queued for the next attempt.
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  const queue = pendingActions();
  if (queue.length === 0) {
    publishSync({ phase: 'idle', pending: 0 });
    return;
  }
  flushing = true;
  const uploaded: string[] = [];

  try {
    for (let i = 0; i < queue.length; i++) {
      const action = queue[i];
      publishSync({
        phase: 'syncing',
        pending: queue.length - i,
        done: i,
        total: queue.length,
        current: action.label
      });
      try {
        await request(action.method, action.path, action.body, {
          replayOf: action.id,
          replayKey: action.idempotencyKey
        });
        uploaded.push(action.label);
      } catch (err) {
        if (err instanceof ApiError && (err.isNetwork || err.queued)) {
          // Still unreachable. Leave this and the rest for next time.
          publishSync({
            phase: 'failed',
            pending: pendingActions().length,
            message: 'Still waiting for the server. Your entries are safe and will be sent automatically.'
          });
          return;
        }
        // The server refused it. `request` has already dropped it from the
        // queue, because replaying a rejected action would block the queue
        // forever. Carry on with the rest and report it.
        uploaded.push(`${action.label} — refused by the server`);
      }
    }
    publishSync({ phase: 'done', uploaded });
    // Let the operator read the result, then fall back to quiet.
    setTimeout(() => {
      if (syncState.phase === 'done') publishSync({ phase: 'idle', pending: pendingActions().length });
    }, 6000);
  } finally {
    flushing = false;
  }
}

/**
 * Watch for the server coming back and send anything outstanding.
 *
 * Polls only while there is something to send, so an idle application does no
 * background work at all.
 */
let watchTimer: ReturnType<typeof setInterval> | null = null;

export function startQueueWatcher() {
  if (watchTimer) return;
  const tick = async () => {
    const queue = pendingActions();
    if (queue.length === 0) return;
    if (flushing) return;
    if (await serverReachable()) {
      setConnection('online');
      await flushQueue();
    }
  };
  void tick();
  watchTimer = setInterval(() => void tick(), RETRY_EVERY_MS * 2);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void tick());
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body ?? {})
};

/** Normalise anything thrown into a message safe to show a user. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
