/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single source of truth for every balance the application shows.
 *
 * Before this module existed, Dashboard, FinanceHub, NotificationsTab and the
 * sidebar badge each computed "outstanding" differently (some scoped to the
 * current month, some to all time, some filtering by currency, some not), so the
 * same unit could read "Settled" on one screen and "Delinquent" on another.
 * Every screen now calls these functions.
 *
 * The model is a plain two-sided ledger:
 *     balance = (open charges) - (completed payments)
 * evaluated per unit, per category, per currency. Unpaid months therefore carry
 * forward automatically. Nothing is ever netted across currencies.
 */

import {
  Charge,
  ChargeCategory,
  Currency,
  Payment,
  PaymentCategory,
  Tenancy,
  Unit,
  UtilityReading,
  Expense,
  Booking
} from '../types';
import { round2, sumMoney, subtractMoney } from './money';
import { currentMonth, daysSince, daysSinceOn, isWithin, monthOf, monthsBetween, addDays, today } from './dates';

/** A record that points at a unit. */
interface UnitLinked {
  unitId?: string;
  unitNumber?: string;
}

/**
 * Does this record belong to this unit?
 *
 * unitId is the stable key and is authoritative. unitNumber is a display label
 * the staff can edit — matching on it alone is what orphaned Unit 1's records
 * when it was renamed to "A1". The label is only consulted for legacy rows that
 * predate unitId, and only when the label is not claimed by some other unit.
 */
export function belongsToUnit(record: UnitLinked, unit: Unit, allUnits?: Unit[]): boolean {
  if (record.unitId) return record.unitId === unit.id;
  if (!record.unitNumber) return false;
  if (allUnits && allUnits.some(u => u.id !== unit.id && u.number === record.unitNumber)) return false;
  return record.unitNumber === unit.number;
}

export function paymentsForUnit(payments: Payment[], unit: Unit, allUnits?: Unit[]): Payment[] {
  return payments.filter(p => belongsToUnit(p, unit, allUnits));
}

/* ------------------------------------------------------------------ *
 * Refunds
 *
 * A refund is money the property really received and really gave back. The
 * receipt stays valid — see the note on `Payment.refundedAmount` for why that is
 * not the same as voiding one — so every figure derived from completed payments
 * has to net the refund off, or the property goes on appearing to hold money that
 * is back in someone else's hands.
 *
 * These two helpers are the only place that arithmetic is written. Nothing should
 * read `refundedAmount` directly.
 * ------------------------------------------------------------------ */

/** How much of a receipt has been handed back as at a date (default: all time). */
export function refundedAsOf(payment: Payment, asOf?: string): number {
  if (!payment.refundedAmount || !payment.refundedOn) return 0;
  if (asOf && payment.refundedOn > asOf) return 0;
  return round2(payment.refundedAmount);
}

/**
 * What a receipt is actually worth to the property as at a date.
 *
 * The date matters and is not a detail. A refund paid out in August against a
 * July receipt belongs in August: netting it into July would rewrite a month that
 * has already been reported on, and would make last month's collection figure
 * change retrospectively depending on when someone happened to ask.
 */
export function netPaidAsOf(payment: Payment, asOf?: string): number {
  return round2(payment.amount - refundedAsOf(payment, asOf));
}

/* ------------------------------------------------------------------ *
 * Bank reconciliation
 * ------------------------------------------------------------------ */

export interface Reconciliation {
  currency: Currency;
  /** Completed receipts dated in the period. */
  receipts: Payment[];
  matched: Payment[];
  unmatched: Payment[];
  /** What the ledger says was taken in the period. */
  total: number;
  /** The part of it that has been found on a statement. */
  matchedTotal: number;
  /** The part that has not — the figure the whole screen exists to drive to zero. */
  unmatchedTotal: number;
}

/**
 * What the ledger claims for a period, split by whether the bank agrees.
 *
 * Every figure elsewhere in this application is derived from the property's own
 * records, which means they can all agree with each other and still be wrong
 * together — a transfer that was promised and never sent looks identical to one
 * that arrived. This is the only view that compares the ledger against something
 * outside it.
 *
 * Cash is included rather than filtered out. It is tempting to exclude it as
 * "never going to appear on a statement", but cash that was received and never
 * banked is precisely the thing worth being able to see, and hiding it would make
 * the one figure that matters — what is unmatched — quietly incomplete.
 */
