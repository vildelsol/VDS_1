/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sign-in throttling.
 *
 * History. It began as a lockout per username, which let anybody on the network type
 * a real username thirty times and lock that person out. It became a bucket per
 * (username, client address), which slowed only the address doing the guessing. A
 * security pass then found three ways round that, and one remaining way to hurt the
 * real user:
 *
 *  - The check ran BEFORE the (asynchronous) password check and the failure was
 *    counted AFTER it, so a burst of simultaneous guesses all passed the check
 *    (300 of 300 got through). A guess is now RESERVED in the buckets before the
 *    password is looked at, and handed back if the password turns out right.
 *  - There was no cap across usernames or overall: one address could spray one
 *    guess at each of thousands of usernames. Unknown devices now also share a
 *    per-address cap and a global cap.
 *  - Pruning dropped the oldest entries when the table filled, so flooding it with
 *    made-up usernames un-blocked a blocked pair. A blocked entry is never evicted.
 *  - A guesser on the same address as the real user still locked the real user
 *    out. A browser that has signed in as a user before carries a "known device"
 *    cookie (random, stored hashed); its attempts are counted in a bucket of their
 *    own, (username, device), which nobody who lacks the cookie can reach, spend
 *    from, or block. Everything without a valid cookie shares the stricter pair and
 *    per-address buckets.
 *
 * Shape of a bucket: the first `free` failures cost nothing (people mistype). Each
 * failure after that blocks the bucket for `base` doubled per extra failure, up to
 * MAX_DELAY_MS. A bucket left alone for IDLE_RESET_MS starts clean.
 *
 * Kept free of the server's imports so a test can load it on its own, with a
 * clock it controls.
 */

export const FREE_FAILURES = 5;
export const BASE_DELAY_MS = 30 * 1000;
export const MAX_DELAY_MS = 15 * 60 * 1000;
export const IDLE_RESET_MS = 60 * 60 * 1000;
/** A browser that has never signed in as this user gets fewer free mistakes and longer waits than one that has. */
export const UNKNOWN_FREE_FAILURES = 3;
export const UNKNOWN_BASE_DELAY_MS = 60 * 1000;
/** Failed attempts allowed per address (across usernames) and overall, from devices that are not known, per window. */
// Ro, 2026-11-21: 10 failed sign-ins per address (was 30).
export const IP_CAP = 10;
export const GLOBAL_CAP = 300;
export const CAP_WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

export interface ThrottleEntry {
  username: string;
  ip: string;
  failures: number;
  blockedUntil: number;
  lastFailure: number;
  /** True once the current block has been written to the audit trail. */
  noted?: boolean;
  /** A bucket for a known device rather than for an address. */
  device?: boolean;
}

interface Policy {
  free: number;
  base: number;
}
const STANDARD: Policy = { free: FREE_FAILURES, base: BASE_DELAY_MS };
const UNKNOWN: Policy = { free: UNKNOWN_FREE_FAILURES, base: UNKNOWN_BASE_DELAY_MS };

export type ThrottleCheck = { allowed: true } | { allowed: false; retryAfterMs: number; firstRefusal: boolean };

export type Reservation =
  | {
      allowed: true;
      /** True when this was the first failed guess against its bucket (so the caller may note it once). */
      firstOfRun: boolean;
      /** Report the outcome. `true` hands the reserved guess back and clears the bucket; `false` leaves it counted. */
      settle: (correct: boolean) => void;
    }
  | { allowed: false; retryAfterMs: number; firstRefusal: boolean; scope: 'device' | 'pair' | 'address' | 'global' };

interface Window {
  count: number;
  start: number;
  noted: boolean;
}

export class LoginThrottle {
  private entries = new Map<string, ThrottleEntry>();
  private devices = new Map<string, ThrottleEntry>();
  private addresses = new Map<string, Window>();
  private global: Window = { count: 0, start: 0, noted: false };
  private ipCap: number;
  private globalCap: number;
  /** `caps` lets the server (from VDS_LOGIN_IP_CAP / VDS_LOGIN_GLOBAL_CAP) and a test raise or lower the two shared caps. */
  constructor(
    private now: () => number = Date.now,
    caps: { ipCap?: number; globalCap?: number } = {}
  ) {
    this.ipCap = caps.ipCap ?? IP_CAP;
    this.globalCap = caps.globalCap ?? GLOBAL_CAP;
  }

