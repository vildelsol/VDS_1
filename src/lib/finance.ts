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
  Booking,
  PROPERTY_LOCATIONS,
  ExpenseFund,
  MANAGING_COMPANY_NAME,
  fundOf,
  getUnitDisplayName
} from '../types';
import { round2, sumMoney, addMoney, subtractMoney, formatMoney } from './money';

/* ------------------------------------------------------------------ *
 * Engines with no screen — deliberately kept
 *
 * Four exports here are reachable only from the test suite, and a sweep for
 * dead code will name them every time. They are not dead:
 *
 *   - `form13BContributions` and `form13CDebts` compute the Commission's
 *     statutory return. Ro decided on 2026-08-21 that the return is produced by
 *     hand for now and asked for no export to be built — *"Forms 13B/13C export
 *     stays manual"*. The engines are finished and tested so that the export is
 *     a screen away on the day it is wanted.
 *   - `periodStatement` gives opening balance, activity and closing balance for
 *     a range. It is what makes a statement reconcilable, and it is the shape any
 *     future accountant-facing statement needs.
 *   - `disproportionateLevies` flags lots levied out of step with their
 *     entitlement — the fairness check behind the Act's apportionment rules.
 *
 * Each is covered by tests, so none of them can rot silently. **Do not delete
 * them as unused, and do not build screens for them unasked.** If they are ever
 * genuinely unwanted, that is Ro's call and not a tidy-up.
 * ------------------------------------------------------------------ */

import { daysSinceOn, isWithin, monthEnd, monthStart, monthOf, monthsBetween, nightsBetween, addDays, today } from './dates';

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

/**
 * Cash actually received from an already-chosen set of receipts over a range.
 *
 * The caller filters for currency, category and villa; this applies the one rule
 * that is easy to get subtly wrong and must not vary between reports — a refund
 * reduces the period it was **paid out** in, not the period of the receipt it
 * came from. `collectedInPeriod` and the shortfall report's `receivedInMonth`
 * both already worked this way; anything new that counts receipts goes through
 * here so it cannot drift away from them.
 */