export function reconciliation(payments: Payment[], currency: Currency, start: string, end: string): Reconciliation {
  const receipts = payments
    .filter(p => p.status === 'completed' && p.currency === currency && isWithin(p.date, start, end))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.receiptNo || '').localeCompare(b.receiptNo || ''));

  const matched = receipts.filter(p => !!p.reconciledOn);
  const unmatched = receipts.filter(p => !p.reconciledOn);

  // Gross, not net of refunds: a refund is its own movement out of the account
  // and appears on the statement as a separate line. Netting it here would ask
  // the person ticking to find a deposit that never had that value.
  const sum = (rows: Payment[]) => sumMoney(rows.map(p => p.amount));

  return {
    currency,
    receipts,
    matched,
    unmatched,
    total: sum(receipts),
    matchedTotal: sum(matched),
    unmatchedTotal: sum(unmatched)
  };
}

export function chargesForUnit(charges: Charge[], unit: Unit, allUnits?: Unit[]): Charge[] {
  return charges.filter(c => belongsToUnit(c, unit, allUnits));
}

export function utilitiesForUnit(utilities: UtilityReading[], unit: Unit, allUnits?: Unit[]): UtilityReading[] {
  return utilities.filter(u => belongsToUnit(u, unit, allUnits));
}

export function expensesForUnit(expenses: Expense[], unit: Unit, allUnits?: Unit[]): Expense[] {
  return expenses.filter(e => belongsToUnit(e, unit, allUnits));
}

export function bookingsForUnit(bookings: Booking[], unit: Unit, allUnits?: Unit[]): Booking[] {
  return bookings.filter(b => belongsToUnit(b, unit, allUnits));
}

/** The currency a unit is billed in for a given category. */
export function chargeCurrency(unit: Unit, category: ChargeCategory): Currency {
  return category === 'Maintenance' ? (unit.maintCurrency || unit.currency) : unit.currency;
}

/** The recurring amount a unit is billed for a given category. */
export function chargeAmount(unit: Unit, category: ChargeCategory): number {
  return round2(category === 'Maintenance' ? unit.monthlyMaintenance : unit.monthlyRent);
}

/** Who is billed: the tenant pays rent, the owner pays HOA maintenance. */
export function chargePayer(unit: Unit, category: ChargeCategory): string {
  if (category === 'Maintenance') return unit.ownerName || '';
  return unit.tenantName || unit.ownerName || '';
}

/** Is this unit billable for this category at all? */
export function isBillable(unit: Unit, category: ChargeCategory): boolean {
  if (category === 'Rent') {
    return unit.status === 'long-term' && chargeAmount(unit, 'Rent') > 0;
  }
  return unit.status !== 'unavailable' && chargeAmount(unit, 'Maintenance') > 0;
}

/**
 * What an account is actually doing, as one value the whole application agrees on.
 *
 * `balance <= 0` used to be rendered as "Settled" everywhere, which quietly told
 * staff that money was collected when in fact **nothing had ever been billed**.
 * Setting a rent figure on a unit does not create a debt — a debt exists only once
 * the month is posted — so a freshly configured villa read as a green, settled
 * account with a tick beside it. In a system whose whole job is knowing who owes
 * what, that is the most dangerous thing it could say. The two cases are separated
 * here, at the single source of truth, rather than in each screen.
 */
export type AccountStatus =
  /** Billed and fully paid. Genuinely settled. */
  | 'settled'
  /** Configured to be billed, but no charge has been raised yet. Nothing is owed *yet*. */
  | 'not-billed'
  /** Owes money. */
  | 'in-arrears'
  /** Paid more than was billed. */
  | 'credit'
  /** Not billed for this category at all (vacant, unavailable, or no amount set). */
  | 'inactive';

export interface AccountBalance {
  unit: Unit;
  category: ChargeCategory;
  currency: Currency;
  /** Whether this unit is configured to be billed for this category at all. */
  billable: boolean;
  /** The single label every screen should render from. Never derive this locally. */
  status: AccountStatus;
  /** Open charges raised on or before `asOf`. */
  charged: number;
  /** Completed payments received on or before `asOf`, in the billing currency. */
  paid: number;
  /** charged - paid. Positive means the account owes money; negative is a credit. */
  balance: number;
  /** Charges the payments have not covered yet, oldest first. */
  unpaidCharges: Charge[];
  /** Age in days of the oldest charge still not covered. 0 when nothing is due. */
  oldestUnpaidDays: number;
  /**
   * Completed payments recorded against this account in the *other* currency.
   * These are deliberately not netted into the balance — they are surfaced so
   * staff can correct the record rather than have the money silently vanish.
   */
  mismatchedCurrencyPayments: Payment[];
}

