/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single source of truth for monetary arithmetic and formatting.
 * All money is held as a number of major units (dollars) but every operation
 * rounds through minor units (cents) so repeated addition cannot drift.
 * USD and JMD are never added together anywhere in this application.
 */

import { Currency } from '../types';

/** Round a monetary value to 2 decimal places, killing float noise such as 0.1 + 0.2. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Read a figure someone typed or pasted, or refuse it.
 *
 * This used to strip out every character that was not a digit, a dot or a minus
 * and then hand what was left to parseFloat. That is wonderfully forgiving of
 * "$50,000", and quietly catastrophic with anything else, because it always
 * produced *a* number and never an objection:
 *
 *     "1.500.000"  ->  1.5          a million and a half becomes one and a half
 *     "50000abc"   ->  50000        junk silently accepted
 *     "1e999"      ->  1999         a figure nobody typed
 *     "5-0-0"      ->  5
 *
 * A wrong figure that looks deliberate is worse than a refused one: it lands in
 * the ledger, gets receipted, and reconciles against nothing. So the grammar is
 * now explicit — a plain figure, or one grouped in threes by commas or spaces,
 * with an optional currency symbol — and anything else returns null for the
 * caller to reject.
 *
 * "50.000" is still read as fifty, because it is a valid plain decimal and there
 * is no way to tell it apart from fifty-point-zero. Multiple dots are the
 * unambiguous case, and those are now refused.
 *
 * **Refuse the null, never default it to zero.** A `?? 0` here books a silent
 * zero into the ledger for a figure somebody actually typed, and a wrong figure
 * that looks deliberate is worse than a refused one. There used to be a
 * `toMoney` helper that did exactly that defaulting; nothing called it, and it
 * has been removed rather than left as a trap.
 */
export function parseMoneyInput(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? round2(value) : null;
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  // A currency marker on either end is ordinary and harmless.
  const bare = raw
    .replace(/^(US\$|J\$|\$|USD|JMD)\s*/i, '')
    .replace(/\s*(USD|JMD)$/i, '')
    .trim();
  if (!bare) return null;

  const grouped = /^-?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?$/;
  const plain = /^-?\d+(?:\.\d+)?$/;

  let normalised: string;
  if (grouped.test(bare)) normalised = bare.replace(/[ ,]/g, '');
  else if (plain.test(bare)) normalised = bare;
  else return null;

  const n = Number(normalised);
  return Number.isFinite(n) ? round2(n) : null;
}

/** Sum monetary values without accumulating float error. */
export function sumMoney(values: number[]): number {
  const cents = values.reduce((acc, v) => acc + Math.round(round2(v) * 100), 0);
  return round2(cents / 100);
}

export function addMoney(a: number, b: number): number {
  return sumMoney([a, b]);
}

export function subtractMoney(a: number, b: number): number {
  return sumMoney([a, -b]);
}

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: '$',
  JMD: 'J$'
};

/** "J$25,000.00" — always two decimals so printed statements line up and cents are never hidden. */
export function formatMoney(amount: number, currency: Currency): string {
  const safe = round2(Number(amount) || 0);
  const formatted = Math.abs(safe).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${safe < 0 ? '-' : ''}${CURRENCY_SYMBOL[currency] || ''}${formatted}`;
}

/** "USD $1,200.00" — for documents where the currency must be unambiguous. */
export function formatMoneyLong(amount: number, currency: Currency): string {
  return `${currency} ${formatMoney(amount, currency)}`;
}

/**
 * Indicative conversion for display only. Converted figures are always labelled
 * as indicative; no stored amount is ever rewritten using this.
 */
export function convertIndicative(amount: number, from: Currency, to: Currency, jmdPerUsd: number): number {
  if (from === to) return round2(amount);
  const rate = Number(jmdPerUsd) > 0 ? Number(jmdPerUsd) : 155;
  if (from === 'USD') return round2(amount * rate);
  return round2(amount / rate);
}

export const DEFAULT_FX_RATE_JMD_PER_USD = 155;
