/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A plain fixed-window request limiter, for writes and for sign-in attempts.
 *
 * Why it exists: nothing used to limit how fast a signed-in account (or an address) could write. Every write
 * rewrites db.json and most add an audit entry, so a junior reprinting one receipt in a loop could push the
 * genuine history off the audit trail and slow everyone's saves ten-fold. The limits are far above anything a
 * person at a desk does (a receipt a minute is busy); they are there to stop a script, not to ration staff.
 *
 * Kept free of the server's imports so a test can load it with a clock it controls.
 */

export interface LimitResult {
  ok: boolean;
  retryAfterMs: number;
}

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  /** Count one request against `key`. */
  hit(key: string): LimitResult {
    const now = this.now();
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count > this.limit) return { ok: false, retryAfterMs: Math.max(1, w.start + this.windowMs - now) };
    return { ok: true, retryAfterMs: 0 };
  }

  /** Is `key` already over the limit in the current window? Counts nothing. */
  isBlocked(key: string): LimitResult {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs || w.count < this.limit) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: Math.max(1, w.start + this.windowMs - now) };
  }

  private sweep(now: number) {
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

/** A positive integer from the environment, or the default. */
export function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