  private key(ip: string, username: string) {
    return `${ip}\u0000${username}`;
  }

  private live(map: Map<string, ThrottleEntry>, k: string): ThrottleEntry | undefined {
    const e = map.get(k);
    if (e && this.now() - e.lastFailure > IDLE_RESET_MS && e.blockedUntil <= this.now()) {
      map.delete(k);
      return undefined;
    }
    return e;
  }

  private refusal(e: ThrottleEntry, scope: 'device' | 'pair') {
    const firstRefusal = !e.noted;
    e.noted = true;
    return { allowed: false as const, retryAfterMs: e.blockedUntil - this.now(), firstRefusal, scope };
  }

  /** Count one failure into `e` and start a block when the free allowance is used up. Returns the block (ms). */
  private count(e: ThrottleEntry, policy: Policy): number {
    const now = this.now();
    e.failures += 1;
    e.lastFailure = now;
    if (e.failures < policy.free) return 0;
    const delay = Math.min(MAX_DELAY_MS, policy.base * 2 ** (e.failures - policy.free));
    e.blockedUntil = now + delay;
    e.noted = false;
    return delay;
  }

  private window(w: Window): Window {
    const now = this.now();
    if (now - w.start >= CAP_WINDOW_MS) {
      w.count = 0;
      w.start = now;
      w.noted = false;
    }
    return w;
  }

  /*
   * ---- The server's entry point: reserve a guess BEFORE the password is checked. ----
   *
   * `deviceKey` is the hash of a known-device cookie that belongs to this username, or null. With one, only the
   * (username, device) bucket is consulted and charged: the per-address and global caps are for devices the
   * system has never seen, and must not be spendable by somebody else on the same address. Without one, the
   * global cap, the address cap and the (address, username) bucket must all admit the attempt, and all are charged.
   */
  reserve(ip: string, username: string, deviceKey: string | null): Reservation {
    const now = this.now();

    if (deviceKey) {
      const k = `${username}\u0000${deviceKey}`;
      const existing = this.live(this.devices, k);
      if (existing && existing.blockedUntil > now) return this.refusal(existing, 'device');
      const e = existing || { username, ip: '(known device)', failures: 0, blockedUntil: 0, lastFailure: now, device: true };
      const firstOfRun = e.failures === 0;
      if (!existing) this.devices.set(k, e);
      this.count(e, STANDARD);
      return { allowed: true, firstOfRun, settle: correct => void (correct && this.devices.delete(k)) };
    }

    const g = this.window(this.global);
    if (g.count >= this.globalCap) {
      const first = !g.noted;
      g.noted = true;
      return { allowed: false, retryAfterMs: g.start + CAP_WINDOW_MS - now, firstRefusal: first, scope: 'global' };
    }
    let a = this.addresses.get(ip);
    if (!a) {
      if (this.addresses.size >= MAX_ENTRIES) this.pruneAddresses();
      a = { count: 0, start: now, noted: false };
      this.addresses.set(ip, a);
    }
    this.window(a);
    if (a.count >= this.ipCap) {
      const first = !a.noted;
      a.noted = true;
      return { allowed: false, retryAfterMs: a.start + CAP_WINDOW_MS - now, firstRefusal: first, scope: 'address' };
    }
    const pairKey = this.key(ip, username);
    let e = this.live(this.entries, pairKey);
    if (e && e.blockedUntil > now) return this.refusal(e, 'pair');
    if (!e) {
      if (this.entries.size >= MAX_ENTRIES) this.prune();
      // Full of blocked pairs: refuse rather than evict one, or flooding the table would unblock them.
      if (this.entries.size >= MAX_ENTRIES) {
        return { allowed: false, retryAfterMs: 60 * 1000, firstRefusal: false, scope: 'global' };
      }
      e = { username, ip, failures: 0, blockedUntil: 0, lastFailure: now };
      this.entries.set(pairKey, e);
    }
    const firstOfRun = e.failures === 0;
    this.count(e, UNKNOWN);
    g.count += 1;
    a.count += 1;
    return {
      allowed: true,
      firstOfRun,
      settle: correct => {
        if (!correct) return;
        // The guess was right: hand it back to the shared caps and clear this pair.
        this.global.count = Math.max(0, this.global.count - 1);
        const w = this.addresses.get(ip);
        if (w) w.count = Math.max(0, w.count - 1);
        this.entries.delete(pairKey);
      }
    };
  }

