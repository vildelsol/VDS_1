/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The last set of records this browser successfully loaded.
 *
 * The offline queue made a half-promise. Work *entered* while the HP is down is
 * kept and replayed, so nothing typed is lost — but nothing can be *read* at all.
 * The moment the server goes away the application has no records to show, so
 * nobody can answer "what does Villa 7 owe?" at the gate, look up a tenant, or
 * check whether a bill was already settled. Losing the ability to write for ten
 * minutes is an inconvenience; losing the ability to look anything up is the
 * office stopping.
 *
 * So every successful load is kept here, and used when the server cannot be
 * reached. What comes back is the truth as of a stated moment, never presented as
 * the truth right now — see the banner in App.tsx, which names the time and does
 * not go away.
 *
 * IndexedDB, deliberately — the opposite choice from the action queue next door,
 * for the opposite reason. The queue holds work that exists nowhere else, so it
 * needs a synchronous write that is on disk before the call returns. This holds a
 * copy of records the server already has: losing it costs nothing but a blank
 * screen during an outage, so an asynchronous write is fine. And it is far larger
 * than a queued action — a synchronous JSON.stringify of the whole database on
 * every refresh would stall the interface on the machine least able to afford it.
 */

const DB_NAME = 'vds-offline';
const DB_VERSION = 1;
const STORE = 'snapshot';
const KEY = 'last-good';

export interface StoredSnapshot<T = unknown> {
  /** Whose session this was loaded under. A different user gets nothing. */
  userId: string;
  /** When the server actually answered, as epoch ms. */
  fetchedAt: number;
  data: T;
}

/** Available at all? A private window or a locked-down browser may say no. */
function supported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  if (!supported()) return Promise.resolve(undefined);
  return openDb()
    .then(
      db =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const request = fn(tx.objectStore(STORE));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => reject(request.error);
          tx.oncomplete = () => db.close();
        })
    )
    .catch(() => undefined); // A cache that cannot be reached is not an error worth surfacing.
}

/**
 * Keep this load for the next time the server is away.
 *
 * Failure is swallowed on purpose. The records are already on screen and already
 * on the server; a browser that refuses to store a copy is a reduced service, not
 * a fault the person using it can do anything about.
 */
export async function saveSnapshot<T>(userId: string, data: T): Promise<void> {
  const record: StoredSnapshot<T> = { userId, fetchedAt: Date.now(), data };
  await withStore('readwrite', store => store.put(record, KEY));
}

/**
 * The last good load for this user, if there is one.
 *
 * A snapshot taken under a different sign-in is ignored rather than shown. Two
 * people share the desk machine, and the records one of them left behind are not
 * the other's to see — nor is a stale copy a safe way to infer who is signed in.
 */
export async function loadSnapshot<T>(userId: string): Promise<StoredSnapshot<T> | null> {
  const record = await withStore<StoredSnapshot<T>>('readonly', store => store.get(KEY));
  if (!record || record.userId !== userId) return null;
  return record;
}

/** Drop it. Called on sign-out: records must not outlive the session that loaded them. */
export async function clearSnapshot(): Promise<void> {
  await withStore('readwrite', store => store.delete(KEY));
}