/**
 * Running balance for one unit and one category, as at a given date (default: no limit).
 */
export function accountBalance(
  unit: Unit,
  category: ChargeCategory,
  charges: Charge[],
  payments: Payment[],
  asOf?: string,
  allUnits?: Unit[]
): AccountBalance {
  const currency = chargeCurrency(unit, category);

  const unitCharges = chargesForUnit(charges, unit, allUnits)
    .filter(c => c.category === category && c.status === 'open' && c.currency === currency)
    .filter(c => !asOf || c.dueDate <= asOf)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const unitPayments = paymentsForUnit(payments, unit, allUnits)
    .filter(p => p.category === category && p.status === 'completed')
    .filter(p => !asOf || p.date <= asOf);

  const matching = unitPayments.filter(p => p.currency === currency);
  const mismatched = unitPayments.filter(p => p.currency !== currency);

  const charged = sumMoney(unitCharges.map(c => c.amount));
  // Net of anything handed back. A refunded rent payment puts the tenant back
  // into arrears, which is the whole point: the property no longer has the money.
  const paid = sumMoney(matching.map(p => netPaidAsOf(p, asOf)));
  const balance = subtractMoney(charged, paid);

  // Apply payments to charges oldest-first to age the debt.
  let credit = paid;
  const unpaidCharges: Charge[] = [];
  for (const charge of unitCharges) {
    if (credit >= charge.amount) {
      credit = round2(credit - charge.amount);
    } else {
      unpaidCharges.push(charge);
      credit = 0;
    }
  }

  const oldestUnpaidDays = unpaidCharges.length > 0 ? Math.max(0, daysSince(unpaidCharges[0].dueDate)) : 0;

  const billable = isBillable(unit, category);
  const status: AccountStatus =
    balance > 0
      ? 'in-arrears'
      : balance < 0
        ? 'credit'
        : charged > 0
          ? 'settled'
          : billable
            ? // Configured to be billed, but the month has never been posted, so no
              // charge exists to owe. Deliberately not "settled".
              'not-billed'
            : 'inactive';

  return {
    unit,
    category,
    currency,
    billable,
    status,
    charged,
    paid,
    balance,
    unpaidCharges,
    oldestUnpaidDays,
    mismatchedCurrencyPayments: mismatched
  };
}

/** Human label for an account status, so every screen words it identically. */
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  settled: 'Settled',
  'not-billed': 'Not yet billed',
  'in-arrears': 'In arrears',
  credit: 'In credit',
  inactive: 'Not billed'
};

/**
 * Accounts that are configured to be billed but have no charge raised yet.
 *
 * These are invisible to `delinquentAccounts` (they owe nothing, because nothing
 * was billed) yet they are exactly the accounts that need attention — the rent is
 * set up and simply is not being collected. Surfaced so the dashboard can say so.
 */
export function unbilledAccounts(units: Unit[], charges: Charge[], payments: Payment[], asOf?: string): AccountBalance[] {
  const out: AccountBalance[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const account = accountBalance(unit, category, charges, payments, asOf, units);
      if (account.status === 'not-billed') out.push(account);
    }
  }
  return out;
}

export interface PeriodStatement {
  unit: Unit;
  category: ChargeCategory;
  currency: Currency;
  start: string;
  end: string;
  /** Balance carried in from before `start`. */
  opening: number;
  chargesInPeriod: Charge[];
  paymentsInPeriod: Payment[];
  charged: number;
  paid: number;
  /** opening + charged - paid */
  closing: number;
}

/**
 * Opening balance, activity and closing balance for a date range.
 * This is what makes the statements reconcilable for accounting.
 */
export function periodStatement(
  unit: Unit,
  category: ChargeCategory,
  charges: Charge[],
  payments: Payment[],
  start: string,
  end: string,
  allUnits?: Unit[]
): PeriodStatement {
  const currency = chargeCurrency(unit, category);
  const opening = accountBalance(unit, category, charges, payments, addDays(start, -1), allUnits).balance;

  const chargesInPeriod = chargesForUnit(charges, unit, allUnits)
    .filter(c => c.category === category && c.status === 'open' && c.currency === currency)
    .filter(c => isWithin(c.dueDate, start, end))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const paymentsInPeriod = paymentsForUnit(payments, unit, allUnits)
    .filter(p => p.category === category && p.status === 'completed' && p.currency === currency)
    .filter(p => isWithin(p.date, start, end))
    .sort((a, b) => a.date.localeCompare(b.date));

  const charged = sumMoney(chargesInPeriod.map(c => c.amount));
  const paid = sumMoney(paymentsInPeriod.map(p => p.amount));

  return {
    unit,
    category,
    currency,
    start,
    end,
    opening,
    chargesInPeriod,
    paymentsInPeriod,
    charged,
    paid,
    closing: round2(opening + charged - paid)
  };
}

