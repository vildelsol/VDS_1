/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A durable queue of actions that have been entered but not yet accepted by the
 * server.
 *
 * The reconnect logic in api.ts already survives a Wi-Fi blip: it holds the
 * request and retries it. That only works while the page is alive. If the HP
 * reboots, or the receptionist closes the tab, or the machine goes to sleep with
 * work outstanding, everything held in memory is gone — and the person who typed
 * it has no way of knowing which of their entries actually landed.
 *
 * Every mutating request is therefore written down *before* it is attempted, and
 * only removed once the server has definitely accepted or definitely rejected it.
 * What is left is exactly the work still owed to the server, and it is replayed in
 * the order it was entered when the server comes back.
 *
 * localStorage, deliberately, rather than IndexedDB: its writes are synchronous,
 * so an entry is on disk before the call that queued it returns. An IndexedDB
 * transaction can still be in flight when the tab dies, which is precisely the
 * moment this has to be reliable. The payloads are small.
 */

const STORAGE_KEY = 'vds-pending-actions-v1';

export interface QueuedAction {
  /** Local id, only meaningful to this browser. */
  id: string;
  method: string;
  path: string;
  body?: unknown;
  /**
   * The idempotency key sent with every attempt of this action, including
   * replays after a restart. This is what makes a replay safe: if the request
   * reached the server before the connection died, the server recognises the key
   * and does not record it a second time.
   */
  idempotencyKey: string;
  /** What this is, in words a person would recognise on a progress list. */
  label: string;
  queuedAt: number;
  /** Attempts made so far, for reporting something that will not go through. */
  attempts: number;
  lastError?: string;
}

type Listener = (actions: QueuedAction[]) => void;
const listeners = new Set<Listener>();

function readAll(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedAction[]) : [];
  } catch {
    // A corrupt queue must not brick the application on load.
    return [];
  }
}

function writeAll(actions: QueuedAction[]) {
  try {
    if (actions.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {
    /* storage full or unavailable — the in-flight request still proceeds */
  }
  for (const fn of listeners) fn(actions);
}

export function pendingActions(): QueuedAction[] {
  return readAll();
}

export function subscribePending(fn: Listener): () => void {
  listeners.add(fn);
  fn(readAll());
  return () => listeners.delete(fn);
}

/**
 * A short human label for an action, so the sync list reads as work rather than
 * as HTTP. Derived from the route because that is all the queue knows.
 */
export function describeAction(method: string, path: string): string {
  const rules: [RegExp, string][] = [
    [/^\/api\/payments\/[^/]+\/confirm$/, 'Payment confirmation'],
    [/^\/api\/payments\/[^/]+\/reverse$/, 'Receipt void'],
    [/^\/api\/payments/, 'Payment'],
    [/^\/api\/charges\/post-month$/, 'Monthly charges'],
    [/^\/api\/charges/, 'Charge'],
    [/^\/api\/bookings/, 'Reservation'],
    [/^\/api\/utilities\/[^/]+\/settle$/, 'Utility settlement'],
    [/^\/api\/utilities/, 'Meter reading'],
    [/^\/api\/expenses/, 'Expense'],
    [/^\/api\/units/, 'Villa details'],
    [/^\/api\/tenancies\/[^/]+\/evict$/, 'Eviction'],
    [/^\/api\/tenancies/, 'Tenancy record'],
    [/^\/api\/unit-activities/, 'Resident activity'],
    [/^\/api\/users/, 'Staff account'],
    [/^\/api\/settings/, 'Settings change'],
    [/^\/api\/ical/, 'Calendar sync'],
    [/^\/api\/backup/, 'Backup']
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(path)) return label;
  }
  return method === 'DELETE' ? 'Deletion' : 'Change';
}

export function enqueue(action: Omit<QueuedAction, 'id' | 'queuedAt' | 'attempts'>): QueuedAction {
  const entry: QueuedAction = {
    ...action,
    id: `q-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    queuedAt: Date.now(),
    attempts: 0
  };
  writeAll([...readAll(), entry]);
  return entry;
}

export function removeQueued(id: string) {
  writeAll(readAll().filter(a => a.id !== id));
}

export function markAttempt(id: string, error?: string) {
  writeAll(
    readAll().map(a => (a.id === id ? { ...a, attempts: a.attempts + 1, lastError: error } : a))
  );
}

/** Drop everything. Only for an operator who has accepted the loss. */
export function clearQueue() {
  writeAll([]);
}
