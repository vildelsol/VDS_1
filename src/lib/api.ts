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

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
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
}

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isMutation = MUTATING.has(method);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // One key per logical action, reused for every retry of it.
  if (isMutation) headers['Idempotency-Key'] = newIdempotencyKey();

  const deadline = Date.now() + MAX_WAIT_MS;
  if (isMutation) {
    pendingWrites++;
    publish();
  }

  try {
    for (;;) {
      let res: Response;
      try {
        res = await fetch(path, {
          method,
          headers,
          credentials: 'same-origin',
          body: body === undefined ? undefined : JSON.stringify(body)
        });
      } catch {
        // Network-level failure (server unreachable). Wait for it to return, then
        // retry the identical request — safe because of the idempotency key.
        await waitForServer(deadline);
        continue;
      }

      // The request reached the server: we are online.
      setConnection('online');

      const payload = await parse(res);
      if (!res.ok) {
        const serverMessage =
          payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : '';
        const message = serverMessage || `Request failed (HTTP ${res.status}).`;
        if (res.status === 401 && onUnauthenticated) onUnauthenticated();
        // A "still processing" duplicate (idempotent in-flight) — wait and retry.
        if (res.status === 409 && res.headers.get('Idempotent-Replayed') === null && /still being processed/i.test(message)) {
          await sleep(RETRY_EVERY_MS);
          if (Date.now() < deadline) continue;
        }
        throw new ApiError(res.status, message);
      }
      return payload as T;
    }
  } finally {
    if (isMutation) {
      pendingWrites = Math.max(0, pendingWrites - 1);
      publish();
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
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