/** Every account (unit x category) that currently owes money, worst first. */
export function delinquentAccounts(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  asOf?: string
): AccountBalance[] {
  const accounts: AccountBalance[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const account = accountBalance(unit, category, charges, payments, asOf, units);
      if (account.balance > 0) accounts.push(account);
    }
  }
  return accounts.sort((a, b) => b.oldestUnpaidDays - a.oldestUnpaidDays || b.balance - a.balance);
}

/** Every account holding a credit (paid more than billed). */
export function creditAccounts(units: Unit[], charges: Charge[], payments: Payment[], asOf?: string): AccountBalance[] {
  const accounts: AccountBalance[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const account = accountBalance(unit, category, charges, payments, asOf, units);
      if (account.balance < 0) accounts.push(account);
    }
  }
  return accounts;
}

/** Accounts whose payments were recorded in the wrong currency — a data-integrity warning. */
export function currencyMismatchWarnings(units: Unit[], charges: Charge[], payments: Payment[]): AccountBalance[] {
  const out: AccountBalance[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const account = accountBalance(unit, category, charges, payments, undefined, units);
      if (account.mismatchedCurrencyPayments.length > 0) out.push(account);
    }
  }
  return out;
}

export interface CurrencyTotals {
  rent: number;
  maintenance: number;
  booking: number;
  utility: number;
  other: number;
  total: number;
}

const EMPTY_TOTALS: CurrencyTotals = { rent: 0, maintenance: 0, booking: 0, utility: 0, other: 0, total: 0 };

/**
 * Cash actually received in one currency over a date range, split by category.
 * `excludeUnitIds` drops owner-billed utility recoveries from operating revenue.
 */
export function collectedInPeriod(
  payments: Payment[],
  currency: Currency,
  start: string,
  end: string,
  excludeUtilityUnitIds: Set<string> = new Set()
): CurrencyTotals {
  const completed = payments.filter(p => p.status === 'completed' && p.currency === currency);
  const rows = completed.filter(p => isWithin(p.date, start, end));

  /**
   * Refunds paid out during this period, whatever period the receipt itself was
   * in. They are a separate filter rather than a netting of `rows` on purpose: a
   * refund is cash leaving the building on the day it leaves, and a July receipt
   * refunded in August must reduce August. Netting it into July would silently
   * restate a month that has already been reported.
   */
  const refunds = completed.filter(p => p.refundedOn && isWithin(p.refundedOn, start, end));

  const pick = (category: string) =>
    subtractMoney(
      sumMoney(rows.filter(p => p.category === category).map(p => p.amount)),
      sumMoney(refunds.filter(p => p.category === category).map(p => refundedAsOf(p)))
    );

  const totals: CurrencyTotals = {
    ...EMPTY_TOTALS,
    rent: pick('Rent'),
    maintenance: pick('Maintenance'),
    booking: pick('Booking'),
    utility: subtractMoney(
      sumMoney(rows.filter(p => p.category === 'Utility' && !excludeUtilityUnitIds.has(p.unitId)).map(p => p.amount)),
      sumMoney(refunds.filter(p => p.category === 'Utility' && !excludeUtilityUnitIds.has(p.unitId)).map(p => refundedAsOf(p)))
    ),
    other: pick('Other')
  };
  totals.total = sumMoney([totals.rent, totals.maintenance, totals.booking, totals.utility, totals.other]);
  return totals;
}

/** Charges raised in one currency over a date range, split by category. */
export function chargedInPeriod(charges: Charge[], currency: Currency, start: string, end: string) {
  const rows = charges.filter(c => c.status === 'open' && c.currency === currency && isWithin(c.dueDate, start, end));
  const rent = sumMoney(rows.filter(c => c.category === 'Rent').map(c => c.amount));
  const maintenance = sumMoney(rows.filter(c => c.category === 'Maintenance').map(c => c.amount));
  return { rent, maintenance, total: sumMoney([rent, maintenance]) };
}

