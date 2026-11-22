/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Operational observations for the Reports tab, decision-ready.
 *
 * Ro, 2026-11-19, reading "J$275,000.00 was billed in rent; J$200,000.00 was
 * received against it (72.73%)": it does not say WHO owes the other J$75,000.
 * Every observation that states a gap now also names (a) the villa, person or
 * bill that makes it up, with amounts that sum to the headline, (b) since when,
 * and (c) the next action in plain words.
 *
 * Rules kept from the screen this replaces:
 *   - every sentence is a fact derived from the ledger, never a guessed cause;
 *   - USD and JMD never meet: every function takes one currency;
 *   - only completed money counts;
 *   - the book is respected: rent, short stays and the tenant behind a levy are
 *     ISPO's business and never appear on the corporation's book.
 *
 * Pure functions only, so a test can reach every rule. Nothing here is stored.
 */

import {
  Booking,
  Charge,
  ChargeCategory,
  Currency,
  Expense,
  MANAGING_COMPANY_NAME,
  Payment,
  Tenancy,
  Unit,
  UtilityReading,
  getUnitDisplayName
} from '../types';
import {
  ReportBook,
  accountBalance,
  chargeCategoriesInBook,
  chargesInBook,
  consolidateEverything,
  delinquentAccounts,
  ownLevyArrears,
  expensesForBook,
  isOwnAccount,
  isProprietorsOwnUtility,
  recoveryFundFor,
  isUtilityRecoveryRow,
  leasesNeedingAttention,
  liveExpenses,
  netReceivedInPeriod,
  occupiedUnitIdsOn,
  outOfPocketShortfall,
  paymentsInBook,
  unpaidOwedAt
} from './finance';
import { formatMoney, round2, sumMoney } from './money';
import { stayMoney } from './stays';
import { levyForMonth } from './feeSchedule';
import { addDays, daysSinceOn, formatDayLabel, formatMonthLabel, isWithin, monthEnd, monthStart, nightsBetween } from './dates';

/** Lower sorts first. */
/**
 * The two summaries Ro asked for on 2026-11-19 — where money is owed to us and
 * where it is leaking — always first, each line naming who and how much.
 */
export const SUMMARY = -1;
export const URGENT = 0; // money at risk, or a position that has worsened
export const NOTABLE = 1; // the period's headline figures
export const CONTEXT = 2; // standing facts that frame the rest

export interface Observation {
  /** The headline, one short sentence. */
  text: string;
  rank: number;
  /** One line per villa, person or bill behind the headline. */
  details?: string[];
  /** The currency the money in this observation is in; absent for counts. */
  currency?: Currency;
  /** Money at risk, used to order observations of the same rank and currency. */
  atRisk?: number;
}

export interface ObservationInput {
  units: Unit[];
  tenancies: Tenancy[];
  bookings: Booking[];
  /** Stored charges, as held. The book is applied here. */
  charges: Charge[];
  /** Stored receipts plus `settledFromRent`, as every screen is given them. */
  payments: Payment[];
  expenses: Expense[];
  utilities?: UtilityReading[];
  currency: Currency;
  from: string;
  to: string;
  book: ReportBook;
}

const villa = (u: Pick<Unit, 'number'>) => getUnitDisplayName(u.number);
const m = (n: number, c: Currency) => formatMoney(n, c);
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ *
 * The book's ledger, exactly as the Reports summary reads it
 * ------------------------------------------------------------------ */

export function bookLedger(charges: Charge[], payments: Payment[], units: Unit[], book: ReportBook) {
  const combined = book === 'everything' ? consolidateEverything(charges, payments, units) : { charges, payments };
  return {
    charges: chargesInBook(combined.charges, book),
    payments: paymentsInBook(combined.payments, book),
    categories: chargeCategoriesInBook(book)
  };
}

/* ------------------------------------------------------------------ *
 * Who owes what, per villa
 * ------------------------------------------------------------------ */

export interface UnpaidCharge {
  charge: Charge;
  /** What is still owed on this charge after receipts are applied oldest first. */
  unpaid: number;
  /** Who owes it: the tenant for rent, the proprietor for maintenance. */
  payer: string;
  /** The tenancy the charge fell in, for rent. */
  tenancy?: Tenancy;
  /**
   * Combined book only: ISPO's own levy that ISPO has paid. The combined view
   * drops that receipt as a transfer between the two books but keeps the
   * charge, so the line reads as owed there and nowhere else.
   */
  paidByIspo?: boolean;
  /** Combined book only: the levy inside the tenant's rent, moved out of it by consolidation. */
  levyInRent?: boolean;
}

export interface AccountOwing {
  unit: Unit;
  currency: Currency;
  /** Net across the book's categories for this villa. Positive owes; negative is credit. */
  balance: number;
  /** Per category, so a credit on one and a debt on the other are both shown. */
  parts: { category: ChargeCategory; balance: number }[];
  unpaid: UnpaidCharge[];
  /** The part of `unpaid` raised in the period (due date within from..to). */
  unpaidInPeriod: number;
  oldestDue: string;
  oldestDays: number;
}

/** The tenancy a rent charge fell in: the one in place on its due date, else in its month. */
export function tenancyForCharge(charge: Charge, tenancies: Tenancy[]): Tenancy | undefined {
  const mine = tenancies.filter(t => t.unitId === charge.unitId).sort((a, b) => b.startedOn.localeCompare(a.startedOn));
  const onDay = mine.find(t => t.startedOn <= charge.dueDate && (!t.endedOn || t.endedOn > charge.dueDate));
  if (onDay) return onDay;
  const s = monthStart(charge.periodMonth);
  const e = monthEnd(charge.periodMonth);
  return mine.find(t => t.startedOn <= e && (!t.endedOn || t.endedOn >= s));
}

function payerFor(charge: Charge, unit: Unit, tenancies: Tenancy[]): { payer: string; tenancy?: Tenancy } {
  if (charge.category === 'Rent') {
    const tenancy = tenancyForCharge(charge, tenancies);
    return { payer: tenancy?.tenantName || charge.payerName || unit.tenantName || 'tenant not recorded', tenancy };
  }
  // ISPO owns every villa not owner-occupied and owes its levy like any
  // proprietor. The tenant is never the corporation's debtor and is never named
  // on a maintenance line.
  if (isOwnAccount(unit)) return { payer: `${MANAGING_COMPANY_NAME} (proprietor)` };
  return { payer: unit.ownerName || charge.payerName || 'owner not recorded' };
}

/**
 * Each villa carrying a balance at `to`, on the book being read.
 *
 * Built from `accountBalance` per category — the same call the "Receivable at
 * end of period" figure is summed from — so the balances here add up to that
 * figure by construction. The categories are then netted per villa: on the
 * combined book the levy inside a tenant's rent is moved from the rent charge
 * to the maintenance charge by consolidation, which leaves a paid-up villa
 * showing a rent credit beside an equal maintenance debt. Netted, it owes nil.
 */