  /*
   * ---- The older pair-only API: kept for change-password (its own buckets, keyed on the account) and for the
   * unit tests that drive the arithmetic with a clock. ----
   */

  /** Called before the password is checked. Refuses while the pair is blocked. */
  check(ip: string, username: string): ThrottleCheck {
    const e = this.live(this.entries, this.key(ip, username));
    if (!e || e.blockedUntil <= this.now()) return { allowed: true };
    const r = this.refusal(e, 'pair');
    return { allowed: false, retryAfterMs: r.retryAfterMs, firstRefusal: r.firstRefusal };
  }

  /** Called after a wrong password. Returns the block it started, if any (ms). */
  fail(ip: string, username: string): number {
    if (this.entries.size >= MAX_ENTRIES) this.prune();
    const now = this.now();
    let e = this.live(this.entries, this.key(ip, username));
    if (!e) {
      // Still full of blocked pairs: the failure goes uncounted rather than evicting a block.
      if (this.entries.size >= MAX_ENTRIES) return 0;
      e = { username, ip, failures: 0, blockedUntil: 0, lastFailure: now };
      this.entries.set(this.key(ip, username), e);
    }
    return this.count(e, STANDARD);
  }

  /** A correct password: this pair starts clean. Other addresses are untouched. */
  succeed(ip: string, username: string) {
    this.entries.delete(this.key(ip, username));
  }

  failuresFor(ip: string, username: string): number {
    return this.live(this.entries, this.key(ip, username))?.failures ?? 0;
  }

  /** Every bucket currently on record, for the Administrator's view. */
  list(): ThrottleEntry[] {
    this.prune();
    return [...this.entries.values(), ...this.devices.values()].map(e => ({ ...e }));
  }

  /** Administrator: clear every address's and device's record for a username. Returns how many were cleared. */
  clearUser(username: string): number {
    let n = 0;
    for (const map of [this.entries, this.devices]) {
      for (const [k, e] of map) {
        if (e.username === username) {
          map.delete(k);
          n++;
        }
      }
    }
    return n;
  }

  /** Counters for the whole-system caps, for a test or an Administrator's view. */
  caps(): { global: number; addresses: number } {
    return { global: this.window(this.global).count, addresses: this.addresses.size };
  }

  /**
   * Drop entries that are idle and unblocked, and if the table is still full, the quietest unblocked ones. A blocked
   * entry is NEVER dropped to make room: an attacker filling the table with made-up usernames used to un-block a
   * blocked pair that way.
   */
  private prune() {
    const now = this.now();
    for (const map of [this.entries, this.devices]) {
      for (const [k, e] of map) {
        if (e.blockedUntil <= now && now - e.lastFailure > IDLE_RESET_MS) map.delete(k);
      }
    }
    if (this.entries.size >= MAX_ENTRIES) {
      const unblocked = [...this.entries.entries()].filter(([, e]) => e.blockedUntil <= now).sort((a, b) => a[1].lastFailure - b[1].lastFailure);
      for (const [k] of unblocked.slice(0, Math.max(0, this.entries.size - MAX_ENTRIES + 1))) this.entries.delete(k);
    }
  }

  private pruneAddresses() {
    const now = this.now();
    for (const [ip, w] of this.addresses) {
      if (now - w.start >= CAP_WINDOW_MS) this.addresses.delete(ip);
    }
    if (this.addresses.size >= MAX_ENTRIES) {
      // Only addresses that are not at their cap may be forgotten; a capped one is a block.
      const quiet = [...this.addresses.entries()].filter(([, w]) => w.count < this.ipCap).sort((a, b) => a[1].count - b[1].count);
      for (const [ip] of quiet.slice(0, Math.max(0, this.addresses.size - MAX_ENTRIES + 1))) this.addresses.delete(ip);
    }
  }
}