/** Expenses paid in one currency over a date range. */
export function expensesInPeriod(expenses: Expense[], currency: Currency, start: string, end: string): number {
  return sumMoney(
    expenses
      .filter(e => e.status === 'paid' && e.currency === currency)
      .filter(e => isWithin(e.datePaid || e.date, start, end))
      .map(e => e.amount)
  );
}

/**
 * Expenses in one currency over a date range, grouped by category, with both what
 * was paid and what is still outstanding (pending). Pending expenses are dated by
 * their due date, so a bill due in the period counts even before it is paid.
 */
export function expenseBreakdown(
  expenses: Expense[],
  currency: Currency,
  start: string,
  end: string
): { category: string; amount: number; outstanding: number; share: number }[] {
  const paid = expenses
    .filter(e => e.status === 'paid' && e.currency === currency)
    .filter(e => isWithin(e.datePaid || e.date, start, end));
  const pending = expenses
    .filter(e => e.status === 'pending' && e.currency === currency)
    .filter(e => isWithin(e.dueDate || e.date, start, end));

  const total = sumMoney(paid.map(e => e.amount));
  const byCategory = new Map<string, { amount: number; outstanding: number }>();
  const bump = (cat: string, key: 'amount' | 'outstanding', v: number) => {
    const cur = byCategory.get(cat) || { amount: 0, outstanding: 0 };
    cur[key] = sumMoney([cur[key], v]);
    byCategory.set(cat, cur);
  };
  for (const e of paid) bump(e.category, 'amount', e.amount);
  for (const e of pending) bump(e.category, 'outstanding', e.amount);

  return Array.from(byCategory.entries())
    .map(([category, v]) => ({
      category,
      amount: v.amount,
      outstanding: v.outstanding,
      share: total > 0 ? round2((v.amount / total) * 100) : 0
    }))
    .sort((a, b) => b.amount + b.outstanding - (a.amount + a.outstanding));
}

/**
 * Owner-billed units. Utilities for these are recovered directly from the owner
 * and are excluded from property operating revenue.
 */
export function ownerBilledUnitIds(units: Unit[]): Set<string> {
  return new Set(units.filter(u => u.status === 'owner-occupied' || u.status === 'short-term').map(u => u.id));
}

/** Collection rate for a period: what share of billed money actually came in. */
export function collectionRate(charged: number, collected: number): number | null {
  if (charged <= 0) return null;
  return round2((collected / charged) * 100);
}

/** Whether the unit is occupied for occupancy-rate purposes. */
export function isOccupied(unit: Unit): boolean {
  return unit.status === 'long-term' || unit.status === 'short-term' || unit.status === 'owner-occupied';
}

/**
 * A booking blocks a night if the night falls in [checkIn, checkOut).
 * The departure day is free: the same-day turnover is a real operational case and
 * the availability engine has always allowed it, so the calendar must agree.
 */
export function bookingCoversNight(booking: Booking, day: string): boolean {
  if (booking.status === 'cancelled') return false;
  return day >= booking.checkIn && day < booking.checkOut;
}

/** Two stays clash when their night ranges overlap. Touching ranges do not clash. */
export function bookingsOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && aOut > bIn;
}

export interface BookingClash {
  unitId: string;
  unitNumber: string;
  a: Booking;
  b: Booking;
}

/**
 * Every pair of live reservations that share nights on the same unit. The create
 * and edit forms prevent these, so this is a safety net for imports, restores, or
 * edits made on another device.
 */
export function bookingOverlaps(bookings: Booking[]): BookingClash[] {
  const active = bookings.filter(b => b.status !== 'cancelled');
  const byUnit = new Map<string, Booking[]>();
  for (const b of active) {
    if (!byUnit.has(b.unitId)) byUnit.set(b.unitId, []);
    byUnit.get(b.unitId)!.push(b);
  }
  const clashes: BookingClash[] = [];
  for (const list of byUnit.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (bookingsOverlap(list[i].checkIn, list[i].checkOut, list[j].checkIn, list[j].checkOut)) {
          clashes.push({ unitId: list[i].unitId, unitNumber: list[i].unitNumber, a: list[i], b: list[j] });
        }
      }
    }
  }
  return clashes;
}

export function countBookingOverlaps(bookings: Booking[]): number {
  return bookingOverlaps(bookings).length;
}