export function accountsOwing(input: ObservationInput): AccountOwing[] {
  const { units, tenancies, currency, from, to, book } = input;
  const ledger = bookLedger(input.charges, input.payments, units, book);
  const out: AccountOwing[] = [];
  for (const unit of units) {
    const accounts = ledger.categories
      .map(cat => accountBalance(unit, cat, ledger.charges, ledger.payments, to, units))
      .filter(a => a.currency === currency);
    if (accounts.length === 0) continue;
    const balance = sumMoney(accounts.map(a => a.balance));
    if (balance === 0 && accounts.every(a => a.balance === 0)) continue;

    const unpaid: UnpaidCharge[] = [];
    for (const a of accounts) {
      if (a.balance <= 0 || a.unpaidCharges.length === 0) continue;
      // Every unpaid charge after the first is wholly unpaid; the first carries
      // whatever is left of the receipts, so the amounts sum to the balance
      // (on a villa that changed hands, each proprietor's part-paid charge carries its own remainder).
      a.unpaidCharges.forEach((charge, i) => {
        const owed = unpaidOwedAt(a, i);
        if (owed <= 0) return;
        unpaid.push({ charge, unpaid: owed, ...payerFor(charge, unit, tenancies) });
      });
    }
    unpaid.sort((x, y) => x.charge.dueDate.localeCompare(y.charge.dueDate));
    /*
     * A credit on one category nets against a debt on the other (combined book:
     * a paid-up tenant's rent credit beside the levy moved out of it). Applied
     * oldest first, so the lines still sum to what the villa owes.
     */
    let credit = -sumMoney(accounts.filter(a => a.balance < 0).map(a => a.balance));
    for (const u of unpaid) {
      if (credit <= 0) break;
      const take = Math.min(credit, u.unpaid);
      u.unpaid = round2(u.unpaid - take);
      credit = round2(credit - take);
    }
    for (let i = unpaid.length - 1; i >= 0; i--) if (unpaid[i].unpaid <= 0) unpaid.splice(i, 1);
    if (book === 'everything' && isOwnAccount(unit)) {
      const raw = accountBalance(unit, 'Maintenance', input.charges, input.payments, to, units);
      const rawUnpaid = new Set(raw.balance > 0 ? raw.unpaidCharges.map(c => c.id) : []);
      for (const u of unpaid) {
        if (u.charge.category !== 'Maintenance') continue;
        if (!rawUnpaid.has(u.charge.id)) {
          u.paidByIspo = true;
          continue;
        }
        // The levy consolidation moved out of the tenant's rent: still the
        // tenant's money that settles it, so the tenant is who to chase.
        const rent = input.charges.find(
          c => c.unitId === unit.id && c.category === 'Rent' && c.status === 'open' && c.periodMonth === u.charge.periodMonth && c.currency === u.charge.currency && (c.maintenancePortion || 0) > 0
        );
        if (rent) {
          const t = tenancyForCharge(rent, tenancies);
          u.payer = t?.tenantName || rent.payerName || unit.tenantName || u.payer;
          u.tenancy = t;
          u.levyInRent = true;
        }
      }
    }
    const oldestDue = unpaid[0]?.charge.dueDate || '';
    out.push({
      unit,
      currency,
      balance,
      parts: accounts.map(a => ({ category: a.category, balance: a.balance })).filter(p => p.balance !== 0),
      unpaid,
      unpaidInPeriod: sumMoney(unpaid.filter(u => isWithin(u.charge.dueDate, from, to)).map(u => u.unpaid)),
      oldestDue,
      oldestDays: oldestDue ? Math.max(0, daysSinceOn(oldestDue, to)) : 0
    });
  }
  return out.sort((a, b) => b.balance - a.balance || a.unit.number.localeCompare(b.unit.number));
}

/** "Chase Jane Doe, Villa Unit 3: October 2026 rent J$75,000.00 unpaid since 1 Oct 2026, 30 days." */
function chaseLine(u: UnpaidCharge, unit: Unit, currency: Currency, to: string, book: ReportBook): string {
  const c = u.charge;
  const what = c.category === 'Rent' ? 'rent' : u.levyInRent ? 'levy inside the rent' : c.oneOffType || c.kind === 'one-off' ? (c.description || 'one-off charge') : 'maintenance levy';
  const age = Math.max(0, daysSinceOn(c.dueDate, to));
  const former = u.tenancy && u.tenancy.status === 'ended' && u.tenancy.endedOn && u.tenancy.endedOn <= to ? ` (former tenant, left ${formatDayLabel(u.tenancy.endedOn)})` : '';
  const levyInside =
    c.category === 'Rent' && (c.maintenancePortion || 0) > 0 && book === 'ispo'
      ? `; ${MANAGING_COMPANY_NAME}'s ${m(Math.min(c.maintenancePortion || 0, u.unpaid), currency)} levy inside it stays unsettled until it is paid`
      : '';
  const verb = u.payer.startsWith(MANAGING_COMPANY_NAME) ? `${MANAGING_COMPANY_NAME} to pay the corporation,` : `Chase ${u.payer}${former},`;
  return (
    `${verb} ${villa(unit)}: ${formatMonthLabel(c.periodMonth)} ${what} ${m(u.unpaid, currency)} unpaid` +
    `${u.unpaid !== c.amount ? ` of ${m(c.amount, currency)}` : ''}, due ${formatDayLabel(c.dueDate)}, ${days(age)}${levyInside}.`
  );
}

/** The combined view's one figure that does not tie to the books it combines. */
function internalNote(villas: Unit[], amount: number, currency: Currency): string {
  const names = [...new Set(villas.map(villa))];
  return (
    `Does not tie: ${m(amount, currency)} on ${names.join(', ')} is ${MANAGING_COMPANY_NAME}'s own levy, which ${MANAGING_COMPANY_NAME} has paid. ` +
    `The combined view drops those receipts as transfers between the two books but keeps the levy charge, so it reads as owed here ` +
    `and settled on the corporation's book; the difference is ${m(amount, currency)}. Nobody needs chasing for it.`
  );
}

/* ------------------------------------------------------------------ *
 * ISPO's levy on the villas it owns
 * ------------------------------------------------------------------ */

export interface LevyRow {
  unit: Unit;
  billed: number;
  settled: number;
  unpaid: number;
  /** Months with levy left unsettled, each with its derived reason. */
  months: { month: string; unpaid: number; reason: string; action: string }[];
}

export interface LevyPosition {
  currency: Currency;
  /** Levy billed in the period on ISPO's villas. */
  billed: number;
  /** How many of ISPO's villas were billed a levy in the period. */
  villas: number;
  /** Cash paid over in the period: maintenance receipts on ISPO's villas (the operating statement's `internalTransfer`). */
  paid: number;
  /** The part of `billed` settled by `to`, by whichever receipt. */
  settledOfBilled: number;
  unpaid: number;
  rows: LevyRow[];
}

/**
 * The strata levy ISPO owes on each villa it owns, billed against settled.
 *
 * Read on the raw ledger (never consolidated): the levy charge and every
 * maintenance receipt against it, hand-keyed or `settledFromRent`. Where it is
 * unsettled the reason is read from the same month's rent charge, never guessed.
 */
