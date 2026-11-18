/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The maintenance levy, dated.
 *
 * Ro, 2026-11-18: the levy rises from J$20,000 to J$27,000 on 1 January 2027.
 * Until this module the register held ONE levy figure per villa, and a charge's
 * amount was whatever that figure was at the moment the charge was raised. So the
 * rise had to be typed in after December was posted and before January was, on
 * the right day, by the right person; the projection forecast January to May at
 * the old figure; and a December posted late (in January) would have billed the
 * NEW levy for an OLD month.
 *
 * The model:
 *
 *   - `unit.monthlyMaintenance` is the standing levy: the figure for every month
 *     before the villa's first dated change. A villa with no schedule (every
 *     database written before this existed) bills it for every month, exactly as
 *     before. Nothing is rewritten on load; absence of a schedule IS the legacy
 *     behaviour.
 *   - `unit.maintenanceSchedule` is a list of dated changes, `{effectiveFrom:
 *     'YYYY-MM', amount, currency}`. The levy for month M is the amount of the
 *     latest change with `effectiveFrom <= M`, else the standing figure.
 *   - Charges already raised are never touched. A charge carries its own amount;
 *     the schedule only decides what a NEW charge for a month is raised at.
 *
 * Per villa rather than one property-wide figure, because the register already
 * levies per villa: two villas are billed in US dollars (US$125), and the levy
 * may lawfully be weighted by unit entitlement, so "the fee" is not one number.
 * The property-wide rise is entered once through the bulk endpoint, which writes
 * the same dated change to every villa billed in that currency.
 *
 * Deliberately free of imports from `finance.ts` so finance can depend on it.
 */

import { Currency, FeeChange, Unit } from '../types';
import { round2 } from './money';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The currency the levy is billed in (mirrors `chargeCurrency` without importing finance). */
function levyCurrency(unit: Unit): Currency {
  return unit.maintCurrency || unit.currency;
}

/** Is this a usable schedule entry? Malformed ones are ignored for billing and reported by integrity. */
export function isWellFormedFeeChange(entry: unknown): entry is FeeChange {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as FeeChange;
  return typeof e.effectiveFrom === 'string' && MONTH.test(e.effectiveFrom) && typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount > 0;
}

/**
 * The villa's dated levy changes that can be billed from, oldest first.
 *
 * An entry in a currency other than the villa's levy currency is left out: a
 * J$ figure is never billed as US$. Integrity reports it.
 */
export function levySchedule(unit: Unit): FeeChange[] {
  const raw = Array.isArray(unit.maintenanceSchedule) ? unit.maintenanceSchedule : [];
  const cur = levyCurrency(unit);
  return raw
    .filter(isWellFormedFeeChange)
    .filter(e => (e.currency || cur) === cur)
    .slice()
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** Does this villa carry any dated levy change at all? */
export function hasLevySchedule(unit: Unit): boolean {
  const raw = unit.maintenanceSchedule as unknown;
  return raw !== undefined && raw !== null && (!Array.isArray(raw) || raw.length > 0);
}

/** The dated change in force for a month, or null when the standing figure applies. */
export function levyChangeInForce(unit: Unit, month: string): FeeChange | null {
  let found: FeeChange | null = null;
  for (const e of levySchedule(unit)) {
    if (e.effectiveFrom <= month) found = e;
    else break;
  }
  return found;
}

/** The maintenance levy owed by this villa for one month (YYYY-MM). */
export function levyForMonth(unit: Unit, month: string): number {
  const change = levyChangeInForce(unit, month);
  return round2(change ? change.amount : unit.monthlyMaintenance || 0);
}

/** Changes that take effect after `month`, oldest first: the "upcoming" list. */
export function upcomingLevyChanges(unit: Unit, month: string): FeeChange[] {
  return levySchedule(unit).filter(e => e.effectiveFrom > month);
}

/**
 * The first month of a range whose levy a schedule edit would move.
 *
 * Adding (or removing) a change at `effectiveFrom` alters the levy from that month
 * up to the next dated change, exclusive. Returned as [from, toExclusive|null].
 */
export function monthsAffectedBy(unit: Unit, effectiveFrom: string): { from: string; until: string | null } {
  const next = levySchedule(unit).find(e => e.effectiveFrom > effectiveFrom);
  return { from: effectiveFrom, until: next ? next.effectiveFrom : null };
}

/** Machine codes for a refused schedule edit. Pinned by test/feat-fee-schedule. */
export const FEE_CODES = {
  monthFormat: 'FEE_MONTH_FORMAT',
  amountInvalid: 'FEE_AMOUNT_INVALID',
  currencyMismatch: 'FEE_CURRENCY_MISMATCH',
  duplicateMonth: 'FEE_DUPLICATE_MONTH',
  monthClosed: 'FEE_MONTH_CLOSED',
  monthPosted: 'FEE_MONTH_POSTED',
  notFound: 'FEE_ENTRY_NOT_FOUND',
  scheduleGoverns: 'FEE_SCHEDULE_GOVERNS'
} as const;

/** Plausibility ceiling on a monthly levy, so a slipped key is refused rather than billed. */
export const FEE_MAX = 100_000_000;