/** Live occupancy of a unit today, derived from bookings rather than stored twice. */
export function liveUnitState(
  unit: Unit,
  bookings: Booking[],
  day: string,
  allUnits?: Unit[]
): { label: string; booking?: Booking } {
  const active = bookingsForUnit(bookings, unit, allUnits).find(
    b => b.status !== 'cancelled' && bookingCoversNight(b, day)
  );
  if (active) {
    if (active.source === 'Blocked' || active.source === 'Unavailable') {
      return { label: 'Temporarily held', booking: active };
    }
    return { label: 'Short-term occupied', booking: active };
  }
  switch (unit.status) {
    case 'long-term':
      return { label: unit.tenantName ? 'Long-term occupied' : 'Vacant' };
    case 'short-term':
      return { label: 'Available for short stays' };
    case 'owner-occupied':
      return { label: 'Owner occupied' };
    case 'vacant':
      return { label: 'Vacant' };
    default:
      return { label: 'Unavailable' };
  }
}

/** Group a list of charges/payments by month for chart series. */
export function groupByMonth<T>(rows: T[], dateOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = monthOf(dateOf(row));
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return map;
}

/**
 * Months a tenant has occupied that have never been billed.
 *
 * Move-in raises the first month and the advance. Every month after that is
 * raised by posting it — and posting is deliberate, so a tenant recorded late,
 * or a month nobody got to, leaves rent that is genuinely owed and completely
 * invisible: the account looks settled because nothing was ever charged for it.
 *
 * This is the case a backdated move-in creates. Someone enters a tenant in
 * September who moved in during July: July is billed at move-in, August is not,
 * and nothing anywhere says so. Surfacing it turns silence into a task.
 *
 * Counts from the move-in month up to the current month, or to the move-out
 * month for a tenancy that has ended.
 */
export interface UnbilledOccupancy {
  unit: Unit;
  tenancy: Tenancy;
  currency: Currency;
  /** YYYY-MM values with no open rent charge against them. */
  months: string[];
  /** What those months would come to at the tenancy's agreed rent. */
  amount: number;
}

export function unbilledOccupancy(
  units: Unit[],
  tenancies: Tenancy[],
  charges: Charge[],
  asOf: string = today()
): UnbilledOccupancy[] {
  const out: UnbilledOccupancy[] = [];
  const thisMonth = monthOf(asOf);

  for (const tenancy of tenancies) {
    if (!tenancy.startedOn) continue;
    const rent = round2(tenancy.monthlyRent);
    if (!(rent > 0)) continue;

    const unit = units.find(u => u.id === tenancy.unitId);
    if (!unit) continue;

    // A closed tenancy stops at its final month; that month is covered by the
    // advance and is deliberately not billed, so it is not "missing".
    const lastMonth = tenancy.status === 'ended' && tenancy.endedOn ? monthOf(tenancy.endedOn) : thisMonth;
    if (lastMonth < monthOf(tenancy.startedOn)) continue;

    const finalMonthCoveredByAdvance = tenancy.status === 'ended' ? lastMonth : null;
    const currency = tenancy.currency || unit.currency;

    const months = monthsBetween(tenancy.startedOn, `${lastMonth}-01`).filter(month => {
      if (month === finalMonthCoveredByAdvance) return false;
      return !charges.some(
        c => c.unitId === unit.id && c.category === 'Rent' && c.periodMonth === month && c.status === 'open'
      );
    });

    if (months.length > 0) {
      out.push({ unit, tenancy, currency, months, amount: round2(rent * months.length) });
    }
  }
  return out.sort((a, b) => b.months.length - a.months.length);
}

/**
 * Leases running out, and leases that already have.
 *
 * A fixed term that lapses unnoticed does not end the tenancy — it rolls the
 * tenant onto statutory month-to-month terms nobody chose, on the old rent, with
 * the notice period that implies. The only way to negotiate a renewal on purpose
 * is to see it coming, so this reports the window before expiry as well as the
 * ones already past.
 *
 * Only open tenancies with a fixed term are considered; a tenancy with no lease
 * end date is month-to-month by intention and is not a problem to solve.
 */
export interface LeaseExpiry {
  unit: Unit;
  tenancy: Tenancy;
  leaseEndsOn: string;
  /** Negative once the term has already run out. */
  daysRemaining: number;
  expired: boolean;
}

export function leasesNeedingAttention(
  units: Unit[],
  tenancies: Tenancy[],
  withinDays = 60,
  asOf: string = today()
): LeaseExpiry[] {
  const out: LeaseExpiry[] = [];
  for (const tenancy of tenancies) {
    if (tenancy.status !== 'active') continue;
    if (!tenancy.leaseEndsOn) continue;
    const unit = units.find(u => u.id === tenancy.unitId);
    if (!unit) continue;

    // Positive while the term still has time to run, negative once it is past.
    const daysRemaining = -daysSinceOn(tenancy.leaseEndsOn, asOf);
    if (daysRemaining > withinDays) continue;
    out.push({ unit, tenancy, leaseEndsOn: tenancy.leaseEndsOn, daysRemaining, expired: daysRemaining < 0 });
  }
  // Most urgent first: the ones already expired, then the soonest to.
  return out.sort((a, b) => a.daysRemaining - b.daysRemaining);
}