export function ispoLevyPosition(input: Pick<ObservationInput, 'units' | 'tenancies' | 'charges' | 'payments' | 'currency' | 'from' | 'to'>): LevyPosition {
  const { units, tenancies, charges, payments, currency, from, to } = input;
  const own = units.filter(isOwnAccount);
  const rows: LevyRow[] = [];
  for (const unit of own) {
    const maint = accountBalance(unit, 'Maintenance', charges, payments, to, units);
    if (maint.currency !== currency) continue;
    const inPeriod = charges.filter(
      c => c.unitId === unit.id && c.category === 'Maintenance' && c.status === 'open' && c.currency === currency && isWithin(c.dueDate, from, to)
    );
    if (inPeriod.length === 0) continue;
    const billed = sumMoney(inPeriod.map(c => c.amount));
    const unpaidBy = new Map<string, number>();
    maint.unpaidCharges.forEach((c, i) => {
      if (!isWithin(c.dueDate, from, to)) return;
      const owed = unpaidOwedAt(maint, i);
      if (owed > 0) unpaidBy.set(c.periodMonth, sumMoney([unpaidBy.get(c.periodMonth) || 0, owed]));
    });
    const unpaid = sumMoney([...unpaidBy.values()]);

    const rentAccount = accountBalance(unit, 'Rent', charges, payments, to, units);
    const rentUnpaid = new Map<string, number>();
    rentAccount.unpaidCharges.forEach((c, i) => rentUnpaid.set(c.id, unpaidOwedAt(rentAccount, i)));

    const months = [...unpaidBy.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, owed]) => {
      const rent = charges.find(
        c => c.unitId === unit.id && c.category === 'Rent' && c.status === 'open' && c.periodMonth === month && c.currency === currency && (c.maintenancePortion || 0) > 0
      );
      const label = formatMonthLabel(month);
      if (rent) {
        const tenant = tenancyForCharge(rent, tenancies)?.tenantName || rent.payerName || unit.tenantName || 'the tenant';
        const left = rentUnpaid.get(rent.id) || 0;
        if (left > 0) {
          return {
            month,
            unpaid: owed,
            reason:
              `${tenant}'s ${label} rent ${m(rent.amount, currency)} ${left === rent.amount ? 'unpaid' : `has ${m(left, currency)} unpaid`}, ` +
              `so the ${m(owed, currency)} levy inside it is unsettled`,
            action: `Chase ${tenant}, ${villa(unit)}: ${label} rent ${m(left, currency)} unpaid; the levy settles from it when paid.`
          };
        }
        return {
          month,
          unpaid: owed,
          reason: `${label} rent is paid but ${m(owed, currency)} of its levy is not settled`,
          action: `Check ${villa(unit)} ${label}: the rent receipt did not settle the levy inside it.`
        };
      }
      return {
        month,
        unpaid: owed,
        reason: `no rent charge carries the ${label} levy (villa ${unit.status}) and no maintenance receipt covers it`,
        action: `${MANAGING_COMPANY_NAME} to pay the corporation ${m(owed, currency)} for ${villa(unit)}, ${label}.`
      };
    });
    rows.push({ unit, billed, settled: round2(billed - unpaid), unpaid, months });
  }
  const ownIds = new Set(own.map(u => u.id));
  const paid = netReceivedInPeriod(
    payments.filter(p => p.currency === currency && p.category === 'Maintenance' && ownIds.has(p.unitId)),
    from,
    to
  );
  const billed = sumMoney(rows.map(r => r.billed));
  const unpaid = sumMoney(rows.map(r => r.unpaid));
  return {
    currency,
    billed,
    villas: rows.length,
    paid,
    settledOfBilled: round2(billed - unpaid),
    unpaid,
    rows: rows.sort((a, b) => b.unpaid - a.unpaid || a.unit.number.localeCompare(b.unit.number))
  };
}

/**
 * The note under "Expenses paid" on ISPO's book:
 * "J$180,000.00 billed on 9 villas; J$160,000.00 paid; J$20,000.00 unpaid on Villa Unit 3 (...)."
 */
export function levyNote(p: LevyPosition): string {
  const c = p.currency;
  if (p.billed === 0 && p.paid === 0) return '';
  const unpaidRows = p.rows.filter(r => r.unpaid > 0);
  let text =
    `${MANAGING_COMPANY_NAME}'s strata levy on the villas it owns: ${m(p.billed, c)} billed on ${p.villas} villa${p.villas === 1 ? '' : 's'}; ` +
    `${m(p.paid, c)} paid`;
  if (unpaidRows.length > 0) {
    text +=
      `; ${m(p.unpaid, c)} unpaid on ` +
      unpaidRows.map(r => `${villa(r.unit)} (${r.months.map(x => x.reason).join('; ')})`).join(', ');
  }
  text += '.';
  const gap = round2(p.paid - p.settledOfBilled);
  if (gap > 0) text += ` ${m(gap, c)} of what was paid settled levy billed outside this period.`;
  if (gap < 0) text += ` ${m(-gap, c)} of this period's levy was settled by money paid outside the period.`;
  return text;
}

/* ------------------------------------------------------------------ *
 * The observations themselves
 * ------------------------------------------------------------------ */

/** Figures shown elsewhere on the page, so a figure that does not tie is named. */
export interface PageFigures {
  billed: number;
  /** The collection rate's settled amount (`settledOfBilled`). */
  settled?: number;
  closingReceivable: number;
  /** "of which paid to the corporation", ISPO's book only. */
  paidOver?: number;
  /** "Expenses outstanding": the pending bills dated in the period. */
  expensesOutstanding?: number;
}

const HELD_FOR_GUESTS = 'Held for guests: refund or apply';