export function netReceivedInPeriod(payments: Payment[], start: string, end: string): number {
  const completed = payments.filter(p => p.status === 'completed');
  return subtractMoney(
    sumMoney(completed.filter(p => isWithin(p.date, start, end)).map(p => p.amount)),
    sumMoney(completed.filter(p => p.refundedOn && isWithin(p.refundedOn, start, end)).map(p => refundedAsOf(p)))
  );
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

/**
 * A cost that was taken back. It is in no figure anywhere by design.
 *
 * Every sum in this file already keys on `status === 'paid'` or
 * `status === 'pending'`, so a void falls out of the arithmetic without anyone
 * remembering to exclude it — that is why `void` is a status rather than a flag.
 * This exists for the places that are *not* sums: a register, a printed list, a
 * villa's own history, where the question is "should this line be shown as a real
 * cost?" rather than "what do the costs add up to?".
 *
 * A list that shows a voided cost must mark it. One that totals its column must
 * leave it out.
 */
export function isVoidExpense(expense: Expense): boolean {
  return expense.status === 'void';
}

/** The costs that still count: everything that has not been taken back. */
export function liveExpenses(expenses: Expense[]): Expense[] {
  return expenses.filter(e => !isVoidExpense(e));
}

/* ------------------------------------------------------------------ *
 * The two books
 *
 * The corporation's money and ISPO's money are not the same money, and a
 * document that mixes them misstates one of them. See `ExpenseFund` in
 * src/types.ts for what belongs where and why absent means `strata`.
 *
 * **The rule about where this filter goes.** A document that is a strata
 * document *by identity* — the proprietors' monthly report, the annual report,
 * Form 13C, an owner's statement — filters here, inside the function, exactly as
 * it already decides for itself that only `status === 'paid'` counts. It must not
 * be left to the caller: a screen written next year would have to know to do it,
 * and the one that forgot would put ISPO's vehicle insurance back into the
 * contribution put to the meeting, silently and self-consistently.
 *
 * The combined views — the dashboard, the charts, the management report, and the
 * Operating Statement, which Ro keeps as *"my all in view for the entire
 * business"* — deliberately do not filter. They count both books and state the
 * split, so the total is explainable rather than merely large.
 * ------------------------------------------------------------------ */

/** A cost of running the property, funded by maintenance contributions. */
export function isStrataCost(expense: Expense): boolean {
  return fundOf(expense) === 'strata';
}

/** One of ISPO's own costs, funded out of rental income. */
export function isIspoCost(expense: Expense): boolean {
  return fundOf(expense) === 'ispo';
}

/** Only the corporation's costs. What every owner-facing document counts. */
export function strataExpenses(expenses: Expense[]): Expense[] {
  return expenses.filter(isStrataCost);
}

/** Only ISPO's costs. */
export function ispoExpenses(expenses: Expense[]): Expense[] {
  return expenses.filter(isIspoCost);
}

/* ------------------------------------------------------------------ *
 * Reading one book, or both
 *
 * Ro, 2026-09-28: *"The operational reports tab is showing payments for both
 * ISPO and the BNS Strata. Both are not supposed to be mixed... There must be
 * options to separate, especially for when the accountant comes."*
 *
 * `ExpenseFund` above says which book pays a **cost**. Income needed the same
 * answer and did not have one, so every screen that summed receipts summed both
 * books into a single "received" and a single "billed". The classification is
 * not a new decision — it is the one already built into `ispoOperations`, which
 * counts rent and short-stay bookings as ISPO's income and nothing else:
 *
 *   - **ISPO's income** is rent and short-stay bookings. The corporation does not
 *     collect rent for proprietors; the letting machinery is for the villas VDS
 *     lets on its own account, and that money is ISPO's.
 *   - **The corporation's income** is maintenance contributions, utilities
 *     recovered, and other income — levies and recharges for work it performed.
 *
 * Stated as functions of the category so the mapping lives in one place and can
 * be asserted, rather than being re-derived by each screen.
 * ------------------------------------------------------------------ */

/**
 * Which book a report is being read on.
 *
 * `everything` is not "no filter applied by accident" — it is a deliberate third
 * choice, the combined all-in view Ro keeps (*"it is my all in view for the
 * entire business which is important"*). It is the default everywhere, so no
 * screen changes what it shows until somebody asks it to.
 */
export type ReportBook = ExpenseFund | 'everything';

export const REPORT_BOOKS: ReportBook[] = ['everything', 'strata', 'ispo'];

/** Which book a receipt belongs to, from what it was received for. */
export function bookOfPaymentCategory(category: PaymentCategory): ExpenseFund {
  return category === 'Rent' || category === 'Booking' ? 'ispo' : 'strata';
}

/** Which book a charge belongs to. Rent is ISPO's to collect; maintenance is the fund's. */
export function bookOfChargeCategory(category: ChargeCategory): ExpenseFund {
  return category === 'Rent' ? 'ispo' : 'strata';
}

/**
 * The charge/payment categories that exist in a book.
 *
 * Used where a screen walks accounts per category (`accountBalance` is computed
 * per unit **per category**), so a receivables figure on the strata book counts
 * maintenance accounts and no rent account, rather than filtering the answer
 * after the fact.
 */
export function chargeCategoriesInBook(book: ReportBook): ChargeCategory[] {
  const all: ChargeCategory[] = ['Rent', 'Maintenance'];
  return book === 'everything' ? all : all.filter(c => bookOfChargeCategory(c) === book);
}

export function paymentsInBook(payments: Payment[], book: ReportBook): Payment[] {
  return book === 'everything' ? payments : payments.filter(p => bookOfPaymentCategory(p.category) === book);
}

export function chargesInBook(charges: Charge[], book: ReportBook): Charge[] {
  return book === 'everything' ? charges : charges.filter(c => bookOfChargeCategory(c.category) === book);
}

export function expensesInBook(expenses: Expense[], book: ReportBook): Expense[] {
  return book === 'everything' ? expenses : expenses.filter(e => fundOf(e) === book);
}

/**
 * Is this cost row actually the monthly contribution, already counted from its
 * receipt?
 *
 * A plumber or a locksmith on one of ISPO's villas is a genuine ISPO cost. A
 * **Maintenance**-category row against a villa VDS lets on its own account is the
 * contribution, which has a receipt and is counted from it — the one shape that
 * would put the same money on ISPO's books twice.
 *
 * One definition, used by `ispoOperations`, by `operatingStatement` and by the
 * management summary on the reports tab, so those three cannot disagree about
 * what ISPO spent. They did: the summary counted such a row and the statement
 * under it did not.
 */
export function isContributionCountedFromReceipts(expense: Expense, ownAccountUnitIds: Set<string>): boolean {
  return expense.category === 'Maintenance' && !!expense.unitId && ownAccountUnitIds.has(expense.unitId);
}

/** The villas VDS lets on the corporation's own account, optionally in one currency. */
export function ownAccountUnitIds(units: Unit[], currency?: Currency): Set<string> {
  return new Set(
    units
      .filter(u => u.letOnOwnAccount === true && (!currency || (u.maintCurrency || u.currency) === currency))
      .map(u => u.id)
  );
}

/**
 * The costs a book counts as its own — the book filter, plus the one exclusion
 * that keeps ISPO's side from counting a contribution twice.
 *
 * What every screen reading a book should call. `expensesInBook` alone is the
 * book filter and nothing more.
 */
export function expensesForBook(expenses: Expense[], units: Unit[], book: ReportBook, currency?: Currency): Expense[] {
  const inBook = expensesInBook(expenses, book);
  if (book !== 'ispo') return inBook;
  const own = ownAccountUnitIds(units, currency);
  return inBook.filter(e => !isContributionCountedFromReceipts(e, own));
}

/** What each book is called on a screen and at the head of a printed page. */
export const REPORT_BOOK_LABELS: Record<ReportBook, string> = {
  everything: 'Everything (both books)',
  strata: 'The strata corporation',
  ispo: `${MANAGING_COMPANY_NAME} (internal)`
};

/**
 * What a reader is being told the scope of the page is.
 *
 * Printed under the title of anything read on one book. A statement that has
 * silently had half the money taken out of it is worse than one that has not
 * been filtered at all, so the scope is always named on the face of the page.
 */
export const REPORT_BOOK_SCOPE: Record<ReportBook, string> = {
  everything: `Both books: the corporation's money and ${MANAGING_COMPANY_NAME}'s. Internal, not a statement of the body corporate alone.`,
  strata:
    'The corporation only: contributions, utilities recovered and other income, against the costs contributions fund. No rent, no short-stay rental, none of the letting company’s costs.',
  ispo: `${MANAGING_COMPANY_NAME} only: rent and short-stay rental against its own costs. Internal, not for an owner statement or a statutory return.`
};

export function bookingsForUnit(bookings: Booking[], unit: Unit, allUnits?: Unit[]): Booking[] {
  return bookings.filter(b => belongsToUnit(b, unit, allUnits));
}

/* ------------------------------------------------------------------ *
 * Booking deposits and the receipts ledger
 * ------------------------------------------------------------------ */

/**
 * A reservation whose deposit needs a person to look at it.
 *
 * Ro, 2026-09-28, asking for deposits to reach the ledger by themselves: *"i do
 * not want there to be a double count of payments after i have manually
 * confirmed before i apply the fix."*
 *
 * That is the real risk and it is not the one the sync guards against. The sync
 * matches a reservation's receipt on `bookingId`, so it can never raise a second
 * one for the same reservation. What it cannot see is a deposit somebody typed
 * into **Record a payment** instead: that receipt carries no `bookingId`, so it
 * sits beside the reservation's own receipt and the money is on the ledger twice.
 *
 * Nothing here changes anything. It finds the shapes a person has to decide
 * about, names the money in each, and leaves the decision to them.
 */
export interface BookingDepositFinding {
  booking: Booking;
  /** The receipt raised by the reservation itself, if there is a live one. */
  linked: Payment | null;
  /**
   * Booking receipts against the same villa, in the same currency, for the same
   * amount and around the same dates, that are **not** tied to this reservation.
   * Each one is either a duplicate of the deposit or a genuinely separate
   * payment, and only a person knows which.
   */
  unlinked: Payment[];
  /** True while the reservation's own receipt is still awaiting confirmation. */
  awaiting: boolean;
}

/**
 * Deposits on the ledger twice, or not yet on it at all.
 *
 * The window is deliberately wide — a deposit is taken when the guest books,
 * which can be months before they arrive — and deliberately bounded, so a
 * standing guest who pays the same amount every year is not matched against a
 * stay two years away. Amount and currency must match exactly: a part payment of
 * a different size is a different payment, not a duplicate of this one.
 */
export function bookingDepositFindings(bookings: Booking[], payments: Payment[]): BookingDepositFinding[] {
  const live = payments.filter(p => p.status !== 'reversed');

  const findings: BookingDepositFinding[] = [];
  for (const booking of bookings) {
    if (booking.status === 'cancelled' || booking.depositPaid <= 0) continue;

    const linked = live.find(p => p.bookingId === booking.id) || null;

    const windowFrom = addDays(booking.checkIn, -365);
    const windowTo = addDays(booking.checkOut, 60);
    const unlinked = live.filter(
      p =>
        p.bookingId !== booking.id &&
        p.category === 'Booking' &&
        p.unitId === booking.unitId &&
        p.currency === booking.currency &&
        round2(p.amount) === round2(booking.depositPaid) &&
        isWithin(p.date, windowFrom, windowTo)
    );

    const awaiting = !!linked && linked.status === 'pending';
    if (unlinked.length === 0 && !awaiting) continue;
    findings.push({ booking, linked, unlinked, awaiting });
  }
  return findings.sort((a, b) => a.booking.checkIn.localeCompare(b.booking.checkIn));
}

/** The currency a unit is billed in for a given category. */
export function chargeCurrency(unit: Unit, category: ChargeCategory): Currency {
  return category === 'Maintenance' ? (unit.maintCurrency || unit.currency) : unit.currency;
}

/**
 * What a tenant pays each month, and how it divides.
 *
 * Ro, 2026-11-10: the **agreed rent** is the one figure the tenant pays
 * (J$75,000), and the HOA maintenance (J$20,000) is taken out of it, leaving ISPO
 * J$55,000. Raising the maintenance to J$27,000 does not change what the tenant
 * pays; it only leaves ISPO less (J$48,000). *"Increase in maintenance does not
 * change the total, it just means after maintenance is subtracted, ISPO will
 * naturally receive less income. The only way the totals change is if the rent is
 * increased."*
 *
 * So `monthlyRent` in the register is the whole agreed rent, `monthlyMaintenance`
 * is the part of it that goes to the corporation, and this is the only place the
 * two are divided: `total` is what is billed, `maintenance` is the corporation's
 * share inside it, and `rent` (total less maintenance) is what is left for ISPO.
 *
 * The share is taken only when maintenance is in the same currency as the rent,
 * since USD and JMD are never combined, and can never exceed the rent itself.
 * A villa with no rent has nothing for a tenant to pay.
 */
export interface RentBreakdown {
  /** What is left for ISPO once the corporation's share is taken out. */
  rent: number;
  /** The corporation's maintenance, taken out of the agreed rent. */
  maintenance: number;
  /** The agreed rent: the single figure the tenant is billed. */
  total: number;
}

export function rentBreakdown(unit: Unit, rent: number = unit.monthlyRent, currency: Currency = unit.currency): RentBreakdown {
  const total = round2(rent);
  if (!(total > 0)) return { rent: total, maintenance: 0, total };
  const levy = round2(unit.monthlyMaintenance || 0);
  const maintenance = levy > 0 && chargeCurrency(unit, 'Maintenance') === currency ? Math.min(levy, total) : 0;
  return { rent: round2(total - maintenance), maintenance, total };
}

/**
 * "HOA maintenance J$20,000.00 taken from this; ISPO receives J$55,000.00", for a
 * charge that carries both parts; empty otherwise (internal screens only; the
 * tenant never sees it). Read from the charge itself, never recomputed from
 * the register, so a statement keeps telling the truth about a month after the
 * levy has moved.
 */
export function chargeBreakdownNote(charge: Charge): string {
  const m = charge.maintenancePortion || 0;
  if (charge.category !== 'Rent' || !(m > 0) || charge.rentPortion === undefined) return '';
  return `HOA maintenance ${formatMoney(m, charge.currency)} taken from this; ISPO receives ${formatMoney(charge.rentPortion, charge.currency)}`;
}

/**
 * Rent charges raised before the tenant's total included maintenance.
 *
 * Those are whole-rent charges with no recorded split. Restating one means
 * voiding it and raising a replacement at rent + maintenance, so the record is
 * kept and the correction is auditable. Only a charge billed at the old rent (the
 * agreed rent less the maintenance) or already at the agreed rent is touched:
 * anything else was billed at some other figure and is reported, not guessed at.
 * Restate before raising the maintenance, so the old rent can still be recognised.
 */
export interface RentRestatement {
  charge: Charge;
  unit: Unit;
  breakdown: RentBreakdown;
}

export function rentChargesToRestate(
  units: Unit[],
  charges: Charge[]
): { restate: RentRestatement[]; skipped: { charge: Charge; reason: string }[] } {
  const restate: RentRestatement[] = [];
  const skipped: { charge: Charge; reason: string }[] = [];
  for (const charge of charges) {
    if (charge.category !== 'Rent' || charge.status !== 'open' || charge.kind === 'one-off') continue;
    if (charge.rentPortion !== undefined || charge.maintenancePortion !== undefined) continue;
    const unit = units.find(u => u.id === charge.unitId);
    if (!unit || unit.status !== 'long-term') continue;
    const breakdown = rentBreakdown(unit);
    if (!(breakdown.maintenance > 0) || charge.currency !== unit.currency) continue;
    // A charge raised before the maintenance was part of the rent is the old rent
    // (agreed rent less the maintenance) and is restated to the agreed rent. One
    // already at the agreed rent only lacks its split.
    const wasNet = round2(charge.amount) === round2(breakdown.total - breakdown.maintenance);
    const wasTotal = round2(charge.amount) === breakdown.total;
    if (!wasNet && !wasTotal) {
      skipped.push({ charge, reason: 'billed at a figure other than the agreed rent' });
      continue;
    }
    restate.push({ charge, unit, breakdown });
  }
  return { restate, skipped };
}

/**
 * Is this villa's maintenance taken out of the tenant's rent?
 *
 * True for a let villa whose agreed rent carries a maintenance share. Internal
 * screens (Dashboard, Notifications hub) say "settled from rent" for these; the
 * tenant never sees it.
 */
export function maintenanceFundedFromRent(unit: Unit): boolean {
  return unit.status === 'long-term' && rentBreakdown(unit).maintenance > 0;
}

/**
 * Maintenance receipts that belong to the tenant's rent.
 *
 * Before the tenant's rent was one figure, a let villa's money was keyed twice:
 * the rent as a Rent receipt and the maintenance share as a separate Maintenance
 * receipt. Once the rent charge includes the maintenance, that second receipt
 * leaves the rent account short by the same amount while the maintenance account
 * shows paid, so the one payment is counted on both sides.
 *
 * This finds those receipts so they can be moved into the rent account, where
 * `settledFromRent` then covers the maintenance again. It is deliberately narrow:
 *   - only a completed, un-refunded, hand-keyed Maintenance receipt in the villa's
 *     own currency, on a long-term villa whose open rent charges already carry the
 *     split (so Restate has been run);
 *   - only a whole number of months of the villa's maintenance, so an unrelated
 *     special-assessment payment is left alone;
 *   - oldest first, and never more than the rent still owed, so a tenant can never
 *     be moved into credit.
 * Anything else is skipped with its reason.
 */
export interface MaintenanceReceiptMove {
  payment: Payment;
  unit: Unit;
}

export function maintenanceReceiptsToMove(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  tenancies: Tenancy[] = []
): { move: MaintenanceReceiptMove[]; skipped: { payment: Payment; reason: string }[] } {
  const move: MaintenanceReceiptMove[] = [];
  const skipped: { payment: Payment; reason: string }[] = [];
  const cents = (n: number) => Math.round((Number(n) || 0) * 100);
  for (const unit of units) {
    if (unit.status !== 'long-term') continue;
    const levy = cents(unit.monthlyMaintenance);
    if (!(levy > 0)) continue;
    const currency = unit.currency;
    const rentCharges = charges.filter(
      c => c.unitId === unit.id && c.category === 'Rent' && c.status === 'open' && c.currency === currency
    );
    if (!rentCharges.some(c => (c.maintenancePortion || 0) > 0)) continue;
    /*
     * Only the money of the tenancy living there now.
     *
     * A villa moves through states over its life — let, short stay, owner
     * occupied, let again — and the owner pays the levy themselves through every
     * stretch in which nobody is renting. Those receipts are the owner's own
     * money. Sweeping one into a later tenant's rent credits that tenant with a
     * payment they never made and leaves the owner reading as though they never
     * paid.
     *
     * The window is therefore the CURRENT tenancy's own dates, not the villa's
     * whole history. Anchoring it to the earliest open rent charge is not enough:
     * a tenant who left owing leaves their charges open for years, which would
     * reopen the window back past every owner-paid month since. With no active
     * tenancy on file there is no window at all and nothing is moved, because
     * there is then no tenant for the money to belong to.
     */
    const here = tenancies
      .filter(t => t.unitId === unit.id && t.status === 'active' && !t.endedOn)
      .sort((a, b) => (b.startedOn || '').localeCompare(a.startedOn || ''))[0];
    const from = here?.startedOn || '';
    const mine = payments.filter(p => p.unitId === unit.id && p.currency === currency && p.status === 'completed' && !p.derived);
    /*
     * No window, so nothing can be judged — but say so rather than going quiet.
     *
     * A tenancy opened by a plain status change deliberately carries no move-in
     * date (`syncTenancy`: unknown is left unknown, because stamping today
     * invented move-in dates for tenants of many years). Without one there is no
     * way to tell this tenant's money from the owner's, and silently moving
     * nothing would read in the office as "there was nothing to fix". Every
     * candidate is reported instead, with what to do about it.
     */
    if (!from) {
      for (const p of mine.filter(x => x.category === 'Maintenance')) {
        skipped.push({
          payment: p,
          reason: here
            ? "this villa's tenancy has no move-in date on record, so the tenant's money cannot be told from the owner's — set the move-in date on the tenancy first"
            : 'this villa is let but has no tenancy on record, so there is no tenant for this money to belong to'
        });
      }
      continue;
    }
    const billed = rentCharges.reduce((a, c) => a + cents(c.amount), 0);
    const received = mine.filter(p => p.category === 'Rent').reduce((a, p) => a + cents(netPaidAsOf(p)), 0);
    let owed = Math.max(0, billed - received);
    const candidates = mine
      .filter(p => p.category === 'Maintenance' && p.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const p of candidates) {
      const amount = cents(p.amount);
      if (p.refundedAmount) {
        skipped.push({ payment: p, reason: 'it has been refunded in part or in full' });
      } else if (p.bookingId || p.utilityId) {
        // Generated from a reservation or a meter reading: the two are kept in
        // step by id, and re-categorising one strands the record it came from.
        skipped.push({ payment: p, reason: 'it belongs to a reservation or a utility reading' });
      } else if (amount <= 0 || amount % levy !== 0) {
        skipped.push({ payment: p, reason: 'it is not a whole number of months of this villa\'s maintenance' });
      } else if (amount > owed) {
        skipped.push({ payment: p, reason: 'moving it would put the tenant in credit' });
      } else {
        owed -= amount;
        move.push({ payment: p, unit });
      }
    }
  }
  return { move, skipped };
}

/**
 * The combined ("everything") view, with money that is on both books counted once.
 *
 * A tenant pays one figure, rent, J$75,000 of which the corporation takes
 * J$20,000 as the villa's maintenance. The tenant's Rent charge therefore already
 * contains that J$20,000, and the corporation's own Maintenance charge for the
 * villa is the same J$20,000 again. Each book is right on its own: ISPO billed
 * J$75,000 and passes J$20,000 on, the corporation billed J$20,000. Added into
 * one total, though, the J$20,000 is counted twice, and "billed" reads J$95,000
 * for a month in which the tenant is asked for J$75,000.
 *
 * This takes it out once, for the combined view only: the Rent charge is reduced
 * by the maintenance that has its own Maintenance charge for the same villa,
 * month and currency, and the maintenance receipts on those villas (ISPO paying
 * the corporation its share) are dropped, being a transfer between the two books,
 * not money from anyone. The single-book views are not given these lists and so
 * are untouched. Inputs are never modified; adjusted copies are returned.
 */
export function consolidateEverything(
  charges: Charge[],
  payments: Payment[]
): { charges: Charge[]; payments: Payment[]; eliminatedCharges: number } {
  const maintenance = new Map<string, Charge>();
  for (const c of charges) {
    if (c.category === 'Maintenance' && c.status === 'open' && c.kind === undefined) {
      maintenance.set(`${c.unitId}|${c.periodMonth}|${c.currency}`, c);
    }
  }
  const fundedFromRent = new Set<string>(); // unitId|currency
  let eliminated = 0;
  const adjusted = charges.map(c => {
    if (c.category !== 'Rent' || c.status !== 'open' || !(c.maintenancePortion && c.maintenancePortion > 0)) return c;
    const pair = maintenance.get(`${c.unitId}|${c.periodMonth}|${c.currency}`);
    if (!pair) return c;
    const intra = Math.min(c.maintenancePortion, pair.amount);
    if (!(intra > 0)) return c;
    fundedFromRent.add(`${c.unitId}|${c.currency}`);
    eliminated++;
    return { ...c, amount: round2(c.amount - intra), maintenancePortion: round2(c.maintenancePortion - intra) };
  });
  const keptPayments = payments.filter(p => !(p.category === 'Maintenance' && fundedFromRent.has(`${p.unitId}|${p.currency}`)));
  return { charges: adjusted, payments: keptPayments, eliminatedCharges: eliminated };
}

/**
 * Maintenance on a rented villa is settled out of the rent, not paid separately.
 *
 * Ro, 2026-11-10: the tenant pays one figure, the corporation takes its share
 * from it, and it should not take a second click to say so. So as rent is
 * received, the maintenance inside it is credited to the villa's maintenance
 * account automatically.
 *
 * It is **worked out, never stored**, and it only follows money that has really
 * arrived:
 *   - completed Rent receipts are applied to the villa's rent charges oldest
 *     first (a receipt never pays a charge that is not yet due ahead of an older
 *     one), and each charge is credited its maintenance share in proportion to
 *     the part of it that has been paid. A tenant a month behind therefore leaves
 *     that month's maintenance owing too.
 *   - pending, voided and refunded money does not count, and a refund takes the
 *     credit back with it.
 *   - the credit can never exceed what is still owed on the maintenance account,
 *     so a maintenance receipt entered by hand as well cannot be counted twice.
 *   - charges raised before the split existed carry no maintenance share and give
 *     no credit; restating them brings them in.
 *
 * Each credit is returned as a derived Payment dated the day the rent arrived, so
 * every screen that already sums maintenance receipts, statements included, picks
 * it up without having to know about it.
 */
export function settledFromRent(charges: Charge[], payments: Payment[]): Payment[] {
  const out: Payment[] = [];
  const cents = (n: number) => Math.round((Number(n) || 0) * 100);
  const keys = new Set<string>();
  for (const c of charges) {
    if (c.status === 'open' && c.category === 'Rent' && (c.maintenancePortion || 0) > 0) keys.add(`${c.unitId}|${c.currency}`);
  }
  for (const key of keys) {
    const [unitId, currency] = key.split('|') as [string, Currency];
    const mine = (c: Charge, cat: ChargeCategory) => c.unitId === unitId && c.currency === currency && c.category === cat && c.status === 'open';
    const rentCharges = charges.filter(c => mine(c, 'Rent')).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    const maintCharges = charges.filter(c => mine(c, 'Maintenance')).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
    const settled = (p: Payment) => p.status === 'completed' && p.unitId === unitId && p.currency === currency && !p.derived;

    /*
     * What each month's levy still needs, after the maintenance actually paid in
     * cash has been applied to it oldest first — the same ageing rule every other
     * balance in this system uses.
     */
    const owedByMonth = new Map<string, number>();
    let cash = payments.filter(p => settled(p) && p.category === 'Maintenance').reduce((a, p) => a + cents(netPaidAsOf(p)), 0);
    for (const c of maintCharges) {
      const amount = cents(c.amount);
      const covered = Math.min(cash, amount);
      cash -= covered;
      owedByMonth.set(c.periodMonth, (owedByMonth.get(c.periodMonth) || 0) + (amount - covered));
    }

    const rentReceipts = payments.filter(p => settled(p) && p.category === 'Rent').sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const queue = rentCharges.map(c => ({ month: c.periodMonth, total: cents(c.amount), left: cents(c.amount), share: cents(c.maintenancePortion || 0) }));
    let idx = 0;
    /*
     * Credited per month, not against the villa's whole maintenance balance.
     *
     * The levy inside September's rent settles September's levy and nothing else.
     * Pooling it instead let a tenant's late arrears pay a levy raised long after
     * they had gone — and, where the villa had since been sold, settle the NEW
     * proprietor's contribution out of the old tenant's money, which is exactly
     * what the sale rules exist to prevent.
     */
    const exactByMonth = new Map<string, number>();
    const emittedByMonth = new Map<string, number>();
    for (const receipt of rentReceipts) {
      let money = cents(netPaidAsOf(receipt));
      const touched = new Set<string>();
      while (money > 0 && idx < queue.length) {
        const q = queue[idx];
        const take = Math.min(money, q.left);
        if (q.total > 0 && take > 0) {
          exactByMonth.set(q.month, (exactByMonth.get(q.month) || 0) + (q.share * take) / q.total);
          touched.add(q.month);
        }
        q.left -= take;
        money -= take;
        if (q.left <= 0) idx++;
      }
      let credit = 0;
      for (const month of touched) {
        const owed = owedByMonth.get(month) || 0;
        const already = emittedByMonth.get(month) || 0;
        const want = Math.min(Math.round(exactByMonth.get(month) || 0) - already, owed);
        if (want > 0) {
          emittedByMonth.set(month, already + want);
          owedByMonth.set(month, owed - want);
          credit += want;
        }
      }
      if (credit > 0) {
        out.push({
          id: `from-rent-${receipt.id}`,
          receiptNo: '',
          payerName: 'Settled from rent',
          unitId,
          unitNumber: receipt.unitNumber,
          category: 'Maintenance',
          amount: credit / 100,
          currency,
          date: receipt.date,
          method: 'Other',
          reference: 'Settled from rent',
          notes: 'Maintenance taken out of the rent received. Worked out, not a separate receipt.',
          staffMember: 'System',
          status: 'completed',
          derived: true
        });
      }
    }
  }
  return out;
}

/** The recurring amount a unit is billed for a given category. */
export function chargeAmount(unit: Unit, category: ChargeCategory): number {
  return category === 'Maintenance' ? round2(unit.monthlyMaintenance) : rentBreakdown(unit).total;
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
  /**
   * Open charges raised against this account in the *other* currency.
   *
   * The mirror image of `mismatchedCurrencyPayments`, and it was missing. Both
   * sides of the balance are scoped to `chargeCurrency(unit, category)`, so a
   * charge raised in the currency the villa is *not* billed in was counted by
   * nothing and warned about by nothing: "Billed to date" read 0, and a payment
   * that did match the account currency then showed as a pure credit — the villa
   * appeared to be in credit for money it actually owed. Silent, and in the one
   * direction that flatters the books.
   *
   * Not netted, for the same reason as the payments: nothing is ever combined
   * across currencies. Surfaced so the record can be corrected.
   */
  mismatchedCurrencyCharges: Charge[];
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

  const openCharges = chargesForUnit(charges, unit, allUnits)
    .filter(c => c.category === category && c.status === 'open')
    .filter(c => !asOf || c.dueDate <= asOf)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const unitCharges = openCharges.filter(c => c.currency === currency);
  const mismatchedCharges = openCharges.filter(c => c.currency !== currency);

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

  /*
   * Aged against the date being asked about, not against the wall clock.
   *
   * This used to call daysSince(), which always measures from today — so an
   * arrears schedule run "as of" the end of last quarter printed a days-overdue
   * column measured from this morning, beside ageing buckets on the same page
   * that were correctly measured from the quarter end (see ageAccountArrears,
   * which has always used daysSinceOn). Two numbers on one document, describing
   * the same debt, disagreeing. Where no date is asked for, today is the date
   * being asked about, so ordinary screens are unchanged.
   */
  const oldestUnpaidDays =
    unpaidCharges.length > 0 ? Math.max(0, daysSinceOn(unpaidCharges[0].dueDate, asOf || today())) : 0;

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
    mismatchedCurrencyPayments: mismatched,
    mismatchedCurrencyCharges: mismatchedCharges
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

/**
 * Rent and maintenance that has been posted but is not owed yet.
 *
 * Posting a month raises every charge in it at once, each carrying the due date
 * built from the villa's own rent or maintenance day. So a month posted on the
 * 1st with rent due on the 7th creates a real, open charge six days before
 * anybody is late — and `delinquentAccounts` counted it, because it was called
 * without an "as of" date and therefore weighed every open charge regardless of
 * when it falls due. The notifications hub read "Rent outstanding — 1 unpaid
 * month" about money that was not yet due, which is the alert that teaches people
 * to stop reading alerts. Ro put it plainly on 2026-09-01: it defeated the point
 * of recording a due date at all.
 *
 * These are not warnings. They are what is coming, and they exist to be shown
 * quietly — so that the same screen can say "nothing is overdue" and still show
 * the 7th approaching.
 *
 * A credit already sitting on the account is applied first, so a tenant who paid
 * ahead does not appear on a list of money still to be found; if that covers the
 * whole of what is scheduled, nothing is reported for that account at all.
 */
export interface ScheduledCharge {
  unit: Unit;
  category: ChargeCategory;
  currency: Currency;
  /** The open charges not yet due, earliest first. */
  charges: Charge[];
  /** What is still to be found, after any credit already held. Always above nil. */
  amount: number;
  /** The earliest due date among them. */
  nextDueDate: string;
  /** Whole days until that date. Never negative — a charge that is due is not scheduled. */
  daysUntilDue: number;
}

export function scheduledCharges(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  asOf: string = today()
): ScheduledCharge[] {
  const out: ScheduledCharge[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const currency = chargeCurrency(unit, category);
      const upcoming = chargesForUnit(charges, unit, units)
        .filter(c => c.category === category && c.status === 'open' && c.currency === currency && c.dueDate > asOf)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      if (upcoming.length === 0) continue;

      // What the account looks like today. A negative balance is money held
      // against charges that have not been raised against it yet.
      const dueNow = accountBalance(unit, category, charges, payments, asOf, units);
      const creditHeld = dueNow.balance < 0 ? -dueNow.balance : 0;
      const amount = round2(Math.max(0, subtractMoney(sumMoney(upcoming.map(c => c.amount)), creditHeld)));
      if (amount <= 0) continue;

      out.push({
        unit,
        category,
        currency,
        charges: upcoming,
        amount,
        nextDueDate: upcoming[0].dueDate,
        daysUntilDue: Math.max(0, -daysSinceOn(upcoming[0].dueDate, asOf))
      });
    }
  }
  return out.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}

/**
 * Accounts holding money or debt in a currency the account is not billed in — a
 * data-integrity warning.
 *
 * Both directions count. A charge in the wrong currency is if anything the worse
 * of the two, because it understates what is owed rather than mislaying a
 * receipt, and it used to be reported by nothing at all.
 */
export function currencyMismatchWarnings(units: Unit[], charges: Charge[], payments: Payment[]): AccountBalance[] {
  const out: AccountBalance[] = [];
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance'] as ChargeCategory[]) {
      const account = accountBalance(unit, category, charges, payments, undefined, units);
      if (account.mismatchedCurrencyPayments.length > 0 || account.mismatchedCurrencyCharges.length > 0) {
        out.push(account);
      }
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
/**
 * The categories a spend chart should draw.
 *
 * Anything that moved, which from 2026-10-05 includes a category that nets to a
 * supplier credit. Both the management charts and the board pack filtered this
 * themselves with `> 0`, and so both dropped a credited category from the
 * picture while every total beside it still counted it.
 *
 * It lives here rather than inside a `useMemo` for the reason `stayValueForRate`
 * does: a rule written inside a component is a rule no test can reach, and this
 * one had to be wrong in two places at once before anybody would have noticed.
 *
 * A category with nothing paid and something still outstanding is deliberately
 * left out: this answers "what did the period cost", and the outstanding memo is
 * its own figure elsewhere.
 */
export function categoriesWithSpend<T extends { amount: number }>(breakdown: T[]): T[] {
  return breakdown.filter(row => row.amount !== 0);
}

export function ownerBilledUnitIds(units: Unit[]): Set<string> {
  return new Set(units.filter(u => u.status === 'owner-occupied' || u.status === 'short-term').map(u => u.id));
}

/** Collection rate for a period: what share of billed money actually came in. */
export function collectionRate(charged: number, collected: number): number | null {
  if (charged <= 0) return null;
  return round2((collected / charged) * 100);
}

/**
 * Whether the villa's **letting mode** implies somebody lives there.
 *
 * ⚠️ **This is not occupancy, and it must not be used to answer "how many
 * villas are occupied?".** `unit.status` is how the villa is *let* — a villa set
 * to `short-term` is one offered on Airbnb, whether or not a guest is in it
 * tonight. Reading it as occupancy is what put **"Occupancy 100%, Vacant villas
 * 0"** on the dashboard of a property whose short-let villas were all standing
 * empty and available (Ro, 2026-09-02). Use `occupancyOn()` below.
 *
 * It survives for the questions it does answer — is this villa let long-term, is
 * it the owner's own home — which is what billing keys off.
 */
export function isOccupied(unit: Unit): boolean {
  return unit.status === 'long-term' || unit.status === 'short-term' || unit.status === 'owner-occupied';
}

/**
 * How many villas actually have somebody in them, on a given day.
 *
 * The honest counterpart to `isOccupied`, and the one every screen that says the
 * word "occupancy" should call. A villa counts as occupied when a **tenancy
 * covers the day**, when a **guest is in residence that night**, or when it is
 * the **owner's own home** — the last because an owner-occupied villa files
 * neither a tenancy nor a booking and would otherwise read as empty, which is
 * the mirror of the fault this function exists to fix.
 *
 * Everything else is **available**: a short-let villa with no guest tonight is
 * not occupied, it is for sale to the next guest. Ro, 2026-09-02: *"the villas
 * that are not on long term lease are for short term vacation rentals.
 * Currently, they are available not occupied."*
 *
 * `unavailable` villas — off the market for renovation or repair — are counted
 * separately and **left out of the rate's denominator**, because a villa that
 * cannot be let is not a letting opportunity being missed. The rate is therefore
 * "of the villas that could be let, how many are", and the card states the
 * breakdown beside it rather than making the reader take that on trust.
 */
export interface OccupancyToday {
  /** Villas with somebody in them: a tenancy, a guest tonight, or the owner. */
  occupied: number;
  /** Villas that could take somebody tonight and have not. */
  available: number;
  /** Off the market — not counted as a missed letting. */
  unavailable: number;
  /** Every villa on the register. */
  total: number;
  /** occupied ÷ (total − unavailable), or null when nothing could be let. */
  rate: number | null;
}

/**
 * The two lettings businesses, counted apart.
 *
 * Ro, 2026-09-02, after the blended figure was fixed: *"the dashboard occupancy
 * chart will now only use long term lease, vacancy and unavailable status. Short
 * term rental should have its own chart."* He is right, and the reason is
 * sharper than housekeeping: **the two are measured in different units.**
 *
 *   - **Residential occupancy is a state.** Twelve of sixteen villas leased,
 *     true for months at a time, and a snapshot answers it honestly.
 *   - **Short-let occupancy is a proportion of a pool that turns over nightly.**
 *
 * One percentage covering both is a state and a rate blended together, which is
 * the same fault as counting a villa as occupied because of how it is let.
 *
 * **The short-let rule is Ro's own, stated in his words:** *"If 4 units are short
 * term, and 1 is occupied from short term rental, only 25% occupied."* A villa is
 * occupied or it is not — there are no part-month fractions in that figure —
 * because the question it answers is "what can I sell tonight?". Nights sold
 * across the month is a genuinely different measure and is carried beside it,
 * labelled, never folded in.
 */
export interface ResidentialOccupancy {
  /** Villas with a tenancy covering the day. */
  leased: number;
  /** Villas in the long-term pool with nobody in them. */
  vacant: number;
  /** The pool: villas that are available to be leased long-term, let or not. */
  pool: number;
  /** leased ÷ pool, or null when there is no long-term pool at all. */
  rate: number | null;
  /** Context lines, never counted as let: the proprietor's own home. */
  ownerOccupied: number;
  /** Committed to the other business — not vacant, just not this one's. */
  shortLet: number;
  /** Off the market entirely. */
  unavailable: number;
  /**
   * Villas whose status says long-term but which have no tenancy covering the
   * day.
   *
   * Named rather than silently counted either way. The register and the dated
   * records disagreeing is a fact worth seeing — it is how a tenant occupies a
   * villa for a month that nobody ever bills.
   */
  markedLeasedWithoutTenancy: string[];
}

export function residentialOccupancy(units: Unit[], tenancies: Tenancy[], day: string = today()): ResidentialOccupancy {
  const covered = new Set(
    tenancies
      .filter(t => t.startedOn && t.startedOn <= day && (!t.endedOn || day < t.endedOn))
      .map(t => t.unitId)
  );

  let leased = 0;
  let vacant = 0;
  let ownerOccupied = 0;
  let shortLet = 0;
  let unavailable = 0;
  const markedLeasedWithoutTenancy: string[] = [];

  for (const unit of units) {
    if (unit.status === 'unavailable') {
      unavailable++;
      continue;
    }
    if (unit.status === 'owner-occupied') {
      ownerOccupied++;
      continue;
    }
    if (unit.status === 'short-term') {
      shortLet++;
      continue;
    }
    // What is left is the long-term pool: leased, or waiting for a tenant.
    if (covered.has(unit.id)) {
      leased++;
    } else {
      vacant++;
      if (unit.status === 'long-term') markedLeasedWithoutTenancy.push(getUnitDisplayName(unit.number));
    }
  }

  const pool = leased + vacant;
  return {
    leased,
    vacant,
    pool,
    rate: pool > 0 ? Math.round((leased / pool) * 100) : null,
    ownerOccupied,
    shortLet,
    unavailable,
    markedLeasedWithoutTenancy
  };
}

export interface ShortLetOccupancy {
  /** Villas listed for short stays. The denominator, and Ro's "4 units". */
  villas: number;
  /** Of those, how many have a guest in them on the day. Ro's "1 is occupied". */
  occupied: number;
  /** Free to sell tonight. */
  available: number;
  /** occupied ÷ villas — 1 of 4 is 25%. Null when nothing is listed. */
  rate: number | null;
  /** Guest nights sold in the month, across those villas. */
  nightsSold: number;
  /** Villas × nights in the month: what there was to sell. */
  nightsAvailable: number;
  /**
   * nightsSold ÷ nightsAvailable. A **different measure** from `rate` and never
   * substituted for it: one asks what can be sold tonight, the other how much of
   * the month was sold. Both are shown, each labelled.
   */
  nightsRate: number | null;
  /** The month these night figures cover, so the figure cannot travel without it. */
  month: string;
}

/**
 * Short-let occupancy: villas taken, out of villas listed.
 *
 * `day` decides what is occupied *now*; `month` scopes the nights sold. They are
 * separate on purpose — the headline is about tonight's availability and the
 * nights are about how the month went.
 */
export function shortLetOccupancy(
  units: Unit[],
  bookings: Booking[],
  day: string = today(),
  month: string = monthOf(day)
): ShortLetOccupancy {
  const listed = units.filter(u => u.status === 'short-term');
  const ids = new Set(listed.map(u => u.id));

  // Blocked and Unavailable are calendar holds, not guests — the same rule the
  // operating statement and `occupiedUnitIdsOn` follow.
  const stays = bookings.filter(b => b.status !== 'cancelled' && b.source !== 'Blocked' && b.source !== 'Unavailable' && ids.has(b.unitId));

  const occupied = new Set(stays.filter(b => bookingCoversNight(b, day)).map(b => b.unitId)).size;

  const from = monthStart(month);
  const end = addDays(monthEnd(month), 1);
  let nightsSold = 0;
  for (const b of stays) {
    const start = b.checkIn > from ? b.checkIn : from;
    const finish = b.checkOut < end ? b.checkOut : end;
    nightsSold += Math.max(0, nightsBetween(start, finish));
  }

  const nightsInMonth = nightsBetween(from, end);
  const nightsAvailable = listed.length * nightsInMonth;

  return {
    villas: listed.length,
    occupied,
    available: Math.max(0, listed.length - occupied),
    rate: listed.length > 0 ? Math.round((occupied / listed.length) * 100) : null,
    nightsSold,
    nightsAvailable,
    nightsRate: nightsAvailable > 0 ? Math.round((nightsSold / nightsAvailable) * 100) : null,
    month
  };
}

export function occupancyOn(units: Unit[], tenancies: Tenancy[], bookings: Booking[], day: string = today()): OccupancyToday {
  const inResidence = occupiedUnitIdsOn(units, tenancies, bookings, day);

  let occupied = 0;
  let unavailable = 0;
  for (const unit of units) {
    if (unit.status === 'unavailable') {
      unavailable++;
      continue;
    }
    // The owner living in their own villa files no tenancy and no booking.
    if (inResidence.has(unit.id) || unit.status === 'owner-occupied') occupied++;
  }

  const lettable = units.length - unavailable;
  return {
    occupied,
    available: Math.max(0, lettable - occupied),
    unavailable,
    total: units.length,
    rate: lettable > 0 ? Math.round((occupied / lettable) * 100) : null
  };
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
    if (!(round2(tenancy.monthlyRent) > 0)) continue;

    const unit = units.find(u => u.id === tenancy.unitId);
    if (!unit) continue;
    const rent = rentBreakdown(unit, tenancy.monthlyRent, tenancy.currency || unit.currency).total;

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
   * **Part of the arithmetic.** This was previously excluded on the reasoning
   * that an owner is liable for what was *billed* whether or not they have paid
   * — which was inherited from the old, wrong model where the agent collected
   * the rent and withheld maintenance out of it. Under the real arrangement the
   * corporation collects nothing for a proprietor, so `collected` is always
   * zero and the net sat at minus the full contribution however much the owner
   * paid. A proprietor who had settled in full was shown "Due from ..." for the
   * whole amount on screen and on the printed statement, directly beside a note
   * saying the money had been received. Found on real data, 2026-09-01.
   *
   * What is deducted is therefore the contribution still *outstanding* for the
   * period, `maintenanceBilled - maintenancePaid`. Nothing is netted across
   * currencies: both figures are already scoped to this statement's currency.
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
  /**
   * collected − (maintenanceBilled − maintenancePaid) − utilityBilled − expenses.
   * Negative means the owner owes. A contribution billed and paid in the same
   * period nets to nothing here, which is the arithmetic the owner can follow.
   */
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
  /*
   * Strata costs only, as everywhere else a proprietor reads.
   *
   * This line on the statement means "work the corporation did on your villa and
   * is recharging to you". A cost ISPO paid on a villa it lets is its own
   * business expense and is recharged to nobody — putting it here would present
   * a proprietor with a bill that was never theirs.
   */
  const expenseItems = inPeriod(
    strataExpenses(expensesForUnit(expenses, unit, units)).filter(
      e => e.status === 'paid' && e.currency === currency && e.category !== 'Utilities'
    ),
    e => e.datePaid || e.date
  ).sort((a, b) => (a.datePaid || a.date).localeCompare(b.datePaid || b.date));
  const unitExpenses = total(expenseItems);

  // What they still owe the corporation, as at the end of the period — all time,
  // not just this period, because that is the figure an owner needs to see.
  const maintAccount = accountBalance(unit, 'Maintenance', charges, payments, to, units);
  const maintenanceOutstanding = maintAccount.currency === currency ? maintAccount.balance : 0;

  /*
   * The contribution still owed for this period, not the whole contribution.
   *
   * Subtracting `maintenanceBilled` alone told a proprietor who had paid in full
   * that they still owed all of it — see the note on `maintenancePaid`. Both
   * terms are in this statement's currency already, so this nets nothing across
   * currencies.
   */
  const maintenanceOwedForPeriod = subtractMoney(maintenanceBilled, maintenancePaid);

  const net = round2(collected - maintenanceOwedForPeriod - utilityBilled - unitExpenses);

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
export function form13CDebts(allExpenses: Expense[], asOf: string): { rows: Form13CRow[]; totalsByCurrency: { currency: Currency; buckets: AgeingBuckets }[] } {
  const byKey = new Map<string, Form13CRow>();

  /*
   * The Commission asks what the **body corporate** owes. A bill ISPO has not
   * yet paid is ISPO's creditor, not the corporation's, and declaring it on a
   * statutory return would overstate the corporation's liabilities to the
   * regulator.
   */
  for (const expense of strataExpenses(allExpenses)) {
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
  allExpenses: Expense[],
  currency: Currency,
  reportYear: number,
  options?: { budgetByCategory?: Record<string, number>; proposedFee?: number }
): AnnualOwnersReport {
  /*
   * The corporation's costs only, and this is the one that mattered most.
   *
   * `expenditure` here runs into `budgetExpenditure` and then into
   * `feeToCoverBudget`, which is the maintenance contribution this document puts
   * to the annual general meeting. Counting ISPO's vehicle insurance in it
   * charged sixteen proprietors, through their contribution, for the running of
   * a company vehicle they have nothing to do with.
   */
  const expenses = strataExpenses(allExpenses);
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

/* ------------------------------------------------------------------ *
 * Owners' monthly operations statement
 * ------------------------------------------------------------------ */

/** One common cost, as it appears on the statement sent to owners. */
export interface OperationsCostLine {
  id: string;
  date: string;
  vendor: string;
  description: string;
  reference: string;
  amount: number;
}

/** Common costs of one category, itemised. */
export interface OperationsCostGroup {
  category: ExpenseCategory;
  lines: OperationsCostLine[];
  total: number;
}

export interface OperationsStatement {
  currency: Currency;
  from: string;
  to: string;
  /** Maintenance contributions actually received in the period, net of refunds. */
  maintenanceCollected: number;
  /** Common costs settled in the period, grouped by category and itemised. */
  groups: OperationsCostGroup[];
  costsPaid: number;
  /** Money in less money out. Negative means the fund spent more than it took. */
  surplus: number;
  /**
   * Memo only, never netted into `surplus`: common bills falling due in the
   * period that were still unsettled. A month with a large unpaid bill would
   * otherwise read as a good month.
   */
  unpaidLines: OperationsCostLine[];
  costsUnpaid: number;
  /**
   * Memo only: spend excluded because it is tied to a specific villa and is
   * recharged to that owner. Reported as a total so that a cost miscategorised
   * against a villa shows up as a visible exclusion rather than vanishing.
   */
  villaRecharged: number;
  villaRechargedCount: number;
  /** True when nothing at all — no contributions, no costs — falls in the period. */
  empty: boolean;
}

/**
 * Is this a common cost of running the property, as opposed to work on one
 * villa that is recharged to its owner?
 *
 * Deliberately strict. An expense is common only when it is tied to no villa
 * (`unitId` empty) *and* its allocation is a property location or blank.
 * Anything else — including the contradictory state of an empty `unitId` beside
 * a villa number — falls to the recharged memo, where it is counted and shown
 * rather than silently dropped from both sides of the statement.
 */
function isCommonCost(expense: Expense): boolean {
  if (expense.unitId) return false;
  const where = expense.unitNumber || '';
  return where === '' || (PROPERTY_LOCATIONS as readonly string[]).includes(where);
}

function toCostLine(expense: Expense, date: string): OperationsCostLine {
  return {
    id: expense.id,
    date,
    vendor: expense.vendor,
    description: expense.description,
    reference: expense.reference,
    amount: expense.amount
  };
}

/**
 * What the owners are told each month: the maintenance collected, every common
 * cost it paid for, and what is left.
 *
 * Cash in, cash out, both on the same basis, so the surplus reconciles to the
 * bank. Costs incurred but unpaid are carried as a memo instead of being mixed
 * into that figure — see `unpaidLines`.
 *
 * Villa-specific work is excluded: it is recharged to the owner concerned and
 * appears on that owner's own statement, and itemising it here would show all
 * sixteen owners what was done to each other's villas.
 */
export function operationsStatement(
  allExpenses: Expense[],
  payments: Payment[],
  currency: Currency,
  start: string,
  end: string
): OperationsStatement {
  const maintenanceCollected = collectedInPeriod(payments, currency, start, end).maintenance;

  /*
   * The corporation's costs only. This document tells sixteen proprietors what
   * their contributions paid for, so ISPO's cell phone has no business on it —
   * and before the two books existed it was on it, under "Utilities".
   */
  const expenses = strataExpenses(allExpenses);

  const inCurrency = expenses.filter(e => e.currency === currency);
  const paidInPeriod = inCurrency.filter(e => e.status === 'paid' && isWithin(e.datePaid || e.date, start, end));
  const pendingInPeriod = inCurrency.filter(e => e.status === 'pending' && isWithin(e.dueDate || e.date, start, end));

  const commonPaid = paidInPeriod.filter(isCommonCost);
  const rechargedPaid = paidInPeriod.filter(e => !isCommonCost(e));

  const byCategory = new Map<ExpenseCategory, OperationsCostLine[]>();
  for (const expense of commonPaid) {
    const lines = byCategory.get(expense.category) || [];
    lines.push(toCostLine(expense, expense.datePaid || expense.date));
    byCategory.set(expense.category, lines);
  }

  const groups: OperationsCostGroup[] = Array.from(byCategory.entries())
    .map(([category, lines]) => ({
      category,
      lines: lines.slice().sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor)),
      total: sumMoney(lines.map(l => l.amount))
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const costsPaid = sumMoney(groups.map(g => g.total));

  const unpaidLines = pendingInPeriod
    .filter(isCommonCost)
    .map(e => toCostLine(e, e.dueDate || e.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor));

  const villaRecharged = sumMoney(rechargedPaid.map(e => e.amount));

  return {
    currency,
    from: start,
    to: end,
    maintenanceCollected,
    groups,
    costsPaid,
    surplus: subtractMoney(maintenanceCollected, costsPaid),
    unpaidLines,
    costsUnpaid: sumMoney(unpaidLines.map(l => l.amount)),
    villaRecharged,
    villaRechargedCount: rechargedPaid.length,
    empty: maintenanceCollected === 0 && costsPaid === 0 && unpaidLines.length === 0 && rechargedPaid.length === 0
  };
}

/* ------------------------------------------------------------------ *
 * Operating statement — income and expenditure
 * ------------------------------------------------------------------ */

/** One receipt, as it appears on the income side. */
export interface IncomeLine {
  id: string;
  date: string;
  /** Who paid. Named, because "Maintenance 20,000" answers nothing at a meeting. */
  payer: string;
  villa: string;
  reference: string;
  amount: number;
}

/** One payment out, as it appears on the expenditure side. */
export interface ExpenditureLine {
  id: string;
  date: string;
  /**
   * Who was paid.
   *
   * This is the whole point of the document. A line reading "Payroll 20,000"
   * tells the strata corporation nothing; "Payroll — Darryl Whyte 20,000" is a
   * figure somebody can question, verify, or approve. The category classes it;
   * the name identifies it.
   */
  payee: string;
  description: string;
  /** Villa, or General / Office, so it is clear what the money was spent on. */
  allocation: string;
  reference: string;
  amount: number;
}

export interface StatementGroup<T> {
  label: string;
  /** Empty when the class is shown as a total only. */
  lines: T[];
  total: number;
  /**
   * Whether the individual payments are shown, or only the total for the class.
   *
   * Maintenance contributions are the case that forced this: internally the
   * office wants to see who paid what, but the statement that goes to the strata
   * corporation should show one figure for contributions — naming every
   * proprietor and their payment on a document circulated to the council is more
   * disclosure than the meeting needs.
   */
  itemised: boolean;
}

/** How a class of income or expenditure appears on the statement. */
export type LineVisibility = 'itemised' | 'total' | 'excluded';

/**
 * What goes on the statement.
 *
 * The same period produces two legitimately different documents: the one carried
 * to the strata corporation, and the one the office reads. Short-stay rental is
 * the clearest example — on villas the corporation lets on its own account it is
 * real income the office must see, and it has no place on a council statement
 * about the corporation's common finances.
 *
 * Anything not named here falls to the defaults, which are `itemised` on both
 * sides — so a caller passing nothing gets the whole statement, and a class that
 * did not exist when the options were written appears rather than silently
 * vanishing.
 */
export interface OperatingStatementOptions {
  income?: Partial<Record<PaymentCategory, LineVisibility>>;
  expenditure?: Record<string, LineVisibility>;
  defaultIncome?: LineVisibility;
  defaultExpenditure?: LineVisibility;
  /**
   * Which book to read. Absent means `everything`, so a caller that predates
   * the split still gets the combined statement it has always got.
   *
   * This is not a line-visibility choice and could not be one. Hiding a class of
   * income leaves the money in the totals of the other side; reading one book
   * changes which money is on the page at all, on **both** sides, and the two
   * must move together or the surplus is an arithmetic statement about nothing.
   */
  book?: ReportBook;
}

export interface OperatingStatement {
  currency: Currency;
  from: string;
  to: string;
  /** The book this statement was read on. Named on the printed page. */
  book: ReportBook;
  income: StatementGroup<IncomeLine>[];
  totalIncome: number;
  expenditure: StatementGroup<ExpenditureLine>[];
  totalExpenditure: number;
  /**
   * The same expenditure split between the two books, because this statement
   * carries both.
   *
   * Ro keeps this document combined — *"it is my all in view for the entire
   * business which is important"* — which is a legitimate thing to want and a
   * dangerous thing to leave unlabelled: it is printed on the corporation's
   * letterhead, and a reader has no way to tell the fund's costs from ISPO's
   * without being told. These two always sum to `totalExpenditure`.
   */
  strataExpenditure: number;
  ispoExpenditure: number;
  /**
   * The maintenance ISPO paid on the villas it lets, inside this period.
   *
   * **The one figure on this page that is the same money twice.** It is income
   * to the corporation and a cost to ISPO, so on a combined statement it appears
   * on both sides — correctly, since both entities genuinely moved it, and it
   * nets to nothing across the two. It is stated so that anyone reading the
   * gross totals knows this much of them is one transfer between the two books
   * rather than money that entered or left the group.
   *
   * Taken from the payment ledger, never from an expense row: it is a
   * contribution receipted against a villa, and there is no second record of it
   * anywhere. Counting an expense here as well would be the double count.
   */
  internalTransfer: number;
  /** Income less expenditure. Negative is a deficit for the period. */
  surplus: number;
  /** True when neither side has a single line in this currency. */
  empty: boolean;
  /**
   * Classes deliberately left off this statement, and what they came to.
   *
   * Named on the document rather than silently dropped. A statement that quietly
   * omits a class of income is not a narrower statement, it is a misleading one:
   * anyone reconciling it against the bank would find money they cannot account
   * for. Saying "short-stay bookings, excluded" costs one line and makes the
   * scope of the document explicit.
   */
  excludedIncome: { label: string; total: number }[];
  excludedExpenditure: { label: string; total: number }[];
}

/**
 * The document the strata corporation is given: what came in, what went out.
 *
 * Deliberately narrower than the management statement beside it. A council
 * meeting wants income and expenditure and nothing else — no receivables ageing,
 * no collection rates, no occupancy. Those belong in the management pack and get
 * in the way here.
 *
 * Two rules shape it:
 *
 *   1. **Every figure is itemised and named.** Expenditure is classed by
 *      category and then listed line by line with the payee on each line, so
 *      "Payroll" is a heading rather than a lump. Nothing is presented only as a
 *      total.
 *   2. **The currencies never meet.** One statement per currency, computed
 *      independently. Nothing here converts, adds across, or shows a combined
 *      total, because the corporation genuinely holds two separate pots.
 *
 * Cash basis on both sides — money actually received against money actually
 * paid — so the surplus is a figure that reconciles to the bank rather than an
 * accrual that has to be explained.
 */
export function operatingStatement(
  allPayments: Payment[],
  allExpenses: Expense[],
  units: Unit[],
  currency: Currency,
  start: string,
  end: string,
  options: OperatingStatementOptions = {}
): OperatingStatement {
  /*
   * The book is applied here, at the top, before anything is counted — not by
   * the caller and not at the end.
   *
   * Ro, 2026-09-28: the strata copy of this statement was printing ISPO's phone
   * and company vehicle as the corporation's expenditure, and rent as its
   * income. `strataExpenditure` and `ispoExpenditure` below had always *named*
   * the split under a combined total, which is a label, not a filter: the figure
   * a council was asked to approve still had both books inside it.
   *
   * Filtering inside the function is the standing rule for this codebase (see
   * the note on the two books above). A screen written next year that passes the
   * raw arrays gets `everything` — the same combined statement as before, never a
   * half-filtered one.
   */
  const book: ReportBook = options.book ?? 'everything';
  const payments = paymentsInBook(allPayments, book);
  const expenses = expensesInBook(allExpenses, book);

  /*
   * The villas VDS lets on the corporation's own account, needed here rather
   * than further down because the ISPO book has to keep a contribution typed
   * into the expense register out of its own costs — see `isTheContributionAgain`
   * below and the identical rule in `ispoOperations`.
   */
  const ownAccount = ownAccountUnitIds(units, currency);

  const incomeVisibility = (category: PaymentCategory): LineVisibility =>
    options.income?.[category] ?? options.defaultIncome ?? 'itemised';
  const expenditureVisibility = (category: string): LineVisibility =>
    options.expenditure?.[category] ?? options.defaultExpenditure ?? 'itemised';

  const excludedIncome: { label: string; total: number }[] = [];
  const excludedExpenditure: { label: string; total: number }[] = [];

  const villaOf = (unitId: string, unitNumber: string) => {
    const unit = units.find(u => u.id === unitId);
    const number = unit?.number || unitNumber || '';
    return number ? getUnitDisplayName(number) : '';
  };

  /* ---------------- income ---------------- */

  const completed = payments.filter(p => p.status === 'completed' && p.currency === currency);
  const received = completed.filter(p => isWithin(p.date, start, end));

  /*
   * Refunds are shown as their own negative lines, dated when the money went
   * back out, rather than quietly reducing the receipt they came from. A council
   * reading a smaller figure than last month should be able to see why on the
   * page instead of having to ask.
   */
  const refunded = completed.filter(p => p.refundedOn && isWithin(p.refundedOn, start, end));

  const INCOME_LABELS: { category: PaymentCategory; label: string }[] = [
    { category: 'Maintenance', label: 'Maintenance contributions' },
    { category: 'Rent', label: 'Rent' },
    { category: 'Booking', label: 'Short-stay bookings' },
    { category: 'Utility', label: 'Utilities recovered' },
    { category: 'Other', label: 'Other income' }
  ];

  const income: StatementGroup<IncomeLine>[] = [];
  for (const { category, label } of INCOME_LABELS) {
    const lines: IncomeLine[] = received
      .filter(p => p.category === category)
      .map(p => ({
        id: p.id,
        date: p.date,
        payer: p.payerName || 'not recorded',
        villa: villaOf(p.unitId, p.unitNumber),
        reference: p.receiptNo || '',
        amount: p.amount
      }));

    for (const p of refunded.filter(r => r.category === category)) {
      lines.push({
        id: `${p.id}-refund`,
        date: p.refundedOn || p.date,
        payer: `${p.payerName || 'payer'}, refunded${p.refundReason ? ` (${p.refundReason})` : ''}`,
        villa: villaOf(p.unitId, p.unitNumber),
        reference: p.receiptNo || '',
        amount: -refundedAsOf(p)
      });
    }

    if (lines.length === 0) continue;
    lines.sort((a, b) => a.date.localeCompare(b.date) || a.payer.localeCompare(b.payer));
    const total = sumMoney(lines.map(l => l.amount));

    const visibility = incomeVisibility(category);
    if (visibility === 'excluded') {
      excludedIncome.push({ label, total });
      continue;
    }
    income.push({ label, lines: visibility === 'itemised' ? lines : [], total, itemised: visibility === 'itemised' });
  }

  const totalIncome = sumMoney(income.map(g => g.total));

  /* ---------------- expenditure ---------------- */

  /*
   * Everything the corporation actually paid in the period, whatever it was
   * spent on. Work recharged to a villa is included — it is money that left the
   * corporation's account — and its allocation is named on the line, so the
   * recovery appearing on the income side can be matched against it.
   */
  const settled = expenses.filter(e => e.status === 'paid' && e.currency === currency && isWithin(e.datePaid || e.date, start, end));

  /**
   * Is this cost row actually the monthly contribution, already counted from its
   * receipt?
   *
   * Only asked on the ISPO book, and only there because that book's income and
   * costs must agree with `ispoOperations` — which applies exactly this rule — by
   * construction rather than by coincidence. A plumber on one of ISPO's villas is
   * a genuine ISPO cost; a **Maintenance**-category row against a villa VDS lets
   * on its own account is the contribution, which has a receipt.
   *
   * The combined book is left exactly as it was: Ro keeps `everything` as his
   * all-in view and nothing is quietly removed from a figure he already reads.
   */
  const isTheContributionAgain = (e: Expense): boolean =>
    book === 'ispo' && isContributionCountedFromReceipts(e, ownAccount);

  const contributionAgain = settled.filter(isTheContributionAgain);
  const paid = settled.filter(e => !isTheContributionAgain(e));

  const byCategory = new Map<string, ExpenditureLine[]>();
  for (const e of paid) {
    const lines = byCategory.get(e.category) || [];
    lines.push({
      id: e.id,
      date: e.datePaid || e.date,
      payee: e.vendor || 'not recorded',
      description: e.description || '',
      allocation: e.unitId ? villaOf(e.unitId, e.unitNumber) : e.unitNumber || 'General',
      reference: e.reference || '',
      amount: e.amount
    });
    byCategory.set(e.category, lines);
  }

  const expenditure: StatementGroup<ExpenditureLine>[] = Array.from(byCategory.entries())
    .map(([label, lines]) => {
      const total = sumMoney(lines.map(l => l.amount));
      const visibility = expenditureVisibility(label);
      return {
        label,
        lines:
          visibility === 'itemised'
            ? lines.slice().sort((a, b) => a.date.localeCompare(b.date) || a.payee.localeCompare(b.payee))
            : [],
        total,
        itemised: visibility === 'itemised',
        visibility
      };
    })
    .filter(g => {
      if (g.visibility !== 'excluded') return true;
      excludedExpenditure.push({ label: g.label, total: g.total });
      return false;
    })
    .map(({ visibility: _visibility, ...group }) => group)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

  /*
   * The split, computed from the same `paid` set the statement itself used, so
   * the two parts cannot disagree with the whole they came from. Anything the
   * options excluded is excluded from both, for the same reason.
   */
  // Keyed on the category, which is what a group is and what the options
  // exclude. Reading the ids off `expenditure` instead would have silently
  // dropped every summary-visibility group, whose `lines` array is empty by
  // design — the split would then not have summed to the total it sits under.
  const excludedCategories = new Set(excludedExpenditure.map(g => g.label));
  const countedForSplit = paid.filter(e => !excludedCategories.has(e.category));

  /*
   * The contribution ISPO paid on its own villas — the one figure that is the
   * same money on both sides of a combined page. Read off the receipts, on the
   * villas flagged as let on VDS's own account, so it agrees with the shortfall
   * report by construction rather than by coincidence.
   *
   * Taken from `allPayments`, deliberately: on the ISPO book a maintenance
   * receipt is not ISPO's income and has been filtered out of `payments` above,
   * yet it is precisely the money ISPO paid over and this figure must still be
   * the same money on every book.
   */
  const internalTransfer = netReceivedInPeriod(
    allPayments.filter(p => p.currency === currency && p.category === 'Maintenance' && ownAccount.has(p.unitId)),
    start,
    end
  );

  /*
   * On the ISPO book that transfer is a real cost, and there is no expense row
   * for it anywhere — it exists only as a receipt the corporation issued. Without
   * it the ISPO book would show rent as profit and none of the maintenance it is
   * funded from, and its surplus would not equal `ispoOperations.net` on the same
   * period. `test/two-books-reports.test.mjs` compares the two.
   */
  if (book === 'ispo' && internalTransfer !== 0) {
    expenditure.push({
      label: 'Maintenance contributions paid to the corporation',
      lines: [],
      total: internalTransfer,
      itemised: false
    });
    expenditure.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }

  const totalExpenditure = sumMoney(expenditure.map(g => g.total));

  /*
   * Anything the ISPO book dropped as already-receipted is named here rather than
   * removed in silence — the standing rule in this codebase. Without the line, a
   * register showing a Maintenance cost against an own-account villa and a
   * statement that does not carry it would look like a fault.
   */
  if (contributionAgain.length > 0) {
    excludedExpenditure.push({
      label: 'Contributions typed into the cost register (counted from their receipts instead)',
      total: sumMoney(contributionAgain.map(e => e.amount))
    });
  }

  const strataExpenditure = sumMoney(strataExpenses(countedForSplit).map(e => e.amount));
  const ispoExpenditure = sumMoney([
    sumMoney(ispoExpenses(countedForSplit).map(e => e.amount)),
    book === 'ispo' ? internalTransfer : 0
  ]);

  return {
    currency,
    book,
    from: start,
    to: end,
    income,
    totalIncome,
    expenditure,
    totalExpenditure,
    strataExpenditure,
    ispoExpenditure,
    internalTransfer,
    surplus: subtractMoney(totalIncome, totalExpenditure),
    empty:
      income.length === 0 &&
      expenditure.length === 0 &&
      excludedIncome.length === 0 &&
      excludedExpenditure.length === 0,
    excludedIncome,
    excludedExpenditure
  };
}


/* ------------------------------------------------------------------ *
 * ISPO Operations — the letting company's own position
 * ------------------------------------------------------------------ */

export interface IspoCostLine {
  id: string;
  date: string;
  vendor: string;
  description: string;
  /** Villa, or General / Office, so it is clear what the money went on. */
  allocation: string;
  reference: string;
  amount: number;
}

export interface IspoCostGroup {
  category: ExpenseCategory;
  lines: IspoCostLine[];
  total: number;
}

export interface IspoOperations {
  currency: Currency;
  from: string;
  to: string;

  /** Rent receipted in the period. */
  rentReceived: number;
  /** Short-stay booking receipts in the period. */
  bookingReceived: number;
  totalIncome: number;

  /** ISPO's own costs, paid in the period, by category. */
  groups: IspoCostGroup[];
  ownCostsPaid: number;

  /**
   * The maintenance contribution ISPO paid on the villas it lets.
   *
   * Ro, 2026-09-03, asked for this on the statement: on the villas VDS lets, the
   * contribution is funded out of the rent, so it is a genuine cost of letting
   * and leaving it off would flatter the letting business by the whole of it.
   *
   * **Read from the receipts, never from an expense row.** A contribution is a
   * payment against a villa's maintenance account and has exactly one record. If
   * somebody also enters it in the expense register, the self-check says so
   * (`contribution-entered-as-a-cost`) rather than this statement quietly
   * counting it twice.
   */
  maintenanceOnOwnVillas: number;
  /** Villas this was counted on, so the figure can be checked against the register. */
  ownAccountVillas: string[];
  /**
   * Rent and short-stay taken on villas **not** ticked as let on VDS's own
   * account, and the villas it came from.
   *
   * Income here is every rent and booking receipt, because the corporation never
   * collects a proprietor's rent — they let their own villas entirely on their
   * own account — so any rent in this system is money ISPO collected. The
   * contribution line, by contrast, is scoped to the ticked villas, because it is
   * specifically the contribution on the villas VDS lets.
   *
   * The two scopes are therefore different on purpose, and where they diverge the
   * shortfall report and this statement will quote different rent figures for the
   * same month. **Found by the 5,000-operation simulation**, which compared them
   * and was right to.
   *
   * Rather than let a reader discover that by subtracting one document from
   * another, the difference is stated here. In practice it means one of two
   * things and both are worth knowing: a villa VDS lets that nobody has ticked
   * yet, or rent recorded against a proprietor's villa, which the business model
   * says should not happen.
   */
  incomeFromUnflaggedVillas: number;
  unflaggedVillasWithIncome: string[];
  /**
   * Cost rows left out of `ownCostsPaid` because they *are* the contribution.
   *
   * `maintenanceOnOwnVillas` is read from the receipts. If somebody also types
   * the contribution into the expense register as an ISPO cost — and there is
   * nothing stopping them, it looks like an ordinary bill — then counting the
   * cost row as well would put the same money into this statement twice.
   *
   * So the statement does not merely *detect* that shape, it is immune to it: a
   * paid ISPO cost categorised Maintenance against a villa let on VDS's own
   * account is the contribution by definition, and it is excluded here and
   * **named**, never silently dropped. The self-check raises
   * `contribution-entered-as-a-cost` as well, so the stray row gets tidied up
   * rather than living on as a permanent exclusion.
   */
  excludedAsContribution: number;
  excludedAsContributionCount: number;
  /**
   * True when no villa is flagged as let on VDS's own account.
   *
   * Not the same as "nothing was paid": the flag is ticked by hand and nothing
   * guesses it from an owner's name. Said on the page, because a silent zero
   * here reads as "ISPO pays no contributions", which is a different claim.
   */
  noVillasFlagged: boolean;

  totalCosts: number;
  /** Income less every cost. Negative means letting did not cover itself. */
  net: number;

  /** Memo, never netted: ISPO's bills that fell due in the period and are unpaid. */
  unpaidLines: IspoCostLine[];
  costsUnpaid: number;

  /** True when neither side has anything in this currency. */
  empty: boolean;
}

/**
 * What the letting business took and what it spent.
 *
 * Ro, 2026-09-03: *"Ispo, the company that owns VDS is the company who collects
 * the Rent payments, there are certain expenses, such as Cell phone bills,
 * company vehicle expenses and insurance and other expenses that are paid from
 * the rental income."*
 *
 * The mirror of `operationsStatement`, which is the corporation's side. Between
 * them every cost in the register is counted exactly once, because a cost is in
 * one book or the other and `fundOf` has no third answer — an identity asserted
 * directly in `test/two-books.test.mjs` rather than left as a claim.
 *
 * **Income is every rent and short-stay receipt.** Not only those on flagged
 * villas: the corporation never collects a proprietor's rent — they let their
 * own villas entirely on their own account — so any rent in this system is
 * money ISPO collected. `maintenanceOnOwnVillas` is the one figure that does
 * depend on the flag, because it is specifically the contribution on the villas
 * VDS lets, and it says so when no villa is flagged.
 *
 * Cash basis on both sides, like every other statement here, so the net
 * reconciles to the bank rather than to an accrual.
 */
export function ispoOperations(
  allExpenses: Expense[],
  payments: Payment[],
  units: Unit[],
  currency: Currency,
  start: string,
  end: string
): IspoOperations {
  const collected = collectedInPeriod(payments, currency, start, end);
  const rentReceived = collected.rent;
  const bookingReceived = collected.booking;
  const totalIncome = sumMoney([rentReceived, bookingReceived]);

  const inCurrency = ispoExpenses(allExpenses).filter(e => e.currency === currency);
  const paid = inCurrency.filter(e => e.status === 'paid' && isWithin(e.datePaid || e.date, start, end));
  const pending = inCurrency.filter(e => e.status === 'pending' && isWithin(e.dueDate || e.date, start, end));

  const villaOf = (expense: Expense): string => {
    if (!expense.unitId) return expense.unitNumber || 'General';
    const unit = units.find(u => u.id === expense.unitId);
    return getUnitDisplayName(unit?.number || expense.unitNumber || '');
  };

  const toLine = (expense: Expense, date: string): IspoCostLine => ({
    id: expense.id,
    date,
    vendor: expense.vendor,
    description: expense.description,
    allocation: villaOf(expense),
    reference: expense.reference,
    amount: expense.amount
  });

  /*
   * The own-account villas, needed before the cost groups are built because a
   * contribution typed into the register has to be kept out of them.
   */
  const ownAccountUnits = units.filter(u => u.letOnOwnAccount === true);
  const inThisCurrency = ownAccountUnits.filter(u => (u.maintCurrency || u.currency) === currency);
  const ownIds = ownAccountUnitIds(units, currency);

  /**
   * Is this cost row actually the contribution, already counted from receipts?
   *
   * A plumber or a locksmith on one of ISPO's villas is a genuine ISPO cost and
   * belongs in the groups. A **Maintenance**-category row against a villa VDS
   * lets on its own account is the monthly contribution, which has a receipt and
   * is counted from it — the one shape that would be the same money twice.
   */
  const isTheContributionAgain = (expense: Expense): boolean => isContributionCountedFromReceipts(expense, ownIds);

  const duplicated = paid.filter(isTheContributionAgain);
  const ownCosts = paid.filter(e => !isTheContributionAgain(e));

  const byCategory = new Map<ExpenseCategory, IspoCostLine[]>();
  for (const expense of ownCosts) {
    const lines = byCategory.get(expense.category) || [];
    lines.push(toLine(expense, expense.datePaid || expense.date));
    byCategory.set(expense.category, lines);
  }

  const groups: IspoCostGroup[] = Array.from(byCategory.entries())
    .map(([category, lines]) => ({
      category,
      lines: lines.slice().sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor)),
      total: sumMoney(lines.map(l => l.amount))
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const ownCostsPaid = sumMoney(groups.map(g => g.total));

  /*
   * The contribution ISPO paid on its own villas, off the receipts.
   *
   * Only where the villa is billed maintenance in this currency, so a villa
   * assessed in US dollars contributes nothing to the Jamaican statement rather
   * than a converted figure — the rule the whole application keeps.
   */
  const maintenanceOnOwnVillas = netReceivedInPeriod(
    payments.filter(p => p.currency === currency && p.category === 'Maintenance' && ownIds.has(p.unitId)),
    start,
    end
  );

  /*
   * How much of the income above came from villas nobody has ticked as let on
   * VDS's own account. Stated, never quietly dropped — see the field's note.
   */
  const flaggedForIncome = new Set(units.filter(u => u.letOnOwnAccount === true && u.currency === currency).map(u => u.id));
  const unflaggedReceipts = payments.filter(
    p =>
      p.currency === currency &&
      (p.category === 'Rent' || p.category === 'Booking') &&
      !flaggedForIncome.has(p.unitId)
  );
  const incomeFromUnflaggedVillas = netReceivedInPeriod(unflaggedReceipts, start, end);
  const unflaggedVillasWithIncome = [
    ...new Set(
      unflaggedReceipts
        .filter(p => p.status === 'completed' && isWithin(p.date, start, end))
        .map(p => {
          const unit = units.find(u => u.id === p.unitId);
          return getUnitDisplayName(unit?.number || p.unitNumber || '');
        })
        .filter(Boolean)
    )
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const unpaidLines = pending
    .filter(e => !isTheContributionAgain(e))
    .map(e => toLine(e, e.dueDate || e.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor));

  const totalCosts = sumMoney([ownCostsPaid, maintenanceOnOwnVillas]);

  return {
    currency,
    from: start,
    to: end,
    rentReceived,
    bookingReceived,
    totalIncome,
    groups,
    ownCostsPaid,
    maintenanceOnOwnVillas,
    ownAccountVillas: inThisCurrency.map(u => getUnitDisplayName(u.number)),
    excludedAsContribution: sumMoney(duplicated.map(e => e.amount)),
    excludedAsContributionCount: duplicated.length,
    incomeFromUnflaggedVillas,
    unflaggedVillasWithIncome,
    noVillasFlagged: ownAccountUnits.length === 0,
    totalCosts,
    net: subtractMoney(totalIncome, totalCosts),
    unpaidLines,
    costsUnpaid: sumMoney(unpaidLines.map(l => l.amount)),
    empty: totalIncome === 0 && totalCosts === 0 && unpaidLines.length === 0
  };
}

/* ------------------------------------------------------------------ *
 * The out-of-pocket shortfall — VDS's own trading position
 * ------------------------------------------------------------------ */

/**
 * What VDS funded out of its own pocket on the villas it lets.
 *
 * Designed 2026-09-02 and built on Ro's yes. The funding model it measures is
 * not in the ledger anywhere: on the villas VDS lets on its own account the
 * maintenance contribution is paid out of what that villa earns, so a month
 * that earns nothing is a month VDS finds the contribution from somewhere else.
 * The application bills maintenance on a vacant villa perfectly correctly — it
 * simply has no concept that the letting income was what paid it.
 *
 * **Short-stay income counts, and it counts because Ro said so.** The first cut
 * of this engine offset the contribution with long-term rent alone and carried
 * booking receipts as a memo, which is how the design was written. Ro, reading
 * it: *"when a unit is vacant or under short term/airbnb Villaggio still has to
 * cover that cost"* — a villa that earned US$900 on Airbnb in a month its
 * contribution was US$200 did not cost VDS anything, and a report saying
 * otherwise overstates the shortfall on exactly the villas the report exists to
 * judge. **What the villa earned is rent plus short-stay receipts.** The two are
 * still shown in their own columns, because "is this villa worth letting?" is a
 * different question from "how was it let?".
 *
 * **This is not a strata document.** The operating statement is the
 * corporation's income and expenditure; this is VDS's own position as a
 * landlord, and the two must not appear on one page. They are different
 * entities and a reader who conflates them has been misled.
 *
 * Cash basis on both sides, matching the operating statement: rent counted when
 * it was received, the contribution counted when it was paid, refunds
 * subtracted on the day the money went back out. An accrual would answer a
 * different question ("what was owed?"); the question here is "how much cash
 * did we have to find?".
 *
 * One currency per report and never combined, for the same reason as
 * everywhere else in this system: J$ and US$ are not the same money and
 * subtracting one from the other would invent a number. A villa whose rent and
 * contribution are denominated differently cannot have a shortfall computed at
 * all, so it is named in `currencyNotes` rather than quietly given one.
 */
export interface ShortfallLine {
  unitId: string;
  villa: string;
  month: string;
  /** Days in this month, within the reported period, that the villa was let. */
  occupiedDays: number;
  /** Days of this month that fall inside the period — the denominator. */
  daysCounted: number;
  rentReceived: number;
  /** Short-stay and Airbnb receipts. Earnings like any other — see the note above. */
  shortStayReceived: number;
  /** Rent plus short-stay: everything the villa earned VDS in the month. */
  earned: number;
  maintenancePaid: number;
  /** What VDS funded: the contribution paid over and above what the villa earned. */
  shortfall: number;
  /** No let at all in this month, which is the case the report was asked for. */
  vacant: boolean;
}

export interface ShortfallVillaRow {
  unitId: string;
  villa: string;
  months: number;
  occupiedDays: number;
  daysCounted: number;
  rentReceived: number;
  shortStayReceived: number;
  earned: number;
  maintenancePaid: number;
  shortfall: number;
  vacantMonths: string[];
}

export interface ShortfallMonthRow {
  month: string;
  rentReceived: number;
  shortStayReceived: number;
  earned: number;
  maintenancePaid: number;
  shortfall: number;
  /** Which villas were empty that month, named — a count alone is not actionable. */
  vacantVillas: string[];
}

export interface ShortfallReport {
  currency: Currency;
  from: string;
  to: string;
  months: string[];
  /** Every villa-month, the grain both views are folded from. */
  lines: ShortfallLine[];
  byVilla: ShortfallVillaRow[];
  byMonth: ShortfallMonthRow[];
  totalRentReceived: number;
  totalShortStayReceived: number;
  totalEarned: number;
  totalMaintenancePaid: number;
  totalShortfall: number;
  /**
   * Every villa-month that cost VDS something, named, whether the villa stood
   * empty all month or was let and simply did not earn its contribution.
   *
   * The headline figure is useless without this list, and restricting the list
   * to wholly-empty months would hide the short-let month that earned less than
   * it cost — which is the case Ro raised when he asked whether short-stay
   * income was counted at all.
   */
  fundedMonths: { unitId: string; villa: string; month: string; shortfall: number; vacant: boolean }[];
  /**
   * How many villa-months produced the total, counted over the months that
   * actually cost something rather than over every month in the period. A month
   * in which no contribution was paid cost nothing, and counting it made the
   * headline read "J$80,000 across 13 villa-months" above a list of four — the
   * sentence and the list have to describe the same months.
   */
  fundedVillaMonths: number;
  /** The subset of the above where the villa was empty for the whole month. */
  vacantShortfall: number;
  vacantVillaMonths: number;
  /**
   * Villas whose rent and contribution are in different currencies.
   *
   * Deliberately given no shortfall rather than a converted one. Stated on the
   * page and in the export so a villa cannot drop out of the report in silence.
   */
  currencyNotes: { unitId: string; villa: string; rentCurrency: Currency; maintCurrency: Currency }[];
  /** No villa is let on VDS's own account in this currency at all. */
  noneFlagged: boolean;
  empty: boolean;
}

/**
 * Money actually received for one villa, in one category, in one month.
 *
 * Refunds are subtracted on the day they went back out, not against the receipt
 * they came from, so the figure agrees with the bank for the month in question —
 * the same treatment the operating statement gives them.
 */
function receivedInMonth(payments: Payment[], category: PaymentCategory, month: string, start: string, end: string): number {
  let total = 0;
  for (const p of payments) {
    if (p.status !== 'completed' || p.category !== category) continue;
    if (isWithin(p.date, start, end) && monthOf(p.date) === month) total = addMoney(total, p.amount);
    if (p.refundedOn && isWithin(p.refundedOn, start, end) && monthOf(p.refundedOn) === month) {
      total = subtractMoney(total, refundedAsOf(p));
    }
  }
  return round2(total);
}

export function outOfPocketShortfall(
  units: Unit[],
  tenancies: Tenancy[],
  bookings: Booking[],
  payments: Payment[],
  currency: Currency,
  start: string,
  end: string
): ShortfallReport {
  const months = monthsBetween(start, end);

  /*
   * Only villas VDS lets on its own account, and only where this currency is
   * one the villa actually deals in. A villa billed entirely in US dollars has
   * no place on the Jamaican dollar report, and padding it in with zeroes would
   * read as a villa that cost nothing.
   */
  const flagged = units.filter(u => u.letOnOwnAccount === true);
  const mine = flagged.filter(u => u.currency === currency || (u.maintCurrency || u.currency) === currency);

  const currencyNotes = mine
    .filter(u => (u.maintCurrency || u.currency) !== u.currency)
    .map(u => ({
      unitId: u.id,
      villa: getUnitDisplayName(u.number),
      rentCurrency: u.currency,
      maintCurrency: (u.maintCurrency || u.currency) as Currency
    }));
  /*
   * A villa whose rent and contribution are denominated differently is left off
   * the rows entirely rather than given half a row. Counting its rent while its
   * contribution is invisible would put a figure into the totals that answers no
   * question, and computing a shortfall across two currencies would invent one.
   * It is named in `currencyNotes` instead, so it cannot drop out in silence.
   */
  const mismatched = new Set(currencyNotes.map(n => n.unitId));
  const usable = mine.filter(u => !mismatched.has(u.id));

  /*
   * Occupied days are counted from the dated records, one day at a time, rather
   * than from `unit.status` — a status flag has no history and would answer
   * every past month with today's answer. `occupiedUnitIdsOn` counts a villa as
   * let when a tenancy covers the day or a guest is in residence that night.
   */
  const occupiedDays = new Map<string, number>(); // `${unitId}|${month}`
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const occupied = occupiedUnitIdsOn(units, tenancies, bookings, day);
    const month = monthOf(day);
    for (const unit of usable) {
      if (!occupied.has(unit.id)) continue;
      const key = `${unit.id}|${month}`;
      occupiedDays.set(key, (occupiedDays.get(key) || 0) + 1);
    }
  }

  // Computed once per month, not once per villa-month: the same span of days
  // for every villa, and the period can run to a full year.
  const daysCounted = new Map<string, number>();
  for (const month of months) {
    let days = 0;
    for (let day = monthStart(month); day <= monthEnd(month); day = addDays(day, 1)) {
      if (isWithin(day, start, end)) days++;
    }
    daysCounted.set(month, days);
  }

  const lines: ShortfallLine[] = [];
  for (const unit of usable) {
    const villa = getUnitDisplayName(unit.number);
    const forUnit = paymentsForUnit(payments, unit, units).filter(p => p.currency === currency);
    for (const month of months) {
      const rentReceived = unit.currency === currency ? receivedInMonth(forUnit, 'Rent', month, start, end) : 0;
      const maintenancePaid =
        (unit.maintCurrency || unit.currency) === currency ? receivedInMonth(forUnit, 'Maintenance', month, start, end) : 0;
      const shortStayReceived = unit.currency === currency ? receivedInMonth(forUnit, 'Booking', month, start, end) : 0;
      const days = occupiedDays.get(`${unit.id}|${month}`) || 0;
      /*
       * Everything the villa earned VDS in the month, whichever way it was let.
       * A short-let month that covered its own contribution cost VDS nothing,
       * and counting only the rent would report money VDS never had to find.
       */
      const earned = addMoney(rentReceived, shortStayReceived);
      const gap = subtractMoney(maintenancePaid, earned);
      lines.push({
        unitId: unit.id,
        villa,
        month,
        occupiedDays: days,
        daysCounted: daysCounted.get(month) || 0,
        rentReceived,
        shortStayReceived,
        earned,
        maintenancePaid,
        shortfall: gap > 0 ? round2(gap) : 0,
        vacant: days === 0
      });
    }
  }

  const byVilla: ShortfallVillaRow[] = usable.map(unit => {
    const rows = lines.filter(l => l.unitId === unit.id);
    return {
      unitId: unit.id,
      villa: getUnitDisplayName(unit.number),
      months: rows.length,
      occupiedDays: rows.reduce((a, l) => a + l.occupiedDays, 0),
      daysCounted: rows.reduce((a, l) => a + l.daysCounted, 0),
      rentReceived: sumMoney(rows.map(l => l.rentReceived)),
      shortStayReceived: sumMoney(rows.map(l => l.shortStayReceived)),
      earned: sumMoney(rows.map(l => l.earned)),
      maintenancePaid: sumMoney(rows.map(l => l.maintenancePaid)),
      shortfall: sumMoney(rows.map(l => l.shortfall)),
      vacantMonths: rows.filter(l => l.vacant).map(l => l.month)
    };
  });
  byVilla.sort((a, b) => b.shortfall - a.shortfall || a.villa.localeCompare(b.villa, undefined, { numeric: true }));

  const byMonth: ShortfallMonthRow[] = months.map(month => {
    const rows = lines.filter(l => l.month === month);
    return {
      month,
      rentReceived: sumMoney(rows.map(l => l.rentReceived)),
      shortStayReceived: sumMoney(rows.map(l => l.shortStayReceived)),
      earned: sumMoney(rows.map(l => l.earned)),
      maintenancePaid: sumMoney(rows.map(l => l.maintenancePaid)),
      shortfall: sumMoney(rows.map(l => l.shortfall)),
      vacantVillas: rows.filter(l => l.vacant).map(l => l.villa)
    };
  });

  /*
   * Every month that cost something, empty or not. A villa let for a fortnight
   * that earned less than its contribution belongs on this list as much as one
   * that stood empty — leaving it off would hide the very case that made
   * short-stay income count in the first place.
   */
  const fundedMonths = lines
    .filter(l => l.shortfall > 0)
    .map(l => ({ unitId: l.unitId, villa: l.villa, month: l.month, shortfall: l.shortfall, vacant: l.vacant }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.villa.localeCompare(b.villa, undefined, { numeric: true }));

  const totalRentReceived = sumMoney(lines.map(l => l.rentReceived));
  const totalShortStayReceived = sumMoney(lines.map(l => l.shortStayReceived));
  const totalMaintenancePaid = sumMoney(lines.map(l => l.maintenancePaid));

  return {
    currency,
    from: start,
    to: end,
    months,
    lines,
    byVilla,
    byMonth,
    totalRentReceived,
    totalShortStayReceived,
    totalEarned: sumMoney(lines.map(l => l.earned)),
    totalMaintenancePaid,
    /*
     * Summed from the villa-months rather than taken as the difference of the
     * two totals. A villa that earned more than its contribution does not
     * subsidise a villa that earned nothing — netting them would report a
     * property that funded itself while VDS was writing cheques.
     */
    totalShortfall: sumMoney(lines.map(l => l.shortfall)),
    fundedMonths,
    fundedVillaMonths: fundedMonths.length,
    vacantShortfall: sumMoney(fundedMonths.filter(m => m.vacant).map(m => m.shortfall)),
    vacantVillaMonths: fundedMonths.filter(m => m.vacant).length,
    currencyNotes,
    noneFlagged: flagged.length === 0,
    /*
     * A villa named in `currencyNotes` keeps the report on screen even when
     * there is nothing to total. It was deliberately given no shortfall, and a
     * report that hid itself would take that statement with it — leaving a
     * villa VDS lets silently unaccounted for.
     */
    empty:
      currencyNotes.length === 0 &&
      (lines.length === 0 || (totalRentReceived === 0 && totalShortStayReceived === 0 && totalMaintenancePaid === 0))
  };
}

/* ------------------------------------------------------------------ *
 * The owners' monthly report
 * ------------------------------------------------------------------ */

/**
 * How the property ran in one month, for circulation to proprietors on request.
 *
 * Asked for by Ro on 2026-09-02: *"a monthly report that we may be able to give
 * our owners should they ask"*, as a tab beside the annual report — which is
 * where it belongs, because **it obeys the annual report's rule.** It is
 * identical for every owner and carries nothing personal: no lot balances, no
 * proprietor named, nothing about anybody's villa. Ro, 2026-08-16, on the annual
 * report: *"it has to do with how the property is run, not their unit nor their
 * finances."* That rule is not relaxed by making the period shorter.
 *
 * **It is generated and nothing on it is typed.** The annual report carries eight
 * narrative boxes; this carries none, so there is no wording to keep in step with
 * a figure and nothing to save. Every number comes from the ledger each time it
 * is opened, which also means a corrected receipt reaches it without anyone
 * reopening anything.
 *
 * **What it is not:** not the operating statement, which names every payee for
 * the council; not an owner statement, which is one proprietor's own account;
 * and not the shortfall report, which is VDS's trading position and internal.
 * Costs appear here as **category totals**, because a circular to sixteen
 * proprietors is not the place to name every contractor paid.
 *
 * Arrears appear as **one aggregate line and no lot is named** — how many lots
 * owed contributions at month end, and how much in total. That is a fact about
 * the fund every proprietor is entitled to, and it is the boundary: a count and
 * a total, never a list.
 *
 * ⚠️ **Rent never appears here, in any form.** Ro, 2026-09-02: *"rent should not
 * be included as it is not apart of the report, only maintenance contributions
 * and the expenses, including payroll vendors utilities and all other
 * expenses."* Rent is a landlord's business between an owner and their tenant;
 * the corporation's fund is owed contributions and nothing else. So the income
 * side reads `collectedInPeriod(...).maintenance` alone — never `.total`, which
 * would sweep in rent, short-stay receipts and utility recoveries — and the
 * arrears count is over the Maintenance account only, so a tenant who has not
 * paid their rent can never put a lot on this document. A test banks rent, a
 * booking and a utility recovery in the month and asserts **not one figure
 * moves.**
 */
export interface MonthlyOwnersReport {
  currency: Currency;
  month: string;
  from: string;
  to: string;
  /** Contributions actually received in the month, net of refunds. */
  contributionsReceived: number;
  /** Common costs of running the property, settled in the month. */
  costsPaid: number;
  /** Received less paid. Negative means the fund spent more than it took in. */
  surplus: number;
  /** Where the money went, by category. Totals only — no payee is named. */
  categories: { label: string; total: number }[];
  /**
   * Memo, never netted into the surplus: common bills that fell due in the month
   * and were still unsettled at the end of it. A month with a large unpaid bill
   * would otherwise read as a good month.
   */
  unpaidAtMonthEnd: number;
  unpaidCount: number;
  /**
   * Memo: work on individual villas, recharged to those owners and therefore not
   * a common cost. Stated as a total so that a cost put against the wrong villa
   * shows as a visible exclusion instead of vanishing from both sides.
   */
  villaRecharged: number;
  villaRechargedCount: number;
  /** Lots with contributions outstanding at month end. A count, never a list. */
  lotsInArrears: number;
  lotsTotal: number;
  arrearsOutstanding: number;
  /** Nothing at all happened in this month, in this currency. */
  empty: boolean;
}

export function monthlyOwnersReport(
  units: Unit[],
  charges: Charge[],
  payments: Payment[],
  expenses: Expense[],
  currency: Currency,
  month: string
): MonthlyOwnersReport {
  const from = monthStart(month);
  const to = monthEnd(month);

  const ops = operationsStatement(expenses, payments, currency, from, to);

  /*
   * Contributions only. Rent arrears are a landlord's business between an owner
   * and their tenant; the corporation's fund is owed maintenance and nothing
   * else, and putting rent on a proprietors' circular would misstate whose money
   * this document is about.
   */
  let lotsInArrears = 0;
  let arrearsOutstanding = 0;
  let lotsTotal = 0;
  for (const unit of units) {
    if (chargeCurrency(unit, 'Maintenance') !== currency) continue;
    lotsTotal++;
    const account = accountBalance(unit, 'Maintenance', charges, payments, to, units);
    if (account.balance > 0) {
      lotsInArrears++;
      arrearsOutstanding = addMoney(arrearsOutstanding, account.balance);
    }
  }

  return {
    currency,
    month,
    from,
    to,
    contributionsReceived: ops.maintenanceCollected,
    costsPaid: ops.costsPaid,
    surplus: ops.surplus,
    // Largest first: the question a proprietor asks of this table is "what did
    // most of it go on?", and alphabetical order answers a different one.
    categories: ops.groups
      .map(g => ({ label: g.category, total: g.total }))
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    unpaidAtMonthEnd: ops.costsUnpaid,
    unpaidCount: ops.unpaidLines.length,
    villaRecharged: ops.villaRecharged,
    villaRechargedCount: ops.villaRechargedCount,
    lotsInArrears,
    lotsTotal,
    arrearsOutstanding: round2(arrearsOutstanding),
    empty: ops.empty && lotsInArrears === 0
  };
}
