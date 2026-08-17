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
  ExpenseCategory,
  Booking
} from '../types';
import { round2, sumMoney, subtractMoney } from './money';
import { currentMonth, daysSince, daysSinceOn, isWithin, monthEnd, monthStart, monthOf, monthsBetween, addDays, today } from './dates';

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
  /** Receipts refunded during the period. Already deducted from `paid`. */
  refundsInPeriod: Payment[];
  charged: number;
  /** Received in the period, net of anything refunded back out in it. */
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

  /**
   * Refunds paid out during the period, whichever period their receipt was in.
   *
   * `opening` comes from `accountBalance`, which nets refunds off. Summing `paid`
   * gross here would have made `closing` disagree with the very balance every
   * screen shows — the exact "screens disagree with each other" failure this
   * module exists to prevent, and it would have surfaced on a document handed to
   * a tenant.
   */
  const refundsInPeriod = paymentsForUnit(payments, unit, allUnits)
    .filter(p => p.category === category && p.status === 'completed' && p.currency === currency)
    .filter(p => p.refundedOn && isWithin(p.refundedOn, start, end))
    .sort((a, b) => (a.refundedOn || '').localeCompare(b.refundedOn || ''));

  const charged = sumMoney(chargesInPeriod.map(c => c.amount));
  const paid = subtractMoney(
    sumMoney(paymentsInPeriod.map(p => p.amount)),
    sumMoney(refundsInPeriod.map(p => refundedAsOf(p)))
  );

  return {
    unit,
    category,
    currency,
    start,
    end,
    opening,
    chargesInPeriod,
    paymentsInPeriod,
    refundsInPeriod,
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
 * Villas occupied on a given day, reconstructed from the dated records.
 *
 * `isOccupied` reads `unit.status`, which is a *current* flag with no history —
 * asking it about last March returns today's answer. Only tenancies and bookings
 * carry date ranges, so an honest historical series can only be built from those:
 * a villa counts as occupied on a day when a tenancy covers it or a guest is in
 * residence that night.
 *
 * The consequence, which every caller must state rather than paper over: an
 * owner-occupied villa files neither a tenancy nor a booking, so it is *not*
 * counted here. This measures villas rented out, not villas physically occupied,
 * differ by exactly the owner-occupied lots.
 */
export function occupiedUnitIdsOn(units: Unit[], tenancies: Tenancy[], bookings: Booking[], day: string): Set<string> {
  const out = new Set<string>();

  for (const tenancy of tenancies) {
    // Dates, never `status` — an ended tenancy still occupied its villa back then.
    if (tenancy.startedOn > day) continue;
    if (tenancy.endedOn && day >= tenancy.endedOn) continue;
    out.add(tenancy.unitId);
  }

  for (const booking of bookings) {
    // Blocked and Unavailable are calendar holds, not guests in residence. Matches
    // the nights-sold definition the operating statement reports.
    if (booking.source === 'Blocked' || booking.source === 'Unavailable') continue;
    if (!bookingCoversNight(booking, day)) continue;
    out.add(booking.unitId);
  }

  // Only villas still on the register count towards the rate.
  const known = new Set(units.map(u => u.id));
  for (const id of [...out]) if (!known.has(id)) out.delete(id);
  return out;
}

/**
 * Villas rented out, at the end of each month in the range.
 *
 * Sampled on the last day of the month rather than averaged across it: a single
 * consistent sample point is a figure someone can verify against the register by
 * hand, which a blended average is not.
 */
export function occupancySeries(
  units: Unit[],
  tenancies: Tenancy[],
  bookings: Booking[],
  months: string[],
  asOfCap?: string
): { month: string; occupied: number; total: number; rate: number | null }[] {
  return months.map(month => {
    const raw = monthEnd(month);
    // Never sample past the report date — a future month would read as empty.
    const day = asOfCap && raw > asOfCap ? asOfCap : raw;
    const occupied = occupiedUnitIdsOn(units, tenancies, bookings, day).size;
    const total = units.length;
    return { month, occupied, total, rate: total > 0 ? round2((occupied / total) * 100) : null };
  });
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
  asOf: string = today(),
  /**
   * The migration cutover, when there is one. Months before it were billed in
   * whatever system came before, so the absence of a charge here is a fact about
   * this application's history rather than an unbilled month. Without it, a
   * tenancy carrying its real start date reports every month back to that date
   * as missing — hundreds of false alerts on the first day of use.
   */
  booksBeginOn?: string
): UnbilledOccupancy[] {
  const out: UnbilledOccupancy[] = [];
  const thisMonth = monthOf(asOf);
  const firstBilledMonth = booksBeginOn ? monthOf(booksBeginOn) : null;

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
      // Before the cutover this application was not keeping the books, so it has
      // no standing to call a month unbilled.
      if (firstBilledMonth && month < firstBilledMonth) return false;
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
  /**
   * Metered utilities billed to this villa in the period, paid or not.
   *
   * These were previously invisible here. A reading raised against a villa is an
   * amount that villa owes, but only the *settlement* of one reached the
   * statement — as a receipt on the collected side — so an owner billed for
   * consumption and yet to pay saw no charge at all, while an owner who had paid
   * saw a credit for a bill that appeared nowhere. Billed and paid now both
   * appear, and net to nothing once settled.
   */
  utilityBilled: number;
  /** Property expenses charged to this villa in the period. */
  expenses: number;
  /** collected − maintenanceBilled − utilityBilled − expenses. Negative means the owner owes. */
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
  /** The meter readings behind `utilityBilled`, so the charge can be itemised. */
  utilityCharges: UtilityReading[];
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
  utilities: UtilityReading[],
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

  /*
   * Metered utilities billed to the villa, dated by the month they were read for.
   *
   * Included whether or not they have been settled, on the same principle as
   * maintenance: the charge is what the owner is liable for, and the receipt is
   * shown separately. A settled reading therefore appears twice on the page —
   * once as the charge and once as the payment — and nets to nothing, which is
   * the arithmetic an owner can actually follow.
   */
  const utilityCharges = inPeriod(
    utilitiesForUnit(utilities, unit, units).filter(u => u.currency === currency && u.amountCharged > 0),
    u => monthEnd(u.billingPeriod)
  ).sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod));
  const utilityBilled = sumMoney(utilityCharges.map(u => u.amountCharged));

  /*
   * Costs recharged to the villa — with the supplier's utility invoice excluded.
   *
   * A metered villa produces two records for one supply: the invoice the
   * corporation pays (an Expense, category Utilities, tied to the villa) and the
   * reading it bills the owner from (a UtilityReading). They are the two sides
   * of the same electricity, not two costs, and putting both on the owner's
   * statement charges them twice for it — which then flows into the net, the
   * arrears and every figure drawn from them.
   *
   * The reading is what the owner is actually liable for, so that is the one
   * that bills them. The supplier invoice stays where it belongs: a cost of the
   * corporation, recovered by the reading rather than restated on top of it.
   * `ownerBilledUnitIds` already keeps that recovery out of corporation income
   * for exactly this reason.
   *
   * Anything else charged to the villa — a plumber, a locksmith — has no second
   * record anywhere and is unaffected.
   */
  const expenseItems = inPeriod(
    expensesForUnit(expenses, unit, units).filter(
      e => e.status === 'paid' && e.currency === currency && e.category !== 'Utilities'
    ),
    e => e.datePaid || e.date
  ).sort((a, b) => (a.datePaid || a.date).localeCompare(b.datePaid || b.date));
  const unitExpenses = total(expenseItems);

  // What they still owe the corporation, as at the end of the period — all time,
  // not just this period, because that is the figure an owner needs to see.
  const maintAccount = accountBalance(unit, 'Maintenance', charges, payments, to, units);
  const maintenanceOutstanding = maintAccount.currency === currency ? maintAccount.balance : 0;

  const net = round2(collected - maintenanceBilled - utilityBilled - unitExpenses);

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
    utilityBilled,
    expenses: unitExpenses,
    net,
    maintenanceOutstanding,
    collectedItems: [...rentItems, ...bookingItems, ...utilityItems].sort((a, b) => a.date.localeCompare(b.date)),
    refundItems,
    maintenanceCharges,
    utilityCharges,
    expenseItems,
    active:
      collected !== 0 ||
      refunded !== 0 ||
      maintenanceBilled !== 0 ||
      maintenancePaid !== 0 ||
      utilityBilled !== 0 ||
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
  utilities: UtilityReading[],
  from: string,
  to: string
): OwnerStatement[] {
  const out: OwnerStatement[] = [];
  for (const unit of units) {
    for (const currency of ['JMD', 'USD'] as Currency[]) {
      const statement = ownerStatement(unit, units, charges, payments, expenses, utilities, currency, from, to);
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

/* ------------------------------------------------------------------ *
 * Unit entitlement
 *
 * Contributions must be levied on proprietors in proportion to their unit
 * entitlement — the share attaching to each lot on the registered strata plan.
 * The register stores the levy actually billed (`monthlyMaintenance`) separately
 * from the entitlement it should follow, so a levy that has drifted can be seen
 * instead of being quietly overwritten by a calculation. Deciding what to do
 * about a drift is the executive committee's job, not this function's.
 *
 * See STRATA_COMPLIANCE.md.
 * ------------------------------------------------------------------ */

/** Lots with an entitlement recorded. A lot without one is excluded, never treated as zero. */
export function entitledUnits(units: Unit[]): Unit[] {
  return units.filter(u => typeof u.entitlement === 'number' && u.entitlement > 0);
}

/** Aggregate entitlement across every lot that has one recorded. */
export function totalEntitlement(units: Unit[]): number {
  return round2(sumMoney(entitledUnits(units).map(u => u.entitlement as number)));
}

/**
 * This lot's proportion of the aggregate entitlement, 0–1.
 *
 * Null when the lot has no entitlement recorded, or nothing does — the caller
 * must say "not recorded" rather than render a misleading zero.
 */
export function entitlementShare(unit: Unit, units: Unit[]): number | null {
  const total = totalEntitlement(units);
  if (!total || typeof unit.entitlement !== 'number' || unit.entitlement <= 0) return null;
  return unit.entitlement / total;
}

export interface LevyProportion {
  unit: Unit;
  currency: Currency;
  entitlement: number;
  /** Share of the aggregate entitlement among lots billed in this currency, 0–1. */
  share: number;
  /** What is billed today. */
  levied: number;
  /** What this lot would carry if the same total were struck strictly by entitlement. */
  proportionate: number;
  /** levied − proportionate. Positive means this lot is carrying more than its share. */
  variance: number;
  /** Variance as a proportion of the proportionate figure, 0–1. */
  variancePct: number;
}

/**
 * Compare each lot's levy against what its entitlement implies.
 *
 * Grouped by billing currency and never across it: a villa billed for maintenance
 * in USD sits in a different pool from one billed in JMD, and adding them would
 * produce a shortfall that does not exist. The same rule as everywhere else here.
 *
 * The total being redistributed is the total *currently levied* in that currency,
 * so this answers "is the existing levy shared out correctly?" — not "is the levy
 * big enough?", which is a budget question and needs a budget to answer.
 */
export function levyProportionality(units: Unit[]): LevyProportion[] {
  const withEntitlement = entitledUnits(units).filter(u => u.monthlyMaintenance > 0 || u.entitlement);
  const byCurrency = new Map<Currency, Unit[]>();
  for (const unit of withEntitlement) {
    const currency = chargeCurrency(unit, 'Maintenance');
    byCurrency.set(currency, [...(byCurrency.get(currency) || []), unit]);
  }

  const out: LevyProportion[] = [];
  for (const [currency, group] of byCurrency) {
    const poolEntitlement = sumMoney(group.map(u => u.entitlement as number));
    const poolLevied = sumMoney(group.map(u => u.monthlyMaintenance || 0));
    if (poolEntitlement <= 0) continue;
    for (const unit of group) {
      const entitlement = unit.entitlement as number;
      const share = entitlement / poolEntitlement;
      const proportionate = round2(poolLevied * share);
      const levied = round2(unit.monthlyMaintenance || 0);
      const variance = round2(levied - proportionate);
      out.push({
        unit,
        currency,
        entitlement,
        share,
        levied,
        proportionate,
        variance,
        variancePct: proportionate > 0 ? Math.abs(variance) / proportionate : 0
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
}

/**
 * Lots whose levy is out of step with their entitlement by more than a tolerance.
 *
 * A tolerance exists because levies are rounded to sensible money — a few dollars
 * either way is rounding, not unfairness. The default of 1% flags a real
 * discrepancy without crying about the cents.
 */
export function disproportionateLevies(units: Unit[], tolerance = 0.01): LevyProportion[] {
  return levyProportionality(units).filter(row => row.variancePct > tolerance);
}

/* ------------------------------------------------------------------ *
 * The annual return to the Commission of Strata Corporations
 *
 * Forms 13B and 13C, made under Regulation 11D(c) and filed pursuant to
 * section 4(7)(a) of the Registration (Strata Titles) (Amendment) Act. Both are
 * ageing schedules over data the system already holds — 13B ages what
 * proprietors owe the corporation, 13C ages what the corporation owes third
 * parties. See STRATA_COMPLIANCE.md and the forms themselves.
 *
 * The buckets are the form's own: 30 / 60 / 90 / 90-and-over.
 * ------------------------------------------------------------------ */

/** The four columns on Forms 13B and 13C, in the order they are printed. */
export interface AgeingBuckets {
  /** Up to 30 days overdue. Anything not yet due sits here too — it is outstanding, not late. */
  d30: number;
  /** 31–60 days. */
  d60: number;
  /** 61–90 days. */
  d90: number;
  /** More than 90 days. The column the Commission actually reads. */
  over90: number;
  total: number;
}

const emptyBuckets = (): AgeingBuckets => ({ d30: 0, d60: 0, d90: 0, over90: 0, total: 0 });

/** Which column an amount this many days overdue belongs in. */
function bucketFor(daysOverdue: number): keyof Omit<AgeingBuckets, 'total'> {
  if (daysOverdue <= 30) return 'd30';
  if (daysOverdue <= 60) return 'd60';
  if (daysOverdue <= 90) return 'd90';
  return 'over90';
}

function addToBucket(buckets: AgeingBuckets, daysOverdue: number, amount: number) {
  if (amount <= 0) return;
  const key = bucketFor(daysOverdue);
  buckets[key] = round2(buckets[key] + amount);
  buckets.total = round2(buckets.total + amount);
}

/**
 * Age one account's outstanding balance into the four buckets.
 *
 * Extracted so the statutory return (Form 13B) and the management ageing chart
 * bucket debt by one implementation rather than two. The rule they share is the
 * one that makes the buckets total the balance: payments are re-applied
 * oldest-first and **only the uncovered remainder of a part-paid charge is
 * aged**. `accountBalance` lists a partly covered charge in `unpaidCharges` in
 * full — correct for showing which months are open, wrong for ageing, because
 * summing those reports more owing than the account actually carries.
 *
 * Returns zeroed buckets for an account that owes nothing.
 */
export function ageAccountArrears(
  unit: Unit,
  category: ChargeCategory,
  charges: Charge[],
  payments: Payment[],
  asOf: string,
  allUnits?: Unit[]
): { currency: Currency; buckets: AgeingBuckets } {
  const account = accountBalance(unit, category, charges, payments, asOf, allUnits);
  const buckets = emptyBuckets();
  if (account.balance <= 0) return { currency: account.currency, buckets };

  const open = chargesForUnit(charges, unit, allUnits)
    .filter(c => c.category === category && c.status === 'open' && c.currency === account.currency && c.dueDate <= asOf)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  let credit = account.paid;
  for (const charge of open) {
    const covered = Math.min(credit, charge.amount);
    credit = round2(credit - covered);
    const residual = round2(charge.amount - covered);
    if (residual > 0) addToBucket(buckets, daysSinceOn(charge.dueDate, asOf), residual);
  }

  return { currency: account.currency, buckets };
}

/**
 * Total outstanding rent and maintenance, aged, per currency.
 *
 * The management view of the same debt Form 13B files for maintenance alone:
 * both categories, summed across every lot, in the form's own buckets so the
 * chart and the return can be read side by side without reconciling them.
 */
export function arrearsAgeing(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  asOf: string
): { currency: Currency; buckets: AgeingBuckets }[] {
  return (['JMD', 'USD'] as Currency[])
    .map(currency => {
      const totals = emptyBuckets();
      for (const unit of units) {
        for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
          const aged = ageAccountArrears(unit, category, charges, payments, asOf, units);
          if (aged.currency !== currency || aged.buckets.total <= 0) continue;
          totals.d30 = round2(totals.d30 + aged.buckets.d30);
          totals.d60 = round2(totals.d60 + aged.buckets.d60);
          totals.d90 = round2(totals.d90 + aged.buckets.d90);
          totals.over90 = round2(totals.over90 + aged.buckets.over90);
          totals.total = round2(totals.total + aged.buckets.total);
        }
      }
      return { currency, buckets: totals };
    })
    .filter(entry => entry.buckets.total > 0);
}

export interface Form13BRow {
  unit: Unit;
  /** The strata lot number the form asks for, falling back to the villa label. */
  strataLot: string;
  /** True when the lot has no strata lot number recorded and the label was used. */
  lotNumberAssumed: boolean;
  currency: Currency;
  buckets: AgeingBuckets;
}

/**
 * Form 13B — outstanding contributions, aged, by strata lot.
 *
 * Payments are applied oldest charge first, and **only the uncovered remainder of
 * a part-paid charge is aged**. `accountBalance` lists a partly covered charge in
 * `unpaidCharges` in full, which is right for showing which months are open but
 * wrong here: summing those would report more owing than the account's balance,
 * and a return that does not agree with its own balance is worse than no return.
 * The buckets total exactly the outstanding balance.
 *
 * Grouped by currency because everything here is. A lot billed for maintenance in
 * a currency other than the one being filed appears on its own row rather than
 * being converted — no exchange rate belongs in a statutory figure without
 * somebody choosing it.
 */
export function form13BContributions(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  asOf: string
): { rows: Form13BRow[]; totalsByCurrency: { currency: Currency; buckets: AgeingBuckets }[] } {
  const rows: Form13BRow[] = [];

  for (const unit of units) {
    // Shared with the management ageing chart, so the return and the chart can
    // never bucket the same debt differently.
    const { currency, buckets } = ageAccountArrears(unit, 'Maintenance', charges, payments, asOf, units);
    if (buckets.total <= 0) continue;

    rows.push({
      unit,
      strataLot: unit.strataLotNumber || unit.number,
      lotNumberAssumed: !unit.strataLotNumber,
      currency,
      buckets
    });
  }

  rows.sort((a, b) => a.strataLot.localeCompare(b.strataLot, undefined, { numeric: true }));

  const totalsByCurrency = (['JMD', 'USD'] as Currency[])
    .map(currency => {
      const totals = emptyBuckets();
      for (const row of rows.filter(r => r.currency === currency)) {
        totals.d30 = round2(totals.d30 + row.buckets.d30);
        totals.d60 = round2(totals.d60 + row.buckets.d60);
        totals.d90 = round2(totals.d90 + row.buckets.d90);
        totals.over90 = round2(totals.over90 + row.buckets.over90);
        totals.total = round2(totals.total + row.buckets.total);
      }
      return { currency, buckets: totals };
    })
    .filter(entry => entry.buckets.total > 0);

  return { rows, totalsByCurrency };
}

/**
 * The descriptions Form 13C prints, in its order. Anything that does not map to
 * one of these keeps its own category name — the form leaves blank rows for
 * exactly that, and inventing a home for a cost is how a return stops being true.
 */
const FORM_13C_LABELS: Partial<Record<ExpenseCategory, string>> = {
  'Property Taxes': 'Property Tax',
  Utilities: 'Light / Water'
};

export interface Form13CRow {
  description: string;
  currency: Currency;
  buckets: AgeingBuckets;
}

/**
 * Form 13C — outstanding debts, aged, by description.
 *
 * An expense still marked `pending` is money the corporation owes and has not
 * paid, which is precisely what this form asks for. The monthly costs run raises
 * its lines that way deliberately, so a month that has been posted but not yet
 * settled appears here without anyone doing anything.
 *
 * Aged from the due date where there is one, falling back to the date the cost
 * was logged.
 */
export function form13CDebts(expenses: Expense[], asOf: string): { rows: Form13CRow[]; totalsByCurrency: { currency: Currency; buckets: AgeingBuckets }[] } {
  const byKey = new Map<string, Form13CRow>();

  for (const expense of expenses) {
    if (expense.status !== 'pending') continue;
    const owedFrom = expense.dueDate || expense.date;
    if (owedFrom > asOf) continue;

    const description = FORM_13C_LABELS[expense.category] || expense.category;
    const key = `${description}|${expense.currency}`;
    const row = byKey.get(key) || { description, currency: expense.currency, buckets: emptyBuckets() };
    addToBucket(row.buckets, daysSinceOn(owedFrom, asOf), expense.amount);
    byKey.set(key, row);
  }

  const rows = [...byKey.values()].filter(r => r.buckets.total > 0).sort((a, b) => a.description.localeCompare(b.description));

  const totalsByCurrency = (['JMD', 'USD'] as Currency[])
    .map(currency => {
      const totals = emptyBuckets();
      for (const row of rows.filter(r => r.currency === currency)) {
        totals.d30 = round2(totals.d30 + row.buckets.d30);
        totals.d60 = round2(totals.d60 + row.buckets.d60);
        totals.d90 = round2(totals.d90 + row.buckets.d90);
        totals.over90 = round2(totals.over90 + row.buckets.over90);
        totals.total = round2(totals.total + row.buckets.total);
      }
      return { currency, buckets: totals };
    })
    .filter(entry => entry.buckets.total > 0);

  return { rows, totalsByCurrency };
}


/* ------------------------------------------------------------------ *
 * The owners' annual report (AGM)
 *
 * A different document from the Commission's return, and the distinction
 * matters. Forms 13A/13B/13C are a statutory filing keyed by strata lot: what
 * each proprietor owes, aged. This is the report circulated to owners before the
 * annual general meeting, and it is about **how the property is run** — what it
 * costs to operate, what the maintenance contribution raises against that, and
 * what the contribution has to become. Ro, 2026-08-16: it is identical for every
 * owner and carries nothing personal. No unit balances, no arrears by name, no
 * personalisation of any kind. Do not merge owner data into it. The same figures
 * are what goes to the Commission of Strata Corporations.
 *
 * **The vocabulary here is the property's, not an accountant's, and it is worth
 * reading before changing anything.** Ro, 2026-08-16:
 *
 *   - **Maintenance collected** — the contribution, times the number of villas.
 *     $20,000 × 16. It is *assessed* income and is deliberately taken at full
 *     value: a proprietor is obliged by law to pay, so the document does not
 *     discount it for arrears. Arrears are a collection matter and are chased
 *     through Form 13B, not by quietly shrinking the income line here.
 *   - **Billed** — what the property was invoiced. The expenditure it incurred.
 *   - **The gap** between the two is the shortfall, and sizing it is the entire
 *     purpose of the document.
 *
 * There are exactly two levers on that gap, and the report must show both,
 * because the second one is what happens when the meeting says no to the first:
 *
 *   1. **Raise the contribution** to cover the expenditure — `feeToCoverBudget`.
 *   2. **Cut the expenditure** to fit the contribution — `expenditureCeiling`
 *      and `reductionRequired`. Ro's own example: drop the security line.
 * ------------------------------------------------------------------ */

/** One expenditure category across the two years and the year being budgeted. */
export interface AnnualCategoryLine {
  category: string;
  /** Paid in the report year. */
  actual: number;
  /** Paid in the year before it, for the year-over-year column. */
  prior: number;
  /** What the coming year is budgeted at. Defaults to the report year's actual. */
  budget: number;
  /** actual vs prior. Null when there is no prior figure to compare against. */
  priorChangePct: number | null;
  /** budget vs actual. Null when there is no actual to compare against. */
  budgetChangePct: number | null;
  /** Share of the budgeted total — which lines are big enough to be worth cutting. */
  budgetShare: number;
}

/** One month of the report year: what it cost against what the contribution raised. */
export interface AnnualMonthLine {
  month: string;
  /** Expenditure incurred — what the property was billed. */
  expenditure: number;
  /** The contribution for the month: fee × contributing villas. */
  income: number;
  /** Contributions actually received that month. Context only; never the basis. */
  received: number;
  /** Positive means the month cost more than the contribution raised. */
  shortfall: number;
}

export interface AnnualOwnersReport {
  currency: Currency;
  /** The year reported on, and the year budgeted (the one after it). */
  reportYear: number;
  budgetYear: number;
  /** Villas assessed a maintenance contribution in this currency. */
  contributingUnits: number;

  /** Actual operating expenditure in the report year, and the year before. */
  expenditure: number;
  priorExpenditure: number;
  expenditureChangePct: number | null;

  /** The same, per villa. What it actually costs to run a villa. */
  perUnitAnnual: number;
  perUnitMonthly: number;

  /** The contribution per villa per month, as assessed during the report year. */
  feeBilled: number;
  /** What that raised across every contributing villa: fee × villas × 12. */
  contributionsAnnual: number;
  /**
   * feeBilled - perUnitMonthly. Negative is the deficit absorbed on owners'
   * behalf, per villa per month — the headline figure of the whole document.
   */
  monthlyPositionPerUnit: number;
  /** The same across the community for the year. Negative is the shortfall. */
  annualCommunityPosition: number;

  /** Contributions actually received, for context beside the assessed figure. */
  received: number;
  collectionRatePct: number | null;

  /** The budgeted year. */
  budgetExpenditure: number;
  budgetPerUnitAnnual: number;
  budgetPerUnitMonthly: number;
  budgetChangePct: number | null;

  /* --- lever 1: raise the contribution --- */
  /** The contribution that would exactly cover the budgeted expenditure. */
  feeToCoverBudget: number;
  /** The fee being put to the meeting. Defaults to the requirement. */
  proposedFee: number;
  proposedAnnualCommunity: number;
  /** Proposed fee less the requirement. Negative means it still under-collects. */
  reservePerUnitMonthly: number;
  reserveAnnual: number;
  /** Reserve as a share of the proposed contribution. */
  reserveShare: number | null;

  /* --- lever 2: cut the expenditure --- */
  /**
   * What total expenditure would have to fall to for the *current* contribution
   * to cover it. The alternative the meeting has if it declines the increase.
   */
  expenditureCeiling: number;
  /** Budgeted expenditure less that ceiling. Positive is what must come out. */
  reductionRequired: number;
  /**
   * Categories whose budget alone would close the gap if removed entirely,
   * largest first. Not advice — arithmetic, so the meeting can see what scale
   * of cut is actually being discussed.
   */
  cutsThatWouldClose: { category: string; budget: number; closesGap: boolean }[];

  categories: AnnualCategoryLine[];
  months: AnnualMonthLine[];
  /** Months of the report year the current contribution covered, and the ones it did not. */
  monthsCovered: number;
  monthsOver: string[];
}

/**
 * The figures behind the owners' annual report, for one currency.
 *
 * Every number the document states is computed here so the narrative and the
 * arithmetic cannot drift apart — the report circulated in 2026 had to carry a
 * corrections log precisely because percentages were typed beside figures that
 * did not produce them.
 *
 * Rules it inherits from the rest of this module and must keep:
 *   - **Only `status === 'paid'` expenses count as spent.** A pending bill is a
 *     liability, not expenditure. It reaches the Commission through Form 13C.
 *   - **Per currency, never across.** Common-property expenditure is JMD in
 *     practice, but nothing here assumes that.
 *   - **Income is the assessed contribution at full value**, for the reason set
 *     out in the block comment above. `received` is carried beside it as context
 *     and is never the basis of the gap.
 *
 * `budgetByCategory` carries next year's figures keyed by category. Anything
 * absent falls back to the report year's actual, which makes an untouched budget
 * a flat run-rate rather than an empty one.
 */
export function annualOwnersReport(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  currency: Currency,
  reportYear: number,
  options?: { budgetByCategory?: Record<string, number>; proposedFee?: number }
): AnnualOwnersReport {
  const budgetByCategory = options?.budgetByCategory || {};
  const yearStart = `${reportYear}-01-01`;
  const yearEnd = `${reportYear}-12-31`;
  const priorStart = `${reportYear - 1}-01-01`;
  const priorEnd = `${reportYear - 1}-12-31`;

  const expenditure = expensesInPeriod(expenses, currency, yearStart, yearEnd);
  const priorExpenditure = expensesInPeriod(expenses, currency, priorStart, priorEnd);

  // Villas assessed a contribution in this currency. The divisor for every
  // per-unit figure in the document, so it is stated once and reused.
  const contributing = units.filter(u => isBillable(u, 'Maintenance') && chargeCurrency(u, 'Maintenance') === currency);
  const contributingUnits = contributing.length;
  const divisor = Math.max(1, contributingUnits);

  // The contribution as it stands. Averaged across contributing villas rather
  // than assumed equal, because an entitlement-weighted contribution is lawful
  // and a single "the fee" figure must not pretend otherwise.
  const feeBilled = contributingUnits > 0 ? round2(sumMoney(contributing.map(u => chargeAmount(u, 'Maintenance'))) / divisor) : 0;
  const contributionsAnnual = round2(feeBilled * contributingUnits * 12);

  const perUnitAnnual = round2(expenditure / divisor);
  const perUnitMonthly = round2(perUnitAnnual / 12);
  const monthlyPositionPerUnit = round2(feeBilled - perUnitMonthly);
  /**
   * The residual, not the per-villa figure multiplied back up.
   *
   * `perUnitMonthly` is a division rounded twice (to the year, then to the
   * month), so scaling the rounded remainder across sixteen villas and twelve
   * months re-inflates that rounding into real money — the headline "shortfall
   * absorbed" would then disagree with `contributions − expenditure`, which is
   * exactly the subtraction a proprietor does to check it. Same fix, and same
   * reason, as `reserveAnnual` below.
   *
   * Caught by the 400-scenario reporting audit, not by a unit test.
   */
  const annualCommunityPosition = round2(contributionsAnnual - expenditure);

  // Context only. Stated beside the assessed figure so the meeting can see how
  // much of the contribution actually arrived, without it moving the gap.
  const received = collectedInPeriod(payments, currency, yearStart, yearEnd).maintenance;
  const billedCharges = chargedInPeriod(charges, currency, yearStart, yearEnd).maintenance;

  /* --- categories, both years plus the budget --- */
  const actualByCategory = new Map<string, number>();
  const priorByCategory = new Map<string, number>();
  const collect = (into: Map<string, number>, start: string, end: string) => {
    for (const e of expenses) {
      if (e.status !== 'paid' || e.currency !== currency) continue;
      if (!isWithin(e.datePaid || e.date, start, end)) continue;
      into.set(e.category, sumMoney([into.get(e.category) || 0, e.amount]));
    }
  };
  collect(actualByCategory, yearStart, yearEnd);
  collect(priorByCategory, priorStart, priorEnd);

  const names = new Set<string>([...actualByCategory.keys(), ...priorByCategory.keys(), ...Object.keys(budgetByCategory)]);
  const pct = (from: number, to: number): number | null => (from > 0 ? round2(((to - from) / from) * 100) : null);

  const draft = Array.from(names).map(category => {
    const actual = round2(actualByCategory.get(category) || 0);
    const prior = round2(priorByCategory.get(category) || 0);
    // An untouched line budgets at this year's actual: a flat run-rate, never zero.
    const budgeted = budgetByCategory[category];
    const budget = round2(Number.isFinite(budgeted) ? (budgeted as number) : actual);
    return { category, actual, prior, budget };
  });

  const budgetExpenditure = sumMoney(draft.map(l => l.budget));

  const categories: AnnualCategoryLine[] = draft
    .map(l => ({
      ...l,
      priorChangePct: pct(l.prior, l.actual),
      budgetChangePct: pct(l.actual, l.budget),
      budgetShare: budgetExpenditure > 0 ? round2((l.budget / budgetExpenditure) * 100) : 0
    }))
    .sort((a, b) => b.budget - a.budget || a.category.localeCompare(b.category));

  const budgetPerUnitAnnual = round2(budgetExpenditure / divisor);
  const budgetPerUnitMonthly = round2(budgetPerUnitAnnual / 12);

  /* --- lever 1: raise the contribution --- */
  /**
   * Rounded **up** to the cent, and computed in one step rather than from the
   * already-rounded annual figure.
   *
   * "The contribution needed to cover the budget" has to actually cover it. A
   * plain `round2` rounds down half the time, which leaves the community a few
   * dollars short of its own budget and makes the report state a *shortfall*
   * against the very fee it just recommended. Rounding up costs at most a cent
   * per villa and is always the safe direction for a figure a meeting votes on.
   */
  const feeToCoverBudget =
    contributingUnits > 0 ? Math.ceil((budgetExpenditure / contributingUnits / 12) * 100) / 100 : 0;
  // Absent a proposal, the report states the requirement itself, so the document
  // is coherent before anybody has decided what to ask the meeting for.
  const proposedFee = round2(options?.proposedFee ?? feeToCoverBudget);
  const proposedAnnualCommunity = round2(proposedFee * contributingUnits * 12);
  const reservePerUnitMonthly = round2(proposedFee - feeToCoverBudget);
  /**
   * The residual, not the per-villa figure multiplied up.
   *
   * `feeToCoverBudget` is a division rounded to the cent, so multiplying the
   * rounded remainder back across sixteen villas and twelve months re-inflates
   * that rounding into pounds: the allocation table printed
   * 4,843,030.00 + 916,968.96 against a total of 5,760,000.00 and was short by
   * 1.04 on its face. Taking the reserve as what is left of the proposed
   * contributions after the budget makes the column add up exactly, which is
   * the only version an owner checking the arithmetic will accept.
   */
  const reserveAnnual = round2(proposedAnnualCommunity - budgetExpenditure);
  const reserveShare = proposedFee > 0 ? round2((reservePerUnitMonthly / proposedFee) * 100) : null;

  /* --- lever 2: cut the expenditure to fit the contribution --- */
  const expenditureCeiling = contributionsAnnual;
  const reductionRequired = round2(Math.max(0, budgetExpenditure - expenditureCeiling));
  const cutsThatWouldClose = categories
    .filter(l => l.budget > 0)
    .map(l => ({ category: l.category, budget: l.budget, closesGap: l.budget >= reductionRequired }))
    .sort((a, b) => b.budget - a.budget);

  /* --- month by month --- */
  // The contribution is a monthly assessment, so a twelfth of the annual figure
  // is the month's income by construction rather than by inference.
  const monthlyContribution = round2(feeBilled * contributingUnits);
  const months: AnnualMonthLine[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${reportYear}-${String(m).padStart(2, '0')}`;
    const spend = expensesInPeriod(expenses, currency, monthStart(month), monthEnd(month));
    const got = collectedInPeriod(payments, currency, monthStart(month), monthEnd(month)).maintenance;
    months.push({
      month,
      expenditure: spend,
      income: monthlyContribution,
      received: got,
      shortfall: round2(spend - monthlyContribution)
    });
  }
  const monthsOver = months.filter(r => r.shortfall > 0).map(r => r.month);

  return {
    currency,
    reportYear,
    budgetYear: reportYear + 1,
    contributingUnits,
    expenditure,
    priorExpenditure,
    expenditureChangePct: pct(priorExpenditure, expenditure),
    perUnitAnnual,
    perUnitMonthly,
    feeBilled,
    contributionsAnnual,
    monthlyPositionPerUnit,
    annualCommunityPosition,
    received,
    collectionRatePct: collectionRate(billedCharges, received),
    budgetExpenditure,
    budgetPerUnitAnnual,
    budgetPerUnitMonthly,
    budgetChangePct: pct(expenditure, budgetExpenditure),
    feeToCoverBudget,
    proposedFee,
    proposedAnnualCommunity,
    reservePerUnitMonthly,
    reserveAnnual,
    reserveShare,
    expenditureCeiling,
    reductionRequired,
    cutsThatWouldClose,
    categories,
    months,
    monthsCovered: 12 - monthsOver.length,
    monthsOver
  };
}

/* ------------------------------------------------------------------ *
 * Operational and financial health
 *
 * One grade, from four things the ledger already knows. Asked for as a quick
 * read on the dashboard — "is the property being run well right now" — without
 * anyone having to open four screens and hold the figures in their head.
 *
 * **Nothing here is invented and nothing is weighted by opinion about the
 * property.** Each component is an arithmetic statement about records that
 * exist, each is reported alongside the grade with its own score, and the
 * grade is a weighted mean of exactly those. If it cannot be explained by the
 * components printed beside it, it is a bug.
 *
 * **A component with no data is excluded and the weights are renormalised — it
 * is never scored zero.** A property that has billed nothing has not "failed
 * collection"; there is simply nothing to collect, and scoring that as zero
 * would manufacture a bad grade out of an empty month. Same rule as
 * `entitledUnits`: absent is not zero. When nothing at all can be measured the
 * function returns `null` rather than a grade, and the dashboard says so.
 * ------------------------------------------------------------------ */

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface HealthComponent {
  key: 'collection' | 'coverage' | 'ageing' | 'cash';
  label: string;
  /** 0–100. */
  score: number;
  /** Share of the grade this component carried, after renormalising. */
  weight: number;
  /** The figure behind the score, in words, for printing beside it. */
  detail: string;
}

export interface OperationalHealth {
  currency: Currency;
  /** 0–100, the weighted mean of the components below. */
  score: number;
  grade: HealthGrade;
  components: HealthComponent[];
  /** The period the grade describes. */
  from: string;
  to: string;
}

/** Where the grade boundaries sit. Stated once so the UI cannot disagree. */
export function gradeFor(score: number): HealthGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

/** Clamp a ratio into a 0–100 score. */
function scoreOf(ratio: number): number {
  return round2(Math.max(0, Math.min(1, ratio)) * 100);
}

/**
 * A single read on how the property is running, for one currency.
 *
 * The four components, and why each is in:
 *
 *   - **Collection** — of what was billed in the period, how much arrived. The
 *     most direct measure of whether the corporation is actually funded.
 *   - **Cost coverage** — contributions billed against money spent. A property
 *     collecting perfectly can still be run at a structural loss, which is
 *     precisely the position the annual report exists to surface, so it cannot
 *     be left out of a health figure.
 *   - **Debt ageing** — what share of outstanding debt is under 90 days. Old
 *     debt is materially worse than recent debt and a flat arrears total hides
 *     that entirely.
 *   - **Cash** — collected less spent over the period. The one figure that
 *     needs no interpretation.
 */
export function operationalHealth(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  currency: Currency,
  from: string,
  to: string
): OperationalHealth | null {
  const parts: { key: HealthComponent['key']; label: string; weight: number; score: number; detail: string }[] = [];

  const billed = chargedInPeriod(charges, currency, from, to);
  const collected = collectedInPeriod(payments, currency, from, to);
  const billedTotal = round2(billed.rent + billed.maintenance);
  const collectedTotal = round2(collected.rent + collected.maintenance);
  const spent = expensesInPeriod(expenses, currency, from, to);

  // --- collection ---
  if (billedTotal > 0) {
    const rate = collectedTotal / billedTotal;
    parts.push({
      key: 'collection',
      label: 'Collection',
      weight: 35,
      // Capped at 100: a rate above it is arrears catch-up, not sustainable
      // performance, and letting it run over would mask a weak component.
      score: scoreOf(rate),
      detail: `${formatPct(rate * 100)} of ${formatPlain(billedTotal)} billed was received`
    });
  }

  // --- cost coverage ---
  if (spent > 0 && billedTotal > 0) {
    parts.push({
      key: 'coverage',
      label: 'Cost coverage',
      weight: 30,
      score: scoreOf(billedTotal / spent),
      detail: `${formatPlain(billedTotal)} billed against ${formatPlain(spent)} spent`
    });
  }

  // --- debt ageing ---
  const aged = arrearsAgeing(units, charges, payments, to).find(a => a.currency === currency);
  if (aged && aged.buckets.total > 0) {
    const fresh = round2(aged.buckets.total - aged.buckets.over90);
    parts.push({
      key: 'ageing',
      label: 'Debt ageing',
      weight: 20,
      score: scoreOf(fresh / aged.buckets.total),
      detail: `${formatPlain(aged.buckets.over90)} of ${formatPlain(aged.buckets.total)} owing is over 90 days`
    });
  } else if (aged || billedTotal > 0) {
    // Billed something and nobody is in arrears: that is a full score, and it
    // has to be said rather than dropped, or a property with no debt would be
    // graded only on the components where it can lose.
    parts.push({
      key: 'ageing',
      label: 'Debt ageing',
      weight: 20,
      score: 100,
      detail: 'nothing is outstanding'
    });
  }

  // --- cash ---
  if (collectedTotal > 0 || spent > 0) {
    const net = round2(collectedTotal - spent);
    // Scored against what was spent: breaking even is 50, collecting twice what
    // was spent is 100, spending twice what was collected is 0. A property with
    // no costs recorded cannot be scored on this and is excluded above.
    const score = spent > 0 ? scoreOf(collectedTotal / (spent * 2)) : 100;
    parts.push({
      key: 'cash',
      label: 'Cash position',
      weight: 15,
      score,
      detail: `${formatPlain(collectedTotal)} received against ${formatPlain(spent)} spent (${net >= 0 ? '+' : ''}${formatPlain(net)})`
    });
  }

  if (parts.length === 0) return null;

  // Renormalise across the components that could actually be measured, so a
  // missing one never drags the grade down.
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = round2(parts.reduce((s, p) => s + p.score * (p.weight / totalWeight), 0));

  return {
    currency,
    score,
    grade: gradeFor(score),
    from,
    to,
    components: parts.map(p => ({
      key: p.key,
      label: p.label,
      score: p.score,
      weight: round2((p.weight / totalWeight) * 100),
      detail: p.detail
    }))
  };
}

function formatPct(v: number): string {
  return `${round2(v).toFixed(1)}%`;
}

function formatPlain(v: number): string {
  return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