/**
 * What a proprietor is owed, and what they owe, for one villa over one period.
 *
 * The corporation's income is HOA maintenance. Rent and short-let booking income
 * belong to the individual proprietor — the agent merely collects it on their
 * behalf — and the costs of their villa are theirs too. An owner statement is the
 * one document that puts those three facts on the same page, and it is the thing
 * an owner actually judges a managing agent by.
 *
 * Computed per currency, never across them, so a villa let in USD with a JMD
 * maintenance fee produces two honest statements rather than one meaningless
 * total.
 */
export interface OwnerStatement {
  unit: Unit;
  currency: Currency;
  from: string;
  to: string;
  /** Long-term rent collected for the owner in the period. */
  rentCollected: number;
  /** Short-let booking income collected for the owner in the period. */
  bookingCollected: number;
  /** Utility recoveries collected against the villa. */
  utilityCollected: number;
  /** Total collected on the owner's behalf, net of anything refunded in the period. */
  collected: number;
  /**
   * Money handed back in the period, already deducted from the figures above.
   *
   * Carried separately so the statement can show the deduction rather than just a
   * smaller number. An owner comparing this month with last will notice the drop
   * and ask; the page should already answer.
   */
  refunded: number;
  /** HOA maintenance billed to the owner for the period. */
  maintenanceBilled: number;
  /**
   * Maintenance contributions actually received in the period.
   *
   * Not part of the arithmetic — the deduction above is what was *billed*, which
   * is what the owner is liable for whether or not they have paid it yet. It is
   * carried so the statement can say so out loud: an owner who settled their
   * maintenance by their own bank transfer, and whose agent then also withheld it
   * from their rent, has been charged twice, and nothing else on the page would
   * show that.
   */
  maintenancePaid: number;
  /** Property expenses charged to this villa in the period. */
  expenses: number;
  /** collected − maintenanceBilled − expenses. Negative means the owner owes. */
  net: number;
  /** Maintenance still outstanding at the end of the period, across all time. */
  maintenanceOutstanding: number;
  /**
   * The records behind every figure above.
   *
   * An owner statement is queried line by line — "what is this expense?" — and a
   * document that can only answer with a total is not one an owner will accept.
   * They are resolved here rather than in the screen so the printed page and the
   * summary can never disagree about what makes up a number.
   */
  collectedItems: Payment[];
  /**
   * Receipts refunded during the period, so the itemised list can show the money
   * going back out as its own line. Without it `collectedItems` would sum to more
   * than `collected`, and an owner checking the arithmetic would be right to.
   */
  refundItems: Payment[];
  maintenanceCharges: Charge[];
  expenseItems: Expense[];
  /** Whether anything at all happened, so empty villas can be dropped. */
  active: boolean;
}

