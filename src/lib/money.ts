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

/** Coerce arbitrary form input to a safe monetary number. Rejects NaN/Infinity. */
export function toMoney(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return round2(n);
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

/** Plain number with 2dp, no symbol — for CSV exports. */
export function formatMoneyPlain(amount: number): string {
  return round2(Number(amount) || 0).toFixed(2);
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
