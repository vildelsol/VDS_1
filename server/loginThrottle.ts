/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sign-in throttling, per (username, client address).
 *
 * It replaced a lockout that also counted failures per username alone. That
 * bucket was the problem: anybody on the network could type a real username with
 * a wrong password thirty times and lock that person out of their own account,
 * from wherever they were. Guessing is now slowed only for the address doing the
 * guessing. The same person at another machine is not affected, a correct
 * password resets the pair, and an Administrator can clear it.
 *
 * Shape: the first FREE_FAILURES failures cost nothing (people mistype). Each
 * failure after that blocks the pair for BASE_DELAY_MS doubled per extra failure,
 * up to MAX_DELAY_MS. A pair left alone for IDLE_RESET_MS starts clean.
 *
 * Kept free of the server's imports so a test can load it on its own, with a
 * clock it controls.
 */

export const FREE_FAILURES = 5;
export const BASE_DELAY_MS = 30 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;
export const IDLE_RESET_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export interface ThrottleEntry {
  username: string;
  ip: string;
  failures: number;
  blockedUntil: number;
  lastFailure: number;
  /** True once the current block has been written to the audit trail. */
  noted?: boolean;
}

export type ThrottleCheck = { allowed: true } | { allowed: false; retryAfterMs: number; firstRefusal: boolean };

export class LoginThrottle {
  private entries = new Map<string, ThrottleEntry>();
  constructor(private now: () => number = Date.now) {}

  private key(ip: string, username: string) {
    return `${ip}\u0000${username}`;
  }

  private live(ip: string, username: string): ThrottleEntry | undefined {
    const k = this.key(ip, username);
    const e = this.entries.get(k);
    if (e && this.now() - e.lastFailure > IDLE_RESET_MS && e.blockedUntil <= this.now()) {
      this.entries.delete(k);
      return undefined;
    }
    return e;
  }

  /** Called before the password is checked. Refuses while the pair is blocked. */
  check(ip: string, username: string): ThrottleCheck {
    const e = this.live(ip, username);
    if (!e || e.blockedUntil <= this.now()) return { allowed: true };
    const firstRefusal = !e.noted;
    e.noted = true;
    return { allowed: false, retryAfterMs: e.blockedUntil - this.now(), firstRefusal };
  }

  /** Called after a wrong password. Returns the block it started, if any (ms). */
  fail(ip: string, username: string): number {
    if (this.entries.size >= MAX_ENTRIES) this.prune();
    const now = this.now();
    let e = this.live(ip, username);
    if (!e) {
      e = { username, ip, failures: 0, blockedUntil: 0, lastFailure: now };
      this.entries.set(this.key(ip, username), e);
    }
    e.failures += 1;
    e.lastFailure = now;
    if (e.failures < FREE_FAILURES) return 0;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (e.failures - FREE_FAILURES));
    e.blockedUntil = now + delay;
    e.noted = false;
    return delay;
  }

  /** A correct password: this pair starts clean. Other addresses are untouched. */
  succeed(ip: string, username: string) {
    this.entries.delete(this.key(ip, username));
  }

  failuresFor(ip: string, username: string): number {
    return this.live(ip, username)?.failures ?? 0;
  }

  /** Every pair currently on record, for the Administrator's view. */
  list(): ThrottleEntry[] {
    this.prune();
    return [...this.entries.values()].map(e => ({ ...e }));
  }

  /** Administrator: clear every address's record for a username. Returns how many were cleared. */
  clearUser(username: string): number {
    let n = 0;
    for (const [k, e] of this.entries) {
      if (e.username === username) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }

  private prune() {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.blockedUntil <= now && now - e.lastFailure > IDLE_RESET_MS) this.entries.delete(k);
    }
    // Still full: drop the oldest, so a flood of made-up usernames cannot grow the map without bound.
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastFailure - b[1].lastFailure);
      for (const [k] of oldest.slice(0, oldest.length - MAX_ENTRIES + 1)) this.entries.delete(k);
    }
  }
}