export function ownerStatement(
  unit: Unit,
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  currency: Currency,
  from: string,
  to: string
): OwnerStatement {
  const inPeriod = <T,>(rows: T[], dateOf: (row: T) => string) => rows.filter(r => isWithin(dateOf(r), from, to));

  const unitPayments = paymentsForUnit(payments, unit, units).filter(p => p.status === 'completed' && p.currency === currency);
  const paidIn = (category: PaymentCategory) => inPeriod(unitPayments.filter(p => p.category === category), p => p.date);
  const total = (rows: { amount: number }[]) => sumMoney(rows.map(r => r.amount));

  /**
   * Refunds paid out in this period, dated by when the money went back.
   *
   * Deducted from what was collected on the proprietor's behalf, because it was
   * not, in the end, collected on their behalf — the agent gave it back. Leaving
   * it in would pay an owner for money the property no longer has, which is the
   * one error on a statement nobody catches until it is a shortfall.
   */
  const refundItems = unitPayments
    .filter(p => p.refundedOn && isWithin(p.refundedOn, from, to))
    .sort((a, b) => (a.refundedOn || '').localeCompare(b.refundedOn || ''));
  const refundedIn = (category: PaymentCategory) =>
    sumMoney(refundItems.filter(p => p.category === category).map(p => refundedAsOf(p)));

  // Money collected on the proprietor's behalf. Utility recoveries are here
  // because the villa's utility bill is itself charged to the villa below — the
  // recovery offsets that cost rather than being income in its own right, and
  // dropping it would leave the owner carrying a bill somebody else repaid.
  const rentItems = paidIn('Rent');
  const bookingItems = paidIn('Booking');
  const utilityItems = paidIn('Utility');
  const rentCollected = subtractMoney(total(rentItems), refundedIn('Rent'));
  const bookingCollected = subtractMoney(total(bookingItems), refundedIn('Booking'));
  const utilityCollected = subtractMoney(total(utilityItems), refundedIn('Utility'));
  const collected = sumMoney([rentCollected, bookingCollected, utilityCollected]);
  const refunded = sumMoney([refundedIn('Rent'), refundedIn('Booking'), refundedIn('Utility')]);
  const maintenancePaid = subtractMoney(total(paidIn('Maintenance')), refundedIn('Maintenance'));

  const maintenanceCharges = inPeriod(
    chargesForUnit(charges, unit, units).filter(c => c.category === 'Maintenance' && c.status === 'open' && c.currency === currency),
    c => c.dueDate
  ).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const maintenanceBilled = total(maintenanceCharges);

  const expenseItems = inPeriod(
    expensesForUnit(expenses, unit, units).filter(e => e.status === 'paid' && e.currency === currency),
    e => e.datePaid || e.date
  ).sort((a, b) => (a.datePaid || a.date).localeCompare(b.datePaid || b.date));
  const unitExpenses = total(expenseItems);

  // What they still owe the corporation, as at the end of the period — all time,
  // not just this period, because that is the figure an owner needs to see.
  const maintAccount = accountBalance(unit, 'Maintenance', charges, payments, to, units);
  const maintenanceOutstanding = maintAccount.currency === currency ? maintAccount.balance : 0;

  const net = round2(collected - maintenanceBilled - unitExpenses);

  return {
    unit,
    currency,
    from,
    to,
    rentCollected,
    bookingCollected,
    utilityCollected,
    collected,
    refunded,
    maintenanceBilled,
    maintenancePaid,
    expenses: unitExpenses,
    net,
    maintenanceOutstanding,
    collectedItems: [...rentItems, ...bookingItems, ...utilityItems].sort((a, b) => a.date.localeCompare(b.date)),
    refundItems,
    maintenanceCharges,
    expenseItems,
    active:
      collected !== 0 ||
      refunded !== 0 ||
      maintenanceBilled !== 0 ||
      maintenancePaid !== 0 ||
      unitExpenses !== 0 ||
      maintenanceOutstanding !== 0
  };
}

/** Every owner statement worth producing for a period, one per villa per currency. */
export function ownerStatements(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  from: string,
  to: string
): OwnerStatement[] {
  const out: OwnerStatement[] = [];
  for (const unit of units) {
    for (const currency of ['JMD', 'USD'] as Currency[]) {
      const statement = ownerStatement(unit, units, charges, payments, expenses, currency, from, to);
      if (statement.active) out.push(statement);
    }
  }
  return out.sort((a, b) => a.unit.number.localeCompare(b.unit.number, undefined, { numeric: true }) || a.currency.localeCompare(b.currency));
}

/**
 * The statements one proprietor receives, gathered under their name.
 *
 * A statement is per villa and per currency, but the person it is sent to is
 * neither — an owner of two villas is owed one document, not two envelopes that
 * each tell half the story. Villas whose owner is not recorded are grouped under
 * a blank name rather than dropped, because an unnamed owner is a record to fix,
 * not money to lose.
 */
export interface OwnerStatementGroup {
  owner: string;
  statements: OwnerStatement[];
  /** Net position per currency across every villa in the group. */
  netByCurrency: { currency: Currency; net: number }[];
}

export function groupStatementsByOwner(statements: OwnerStatement[]): OwnerStatementGroup[] {
  const byOwner = new Map<string, OwnerStatement[]>();
  for (const statement of statements) {
    const owner = statement.unit.ownerName || '';
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner)!.push(statement);
  }

  return Array.from(byOwner.entries())
    .map(([owner, rows]) => ({
      owner,
      statements: rows,
      netByCurrency: (['JMD', 'USD'] as Currency[])
        .map(currency => ({
          currency,
          net: sumMoney(rows.filter(r => r.currency === currency).map(r => r.net))
        }))
        .filter(row => rows.some(r => r.currency === row.currency))
    }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}