export function observationsFor(input: ObservationInput, page?: PageFigures): Observation[] {
  const { units, tenancies, bookings, currency: c, from, to, book } = input;
  const out: Observation[] = [];
  const say = (o: Observation) => out.push({ currency: c, ...o });
  const ledger = bookLedger(input.charges, input.payments, units, book);
  /*
   * Filled as each section below works out its figures, then stated as two
   * summaries at the top: money owed to us, and money leaking. Built from the
   * same numbers as the detail, so a summary can never disagree with it.
   */
  type Group = { group: string; amount: number; lines: string[] };
  const owedGroups: Group[] = [];
  const leakGroups: Group[] = [];
  const checks: string[] = [];
  // Filled by the deposits section: the part of what is owed a held deposit can meet.
  let depositCover: string[] = [];
  let depositCoverTotal = 0;
  const addTo = (list: Group[], group: string, amount: number, line: string) => {
    if (!(amount > 0)) return;
    let g = list.find(x => x.group === group);
    if (!g) list.push((g = { group, amount: 0, lines: [] }));
    g.amount = sumMoney([g.amount, amount]);
    g.lines.push(line);
  };

  /* 1. Collection shortfall: who makes up the gap. */
  const owing = accountsOwing(input);
  const billed = sumMoney(
    ledger.charges.filter(x => x.status === 'open' && x.currency === c && isWithin(x.dueDate, from, to)).map(x => x.amount)
  );
  const inPeriodLines = owing.flatMap(a => a.unpaid.filter(u => isWithin(u.charge.dueDate, from, to)).map(u => ({ a, u })));
  const gapLines = inPeriodLines.filter(g => !g.u.paidByIspo);
  const internalLines = inPeriodLines.filter(g => g.u.paidByIspo);
  const gap = sumMoney(gapLines.map(g => g.u.unpaid));
  const internal = sumMoney(internalLines.map(g => g.u.unpaid));
  if (billed > 0) {
    const settled = round2(billed - gap - internal);
    const accounts = ledger.categories.map(x => x.toLowerCase()).join(' and ');
    const details = gapLines
      .sort((x, y) => y.u.unpaid - x.u.unpaid || x.u.charge.dueDate.localeCompare(y.u.charge.dueDate))
      .map(({ a, u }) => chaseLine(u, a.unit, c, to, book));
    if (internal > 0) details.push(internalNote(internalLines.map(g => g.a.unit), internal, c));
    if (page?.settled !== undefined && round2(page.settled) !== settled) {
      details.push(
        `Does not tie: the collection rate counts ${m(page.settled, c)} settled, these accounts ${m(settled, c)}; difference ${m(Math.abs(round2(page.settled - settled)), c)}.`
      );
    }
    say({
      rank: gap > 0 ? URGENT : NOTABLE,
      atRisk: gap,
      text:
        `${c}: ${m(billed, c)} billed in ${accounts}; ${m(settled, c)} of it settled by ${formatDayLabel(to)}` +
        (internal > 0 ? ` (plus ${m(internal, c)} of ${MANAGING_COMPANY_NAME}'s own levy, paid)` : '') +
        (gap > 0 ? `; ${m(gap, c)} unpaid on ${new Set(gapLines.map(g => g.a.unit.id)).size} villa(s).` : ', all of it.'),
      details: details.length ? details : undefined
    });
  }

  /* Receivable at the end of the period, per villa, tied to the figure on the page. */
  const receivable = sumMoney(owing.map(a => a.balance));
  if (owing.length > 0) {
    const debtors = owing.filter(a => a.balance > 0);
    for (const a of debtors) {
      for (const u of a.unpaid) {
        if (u.paidByIspo || !(u.unpaid > 0)) continue;
        const group =
          u.charge.category === 'Rent'
            ? u.tenancy?.status === 'ended'
              ? 'Former tenants'
              : 'Tenants'
            : isOwnAccount(a.unit)
              ? `${MANAGING_COMPANY_NAME}'s own levy`
              : 'Proprietors';
        addTo(
          owedGroups,
          group,
          u.unpaid,
          `${u.payer || 'payer not recorded'}, ${villa(a.unit)}: ${m(u.unpaid, c)} ${u.charge.category === 'Rent' ? 'rent' : 'levy'} for ${formatMonthLabel(u.charge.periodMonth)}, ${days(Math.max(0, daysSinceOn(u.charge.dueDate, to)))} unpaid.`
        );
      }
    }
    const credits = owing.filter(a => a.balance < 0);
    const over30 = debtors.filter(a => a.oldestDays > 30).length;
    const over60 = debtors.filter(a => a.oldestDays > 60).length;
    const details = debtors.map(a => {
      const who = [...new Set(a.unpaid.map(u => (u.paidByIspo ? `${MANAGING_COMPANY_NAME} (paid; see below)` : u.payer)))].join(', ') || 'payer not recorded';
      const cats = a.parts.length > 1 ? ` (${a.parts.map(p => `${p.category.toLowerCase()} ${m(p.balance, c)}`).join(', ')})` : '';
      return (
        `${villa(a.unit)} · ${who} · ${m(a.balance, c)}${cats}` +
        (a.oldestDue ? ` · unpaid since ${formatMonthLabel(a.unpaid[0].charge.periodMonth)}, ${days(a.oldestDays)}` : '')
      );
    });
    for (const a of credits) details.push(`${villa(a.unit)} · in credit ${m(-a.balance, c)} (held against future charges)`);
    details.push(`Total ${m(receivable, c)}, the receivable at end of period.`);
    const internalAll = owing.flatMap(a => a.unpaid.filter(u => u.paidByIspo).map(u => ({ a, u })));
    if (internalAll.length > 0) {
      details.push(internalNote(internalAll.map(g => g.a.unit), sumMoney(internalAll.map(g => g.u.unpaid)), c));
    }
    if (round2(page?.closingReceivable ?? receivable) !== receivable) {
      details.push(
        `Does not tie: "Receivable at end of period" reads ${m(page!.closingReceivable, c)}; these accounts sum to ${m(receivable, c)}; difference ${m(Math.abs(round2(page!.closingReceivable - receivable)), c)}.`
      );
    }
    if (debtors.length > 0) {
      say({
        rank: URGENT,
        atRisk: sumMoney(debtors.map(a => a.balance)),
        text:
          `${c}: ${debtors.length} villa(s) owed ${m(sumMoney(debtors.map(a => a.balance)), c)} at ${formatDayLabel(to)}: ` +
          `${over30} more than 30 days old, of which ${over60} exceed 60 days.`,
        details
      });
    } else if (credits.length > 0) {
      say({ rank: CONTEXT, text: `${c}: no villa owed money at ${formatDayLabel(to)}; ${credits.length} held credit.`, details });
    }
  }

  /*
   * The combined book leaves out ISPO's own unpaid levy: on that book it is ISPO
   * owing itself. The Dashboard reads the single books and counts it, so the
   * two figures differ by exactly this; say so, with who and how much.
   */
  if (book === 'everything') {
    const own = ownLevyArrears(delinquentAccounts(units, input.charges, input.payments, to)).filter(a => a.currency === c);
    const ownTotal = sumMoney(own.map(a => a.balance));
    if (ownTotal > 0) {
      say({
        rank: CONTEXT,
        text:
          `${c}: ${m(ownTotal, c)} of ${MANAGING_COMPANY_NAME}'s own levy is unpaid at ${formatDayLabel(to)}. On these combined books it is ` +
          `${MANAGING_COMPANY_NAME} owing itself and is left out, so the Dashboard's arrears read ${m(ownTotal, c)} higher. ` +
          `It is still owed to the corporation: see the strata book.`,
        details: own.map(a => `${villa(a.unit)}: ${m(a.balance, c)} levy unpaid${a.unpaidCharges[0] ? ` since ${formatMonthLabel(a.unpaidCharges[0].periodMonth)}` : ''}.`)
      });
    }
  }

  /* 3. Former tenants who left owing. ISPO's business: rent is its book. */
  if (book !== 'strata') {
    const former = new Map<string, { tenancy: Tenancy; unit: Unit; owed: number; months: string[] }>();
    for (const a of owing) {
      for (const u of a.unpaid) {
        const t = u.tenancy;
        if (u.charge.category !== 'Rent' || !t || t.status !== 'ended' || !t.endedOn || t.endedOn > to) continue;
        const row = former.get(t.id) || { tenancy: t, unit: a.unit, owed: 0, months: [] };
        row.owed = sumMoney([row.owed, u.unpaid]);
        row.months.push(formatMonthLabel(u.charge.periodMonth));
        former.set(t.id, row);
      }
    }
    const rows = [...former.values()].sort((a, b) => b.owed - a.owed);
    if (rows.length > 0) {
      const total = sumMoney(rows.map(r => r.owed));
      say({
        rank: URGENT,
        atRisk: total,
        text: `${c}: ${rows.length} former tenant(s) left owing ${m(total, c)} in rent.`,
        details: rows.map(
          r =>
            `Recover from ${r.tenancy.tenantName}, ${villa(r.unit)}: ${m(r.owed, c)} (${r.months.join(', ')}), left ${formatDayLabel(r.tenancy.endedOn!)}` +
            `${r.tenancy.depositAmount && !r.tenancy.depositReturnedOn && (r.tenancy.depositCurrency || r.tenancy.currency) === c ? `; deposit ${m(r.tenancy.depositAmount, c)} still held` : ''}.`
        )
      });
    }
  }

  /*
   * Deposits held at the end of the period: the tenants' and guests' money in
   * the property's hands. Never income and never in any collection figure, so
   * until now it appeared in no report total at all (hunt, 2026-11-19: J$170,000
   * held, B10 gone owing J$90,000 with J$90,000 of deposit held and nothing
   * pairing the two). Stated here, with the deposits that can meet a former
   * tenant's debt named, because that is the decision the figure is for.
   */
  if (book !== 'strata') {
    const heldAt = (receivedOn?: string, returnedOn?: string) => !!receivedOn && receivedOn <= to && (!returnedOn || returnedOn > to);
    const unitOfId = new Map(units.map(u => [u.id, u]));
    const owedRentBy = (t: Tenancy) =>
      sumMoney(owing.flatMap(a => a.unpaid.filter(u => u.charge.category === 'Rent' && u.tenancy?.id === t.id).map(u => u.unpaid)));
    const tenancyRows = tenancies
      .filter(t => (t.depositAmount || 0) > 0 && (t.depositCurrency || t.currency) === c && heldAt(t.depositReceivedOn, t.depositReturnedOn))
      .map(t => ({ t, unit: unitOfId.get(t.unitId), owed: owedRentBy(t) }));
    const guestRows = bookings.filter(
      b => b.status !== 'cancelled' && (b.damageDepositAmount || 0) > 0 && (b.damageDepositCurrency || b.currency) === c && heldAt(b.damageDepositReceivedOn, b.damageDepositReturnedOn)
    );
    const held = sumMoney([...tenancyRows.map(r => r.t.depositAmount!), ...guestRows.map(b => b.damageDepositAmount!)]);
    if (held > 0) {
      const gone = tenancyRows.filter(r => r.t.status === 'ended' && !!r.t.endedOn && r.t.endedOn <= to);
      const offsets = gone.filter(r => r.owed > 0).map(r => ({ ...r, cover: Math.min(r.owed, r.t.depositAmount!) }));
      const coverable = sumMoney(offsets.map(r => r.cover));
      for (const r of gone) {
        checks.push(
          `${r.t.tenantName}, ${villa(r.unit || { number: r.t.unitNumber })}: left ${formatDayLabel(r.t.endedOn!)} and the ${m(r.t.depositAmount!, c)} deposit is not yet settled. ` +
            (r.owed > 0
              ? `Withhold ${m(Math.min(r.owed, r.t.depositAmount!), c)} against the ${m(r.owed, c)} rent owed${r.t.depositAmount! > r.owed ? ` and return ${m(round2(r.t.depositAmount! - r.owed), c)}` : ''}.`
              : 'Nothing is owed: return it, or record why it is kept.')
        );
      }
      say({
        rank: offsets.length > 0 ? NOTABLE : CONTEXT,
        text:
          `${c}: ${m(held, c)} of deposits held at ${formatDayLabel(to)} (${tenancyRows.length} tenancy, ${guestRows.length} stay). ` +
          `It is the tenants' and guests' money, not income` +
          (coverable > 0 ? `; ${m(coverable, c)} of it can meet rent owed by former tenants.` : '.'),
        details: [
          ...tenancyRows.map(
            r =>
              `${r.t.tenantName}, ${villa(r.unit || { number: r.t.unitNumber })}: ${m(r.t.depositAmount!, c)} held since ${formatDayLabel(r.t.depositReceivedOn!)}` +
              (r.t.status === 'ended' && r.t.endedOn && r.t.endedOn <= to ? `; tenant left ${formatDayLabel(r.t.endedOn)}${r.owed > 0 ? ` owing ${m(r.owed, c)} rent` : ''}, deposit not settled` : '') +
              '.'
          ),
          ...guestRows.map(b => `${b.guestName || 'guest not named'}, ${villa(unitOfId.get(b.unitId) || { number: b.unitNumber })}: ${m(b.damageDepositAmount!, c)} damage deposit held since ${formatDayLabel(b.damageDepositReceivedOn!)}.`)
        ]
      });
      depositCover = offsets.map(r => `${r.t.tenantName}, ${villa(r.unit || { number: r.t.unitNumber })}: ${m(r.cover, c)} can be withheld from the deposit held.`);
      depositCoverTotal = coverable;
    }
  }

  /* 2. ISPO's unsettled levy, with the reason read from the rent. */
  if (book !== 'strata') {
    const levy = ispoLevyPosition(input);
    if (levy.billed > 0) {
      const unpaidRows = levy.rows.filter(r => r.unpaid > 0);
      say({
        rank: levy.unpaid > 0 ? URGENT : CONTEXT,
        atRisk: levy.unpaid,
        text:
          `${c}: ${MANAGING_COMPANY_NAME}'s levy ${m(levy.billed, c)} billed on ${levy.villas} villa(s); ${m(levy.paid, c)} paid in the period` +
          (levy.unpaid > 0 ? `; ${m(levy.unpaid, c)} unsettled on ${unpaidRows.map(r => villa(r.unit)).join(', ')}.` : '; nothing unsettled.'),
        details: unpaidRows.length
          ? unpaidRows.flatMap(r => r.months.map(x => `${villa(r.unit)}, ${formatMonthLabel(x.month)}: ${m(x.unpaid, c)} unsettled, ${x.reason}. ${x.action}`))
          : undefined
      });
      if (page?.paidOver !== undefined && round2(page.paidOver) !== levy.paid) {
        say({
          rank: URGENT,
          atRisk: Math.abs(round2(page.paidOver - levy.paid)),
          text: `${c}: "of which paid to the corporation" reads ${m(page.paidOver, c)} but the levy receipts on ${MANAGING_COMPANY_NAME}'s villas total ${m(levy.paid, c)}; difference ${m(Math.abs(round2(page.paidOver - levy.paid)), c)}.`
        });
      }
    }
  }

  /* 4. Short stays. ISPO's trade, never on the corporation's book. */
  if (book !== 'strata') {
    const unitOf = new Map(units.map(u => [u.id, u]));
    const stays = bookings.filter(
      b =>
        b.status !== 'cancelled' &&
        b.source !== 'Blocked' &&
        b.source !== 'Unavailable' &&
        b.currency === c &&
        b.checkIn <= to &&
        b.checkOut > from
    );
    const label = (b: Booking) =>
      `${b.guestName || 'guest not named'}, ${villa(unitOf.get(b.unitId) || { number: b.unitNumber })}, ${formatDayLabel(b.checkIn)} to ${formatDayLabel(b.checkOut)} (${b.source})`;
    const noValue = stays.filter(b => !b.complimentary && !(b.amount > 0));
    for (const b of noValue) checks.push(`No stay value entered: ${label(b)}. Enter it, or mark the stay complimentary with a reason.`);
    if (noValue.length > 0) {
      say({
        rank: URGENT,
        text: `${noValue.length} short stay(s) in ${c} have no stay value entered, so their income is missing from every figure.`,
        details: noValue.map(b => `Enter the stay value for ${label(b)}.`)
      });
    }
    /*
     * What a guest still owes is read from the receipts against the stay, net of
     * refunds — the one figure every screen uses (`stayMoney`). The reservation's
     * own `balanceDue` was typed, and read "owing" on stays paid in full.
     */
    /*
     * Owed at `to` is every stay that had begun by then, whenever it began, and
     * its balance as at `to` (hunt, 2026-11-20): a September debt went on being
     * owed in November, and a payment received after `to` does not settle it as
     * at `to`. A stay not yet begun is payable on arrival, so it is not yet owed.
     */
    const owedScope = bookings.filter(
      b => b.status !== 'cancelled' && b.source !== 'Blocked' && b.source !== 'Unavailable' && b.currency === c && b.checkIn <= to && !b.complimentary
    );
    const due = new Map([...stays, ...owedScope].map(b => [b.id, stayMoney(b, input.payments, { asOf: to }).balance]));
    const dueOf = (b: Booking) => due.get(b.id) || 0;
    const owingStays = owedScope.filter(b => b.amount > 0 && dueOf(b) > 0);
    for (const b of owingStays) addTo(owedGroups, 'Guests', dueOf(b), `${label(b)}: ${m(dueOf(b), c)} of ${m(b.amount, c)} unpaid.`);
    if (owingStays.length > 0) {
      const total = sumMoney(owingStays.map(dueOf));
      say({
        rank: URGENT,
        atRisk: total,
        text: `${c}: ${owingStays.length} short stay(s) carry ${m(total, c)} balance owing.`,
        details: owingStays
          .sort((a, b) => dueOf(b) - dueOf(a))
          .map(b => `Collect ${m(dueOf(b), c)} of ${m(b.amount, c)} from ${label(b)}${b.checkOut <= to ? `, departed ${days(Math.max(0, daysSinceOn(b.checkOut, to)))} before period end` : ''}.`)
      });
    }
    /*
     * Money held for guests beyond what their stay costs, cancelled stays included
     * (hunt, 2026-11-20): owed back or to be applied, and named nowhere until now.
     * Not owed TO the property, so it is never in the owed total.
     */
    const heldFor = bookings
      .filter(b => b.source !== 'Blocked' && b.source !== 'Unavailable' && b.currency === c)
      .map(b => ({ b, over: stayMoney(b, input.payments, { asOf: to }).overpaid }))
      .filter(r => r.over > 0);
    for (const r of heldFor) {
      addTo(
        leakGroups,
        HELD_FOR_GUESTS,
        r.over,
        `${r.b.guestName || 'guest not named'}, ${villa(unitOf.get(r.b.unitId) || { number: r.b.unitNumber })}: ${m(r.over, c)} held beyond the stay price` +
          `${r.b.status === 'cancelled' ? ' on a cancelled stay' : ''}. Refund it to the guest, or apply it to a stay they owe on.`
      );
    }
    if (heldFor.length > 0) {
      const total = sumMoney(heldFor.map(r => r.over));
      say({
        rank: NOTABLE,
        atRisk: total,
        text: `${c}: ${m(total, c)} is held for ${heldFor.length} guest(s) beyond what their stays cost at ${formatDayLabel(to)}; it is theirs, not income. Refund or apply it.`,
        details: heldFor.map(r => `Refund or apply ${m(r.over, c)} for ${label(r.b)}${r.b.status === 'cancelled' ? ', cancelled' : ''}.`)
      });
    }
    const inStay = stays.filter(b => b.checkIn <= to && b.checkOut > to);
    if (inStay.length > 0) {
      say({
        rank: CONTEXT,
        text: `${inStay.length} ${c} short stay(s) were in progress at ${formatDayLabel(to)}.`,
        details: inStay.map(b => `${label(b)}: ${b.complimentary ? 'complimentary' : b.amount > 0 ? `${m(b.amount, c)}, ${m(dueOf(b), c)} still due` : 'no stay value entered'}.`)
      });
    }
  }

  /*
   * 4b. Complimentary stays: free on purpose (Ro, 2026-11-19). Listed under the
   * currency their villa's levy is paid in, with the share of that levy falling
   * on the free nights — what the free stay cost ISPO.
   */
  if (book !== 'strata') {
    const unitOf = new Map(units.map(u => [u.id, u]));
    const end = addDays(to, 1);
    const comps = bookings.filter(b => {
      const u = unitOf.get(b.unitId);
      return b.complimentary && b.status !== 'cancelled' && b.checkIn < end && b.checkOut > from && !!u && (u.maintCurrency || u.currency) === c;
    });
    if (comps.length > 0) {
      const rows = comps.map(b => {
        const u = unitOf.get(b.unitId)!;
        let nights = 0;
        let levy = 0;
        for (let d = b.checkIn < from ? from : b.checkIn; d < b.checkOut && d < end; d = addDays(d, 1)) {
          nights++;
          const month = d.substring(0, 7);
          levy += levyForMonth(u, month) / nightsBetween(monthStart(month), addDays(monthEnd(month), 1));
        }
        return { b, u, nights, levy: round2(levy) };
      });
      const totalNights = rows.reduce((a, r) => a + r.nights, 0);
      const totalLevy = sumMoney(rows.map(r => r.levy));
      say({
        rank: NOTABLE,
        atRisk: totalLevy,
        text: `${c}: ${rows.length} complimentary stay(s), ${totalNights} night(s) given free in the period; ${MANAGING_COMPANY_NAME}'s levy on those nights ${m(totalLevy, c)}.`,
        details: rows.map(
          r =>
            `${r.b.guestName || 'guest not named'}, ${villa(r.u)}, ${formatDayLabel(r.b.checkIn)} to ${formatDayLabel(r.b.checkOut)}: ${r.nights} night(s) free; ` +
            `reason: ${r.b.complimentaryReason || 'none recorded'}; marked by ${r.b.complimentaryBy || 'not recorded'}; levy on those nights ${m(r.levy, c)}.`
        )
      });
      for (const r of rows) {
        addTo(leakGroups, 'Complimentary stays (levy on free nights)', r.levy, `${r.b.guestName || 'guest not named'}, ${villa(r.u)}: ${r.nights} night(s) free, levy share ${m(r.levy, c)} (${r.b.complimentaryReason || 'no reason'}).`);
      }
    }

    /* Levy ISPO paid with nothing earned on the villa to cover it: the out-of-pocket report's own figure. */
    const funded = outOfPocketShortfall(units, tenancies, bookings, input.payments, c, from, to);
    for (const f of funded.fundedMonths) {
      addTo(
        leakGroups,
        'Levy paid with no earnings to cover it',
        f.shortfall,
        `${f.villa}, ${formatMonthLabel(f.month)}: ${m(f.shortfall, c)} ${f.vacant ? '(empty all month)' : '(let, but earned less than the levy)'}.`
      );
    }
    for (const x of funded.crossCurrencyMonths) {
      checks.push(`${x.villa}, ${formatMonthLabel(x.month)}: ${m(x.gap, c)} more levy than ${c} earnings, but ${m(x.otherEarned, x.otherCurrency)} earned in ${x.otherCurrency}; not counted as a leak without an exchange rate.`);
    }
  }

  /* Refunds paid out in the period, and booking money no stay accounts for. */
  {
    const unitOf = new Map(units.map(u => [u.id, u]));
    const inBook = paymentsInBook(input.payments, book).filter(p => p.currency === c && p.status === 'completed' && !p.derived);
    for (const p of inBook.filter(p => p.refundedOn && isWithin(p.refundedOn, from, to) && (p.refundedAmount || 0) > 0)) {
      addTo(
        leakGroups,
        'Refunds paid out',
        p.refundedAmount || 0,
        `${p.payerName || 'payer not recorded'}, ${villa(unitOf.get(p.unitId) || { number: p.unitNumber })}: ${m(p.refundedAmount || 0, c)} refunded ${formatDayLabel(p.refundedOn!)} on receipt ${p.receiptNo || p.id}${p.refundReason ? `, reason: ${p.refundReason}` : ''}.`
      );
    }
    if (book !== 'strata') {
      const unlinked = inBook.filter(p => p.category === 'Booking' && !p.bookingId && !p.forBookingId && isWithin(p.date, from, to));
      if (unlinked.length > 0) {
        checks.push(
          `${unlinked.length} booking receipt(s), ${m(sumMoney(unlinked.map(p => p.amount)), c)}, are linked to no stay, so no stay's balance reflects them: ` +
            unlinked.map(p => `${p.receiptNo || p.id} ${m(p.amount, c)} from ${p.payerName || 'payer not recorded'}, ${villa(unitOf.get(p.unitId) || { number: p.unitNumber })}`).join('; ') +
            '. Link each to its stay.'
        );
      }
    }
  }

  /* 5. ISPO's villas standing empty, and the levy paid on them meanwhile. */
  if (book !== 'strata') {
    const span = nightsBetween(from, addDays(to, 1));
    if (span > 0 && span <= 400) {
      const own = units.filter(u => isOwnAccount(u) && u.status !== 'unavailable' && (u.maintCurrency || u.currency) === c);
      const empty = new Map<string, number>();
      for (let i = 0; i < span; i++) {
        const day = addDays(from, i);
        const occupied = occupiedUnitIdsOn(units, tenancies, bookings, day);
        for (const u of own) if (!occupied.has(u.id)) empty.set(u.id, (empty.get(u.id) || 0) + 1);
      }
      const rows = own
        .filter(u => (empty.get(u.id) || 0) > 0)
        .map(u => {
          const levyPaid = netReceivedInPeriod(
            input.payments.filter(p => p.unitId === u.id && p.category === 'Maintenance' && p.currency === c),
            from,
            to
          );
          const income = netReceivedInPeriod(
            input.payments.filter(p => p.unitId === u.id && (p.category === 'Rent' || p.category === 'Booking') && p.currency === c),
            from,
            to
          );
          return { u, days: empty.get(u.id) || 0, levyPaid, income };
        })
        .sort((a, b) => b.days - a.days || b.levyPaid - a.levyPaid);
      if (rows.length > 0) {
        const levyTotal = sumMoney(rows.map(r => r.levyPaid));
        say({
          rank: NOTABLE,
          atRisk: levyTotal,
          text:
            `${c}: ${rows.length} of ${MANAGING_COMPANY_NAME}'s ${own.length} villas stood empty for ${rows.reduce((a, r) => a + r.days, 0)} of ${own.length * span} villa-days; ` +
            `${m(levyTotal, c)} levy was paid on them in the period.`,
          details: rows.map(
            r =>
              `${villa(r.u)}: empty ${days(r.days)} of ${span}; levy paid ${m(r.levyPaid, c)}; rent and stay income ${m(r.income, c)}` +
              `${r.days === span ? '. Empty all period: find a tenant or guest.' : '.'}`
          )
        });
      }
    }
  }

  /* 6. Unpaid supplier bills, by due date, and the 'Other' bucket. */
  const costs = expensesForBook(liveExpenses(input.expenses), units, book, c).filter(e => e.currency === c);
  const pending = costs.filter(e => e.status === 'pending');
  const pendingInPeriod = pending.filter(e => isWithin(e.dueDate || e.date, from, to));
  const pendingBefore = pending.filter(e => (e.dueDate || e.date) < from);
  const bills = [...pendingBefore, ...pendingInPeriod].sort((a, b) => (a.dueDate || a.date).localeCompare(b.dueDate || b.date));
  if (bills.length > 0) {
    const inPeriodTotal = sumMoney(pendingInPeriod.map(e => e.amount));
    const beforeTotal = sumMoney(pendingBefore.map(e => e.amount));
    const details = bills.map(e => {
      const due = e.dueDate || e.date;
      const late = daysSinceOn(due, to);
      return `Pay ${e.vendor || 'vendor not recorded'}: ${e.description || e.category} ${m(e.amount, c)}, due ${formatDayLabel(due)}${late > 0 ? `, ${days(late)} overdue` : ''}${e.unitNumber ? ` (${e.unitNumber})` : ''}.`;
    });
    if (page?.expensesOutstanding !== undefined && round2(page.expensesOutstanding) !== inPeriodTotal) {
      details.push(
        `Does not tie: "Expenses outstanding" reads ${m(page.expensesOutstanding, c)}; the bills due in the period sum to ${m(inPeriodTotal, c)}; difference ${m(Math.abs(round2(page.expensesOutstanding - inPeriodTotal)), c)}.`
      );
    }
    say({
      rank: URGENT,
      atRisk: sumMoney([inPeriodTotal, beforeTotal]),
      text:
        `${c}: ${bills.length} supplier bill(s) unpaid: ${m(inPeriodTotal, c)} due in the period` +
        (beforeTotal > 0 ? ` and ${m(beforeTotal, c)} due before it.` : '.'),
      details
    });
  }
  const other = costs
    .filter(e => e.status === 'paid' && e.category === 'Other' && isWithin(e.datePaid || e.date, from, to))
    .sort((a, b) => b.amount - a.amount);
  if (other.length > 0) {
    const total = sumMoney(other.map(e => e.amount));
    const top = other.slice(0, 5);
    say({
      rank: NOTABLE,
      atRisk: total,
      text: `${c}: ${m(total, c)} was paid under 'Other' in ${other.length} line(s); check each belongs there and not in a named category.`,
      details: [
        ...top.map(e => `${e.vendor || 'vendor not recorded'}: ${e.description || 'no description'} ${m(e.amount, c)}, paid ${formatDayLabel(e.datePaid || e.date)}.`),
        ...(other.length > top.length ? [`and ${other.length - top.length} smaller line(s) totalling ${m(sumMoney(other.slice(5).map(e => e.amount)), c)}.`] : [])
      ]
    });
  }

  /* 7. Leases ending within 60 days of the period end, and deposits held. */
  if (book !== 'strata') {
    const leases = leasesNeedingAttention(units, tenancies, 60, to).filter(l => l.tenancy.currency === c);
    if (leases.length > 0) {
      say({
        rank: leases.some(l => l.expired) ? URGENT : NOTABLE,
        text: `${c}: ${leases.length} lease(s) end within 60 days of ${formatDayLabel(to)} or have already run out.`,
        details: leases.map(l => {
          const dep = l.tenancy.depositAmount && !l.tenancy.depositReturnedOn ? `; deposit ${m(l.tenancy.depositAmount, l.tenancy.depositCurrency || c)} held` : '';
          return (
            `${l.expired ? 'Renew or end' : 'Decide renewal with'} ${l.tenancy.tenantName}, ${villa(l.unit)}: lease ` +
            `${l.expired ? `ran out ${formatDayLabel(l.leaseEndsOn)}, ${days(-l.daysRemaining)} ago` : `ends ${formatDayLabel(l.leaseEndsOn)}, in ${days(l.daysRemaining)}`}${dep}.`
          );
        })
      });
    }
  }

  /*
   * 8. Utilities billed to villas and not yet recovered, on the book that will
   * receive the recovery (`recoveryFundFor`): an ISPO villa's is ISPO's money,
   * not the corporation's. Before 2026-11-22 every one was shown on the
   * corporation's book and none on ISPO's.
   */
  if (input.utilities) {
    const unitOf = new Map(units.map(u => [u.id, u]));
    const open = input.utilities.filter(
      u =>
        u.status === 'unpaid' &&
        u.currency === c &&
        u.billingPeriod <= to.substring(0, 7) &&
        (book === 'everything' || recoveryFundFor(unitOf.get(u.unitId), `${u.billingPeriod}-01`) === book)
    );
    if (open.length > 0) {
      const total = sumMoney(open.map(u => u.amountCharged));
      for (const u of open) {
        const unit = unitOf.get(u.unitId);
        const who = unit ? (unit.status === 'long-term' ? unit.tenantName : unit.ownerName) || 'payer not recorded' : 'payer not recorded';
        addTo(owedGroups, 'Utilities to recover', u.amountCharged, `${who}, ${villa(unit || { number: u.unitNumber })}: ${m(u.amountCharged, c)} for ${formatMonthLabel(u.billingPeriod)} utilities.`);
      }
      say({
        rank: URGENT,
        atRisk: total,
        text: `${c}: ${open.length} utility bill(s) to villas, ${m(total, c)}, not yet recovered.`,
        details: open
          .sort((a, b) => b.amountCharged - a.amountCharged)
          .map(u => {
            const unit = unitOf.get(u.unitId);
            const who = unit ? (unit.status === 'long-term' ? unit.tenantName : unit.ownerName) || 'payer not recorded' : 'payer not recorded';
            return `Recover ${m(u.amountCharged, c)} from ${who}, ${villa(unit || { number: u.unitNumber })}: ${formatMonthLabel(u.billingPeriod)} utilities.`;
          })
      });
    }
  }

  /*
   * 9. A proprietor's own utility bill sitting in the books. Proprietors pay
   * their own utility accounts (Ro, 2026-11-22); the server refuses new ones,
   * so any found here predate the rule or came in from a restore. Listed on
   * every book that counts it, all time, until it is taken off.
   */
  const unitById = new Map(units.map(u => [u.id, u]));
  const strayUtilities = costs.filter(e => !isUtilityRecoveryRow(e) && isProprietorsOwnUtility(e.category, unitById.get(e.unitId), e.date));
  const strayReadings = (input.utilities || []).filter(
    u => u.currency === c && book !== 'ispo' && isProprietorsOwnUtility('Utilities', unitById.get(u.unitId), `${u.billingPeriod}-01`)
  );
  if (strayReadings.length > 0) {
    say({
      rank: URGENT,
      atRisk: sumMoney(strayReadings.map(u => u.amountCharged)),
      text: `${c}: ${strayReadings.length} meter reading(s) bill proprietors' villas for utilities, ${m(sumMoney(strayReadings.map(u => u.amountCharged)), c)}. Owners hold their own utility accounts: delete each one, or refund it if it was paid.`,
      details: strayReadings
        .sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod))
        .map(u => `${villa(unitById.get(u.unitId) || { number: u.unitNumber })}: ${m(u.amountCharged, c)} for ${formatMonthLabel(u.billingPeriod)}, ${u.status}.`)
    });
  }
  if (strayUtilities.length > 0) {
    const total = sumMoney(strayUtilities.map(e => e.amount));
    say({
      rank: URGENT,
      atRisk: total,
      text: `${c}: ${strayUtilities.length} utility bill(s) on proprietors' villas, ${m(total, c)}, are counted in these books. Owners pay their own utilities: void each one.`,
      details: strayUtilities
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => `${villa(unitById.get(e.unitId) || { number: e.unitNumber })}: ${e.vendor || 'vendor not recorded'} ${m(e.amount, c)}, ${formatDayLabel(e.date)}${e.status === 'pending' ? ', unpaid' : ''}.`)
    });
  }

  const byAmount = (g: Group[]) => g.sort((a, b) => b.amount - a.amount);
  const owedTotal = sumMoney(owedGroups.map(g => g.amount));
  if (owedTotal > 0) {
    say({
      rank: SUMMARY,
      atRisk: owedTotal,
      text:
        `${c}: ${m(owedTotal, c)} is owed at ${formatDayLabel(to)}: ` +
        byAmount(owedGroups).map(g => `${g.group.toLowerCase()} ${m(g.amount, c)}`).join(' · ') +
        (depositCoverTotal > 0 ? `; ${m(depositCoverTotal, c)} of it can be met from deposits held` : '') +
        '.',
      details: [
        ...owedGroups.flatMap(g => [`${g.group}, ${m(g.amount, c)}:`, ...g.lines.map(l => `  ${l}`)]),
        ...(depositCover.length ? [`Can be met from deposits held, ${m(depositCoverTotal, c)}:`, ...depositCover.map(l => `  ${l}`)] : [])
      ]
    });
  }
  // Money held for guests is a liability, not a leak: listed, never in the leak total.
  const leakTotal = sumMoney(leakGroups.filter(g => !g.group.startsWith('Complimentary') && g.group !== HELD_FOR_GUESTS).map(g => g.amount));
  if (leakGroups.length > 0 || checks.length > 0) {
    const comp = leakGroups.find(g => g.group.startsWith('Complimentary'));
    say({
      rank: SUMMARY,
      atRisk: leakTotal,
      text:
        `${c}: where money leaked in the period: ` +
        (leakGroups.length
          ? byAmount(leakGroups.filter(g => g !== comp)).map(g => `${g.group.toLowerCase()} ${m(g.amount, c)}`).join(' · ') +
            (comp ? `${leakTotal > 0 ? ' · ' : ''}complimentary nights cost ${m(comp.amount, c)} in levy${leakTotal > 0 ? ', part of the unfunded levy where the villa earned nothing else' : ''}` : '')
          : 'nothing measurable') +
        (checks.length ? `; ${checks.length} item(s) to check.` : '.'),
      details: [
        ...leakGroups.flatMap(g => [`${g.group}, ${m(g.amount, c)}:`, ...g.lines.map(l => `  ${l}`)]),
        ...(checks.length ? ['To check:', ...checks.map(l => `  ${l}`)] : [])
      ]
    });
  }

  return out;
}

/**
 * Order observations: rank first, then currency (they never meet), then money at
 * risk, largest first. Ties keep the order they were computed in.
 */
export function rankObservations(list: Observation[]): Observation[] {
  const cur = (o: Observation) => (o.currency === 'JMD' ? 0 : o.currency === 'USD' ? 1 : 2);
  return list
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.rank - b.o.rank || cur(a.o) - cur(b.o) || (b.o.atRisk || 0) - (a.o.atRisk || 0) || a.i - b.i)
    .map(x => x.o);
}
