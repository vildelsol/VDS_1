/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the ledger *should* contain, worked out from the register rather than
 * from what somebody remembered to click.
 *
 * Ro, 2026-11-18: *"ensure that it operates the way it should without you or i
 * thinking that there's an actual button we see and click."* Posting used to
 * depend on a person noticing a Hub alert. Missing **rent** months were at least
 * detectable, because a tenancy's start date says which months ought to exist.
 * The **levy** had no equivalent at all: skip November on an owner-occupied villa
 * and no screen anywhere said so, while the arrears, the projection and the owner
 * statements all quietly read as though the levy for that month was never owed.
 *
 * This module is the single enumerator of months that owe a charge and do not
 * have one. The automatic poster bills from it, and the Hub shows whatever it
 * still reports — so the alert becomes a backstop for the machinery rather than
 * the machinery itself.
 *
 * It is deliberately NOT a rule engine. The rules are few, fixed and must be
 * defensible to an owner at an AGM; rules that can be edited at runtime on a
 * money ledger are a liability, not a feature. This is a declarative calendar:
 * derive what should exist, compare with what does, report the difference.
 */

import { Charge, ChargeCategory, Currency, Tenancy, Unit } from '../types';
import { chargeAmount, chargeCurrency, isBillable, rentBreakdown, unbilledOccupancy } from './finance';
import { monthOf, monthsBetween, today } from './dates';

/** One month that ought to carry a charge and does not. */
export interface BacklogMonth {
  unit: Unit;
  category: ChargeCategory;
  /** YYYY-MM */
  month: string;
  currency: Currency;
  amount: number;
}

/**
 * Does an ordinary recurring charge already stand for this account and month?
 *
 * Only an ordinary monthly charge counts. A one-off (a late fee, a recharged
 * repair) and the move-in advance both carry a period month, and counting them
 * would make the calendar believe the month was billed and silently pass over
 * the real rent or levy. This is the same test the posting endpoint applies.
 */
function alreadyBilled(charges: Charge[], unitId: string, category: ChargeCategory, month: string): boolean {
  return charges.some(
    c =>
      c.unitId === unitId &&
      c.category === category &&
      c.periodMonth === month &&
      c.status === 'open' &&
      c.kind === undefined &&
      !c.oneOffType
  );
}

/**
 * The first month this villa's levy was ever billed.
 *
 * A villa that has never been billed for maintenance is NOT back-filled to the
 * start of the books: nobody can say on this application's evidence which months
 * a never-billed villa owed, and inventing a year of arrears is far worse than
 * showing none. Such a villa starts at the current month, and the "not billed"
 * account status is what reports it until then. A voided charge still counts as
 * proof that billing had begun.
 */
function levyBillingBegan(charges: Charge[], unitId: string, asOf: string): string {
  let earliest: string | null = null;
  for (const c of charges) {
    if (c.unitId !== unitId || c.category !== 'Maintenance') continue;
    if (c.kind !== undefined || c.oneOffType) continue;
    if (!c.periodMonth) continue;
    if (earliest === null || c.periodMonth < earliest) earliest = c.periodMonth;
  }
  return earliest || monthOf(asOf);
}

/**
 * Every month that owes a charge and has none, for both categories.
 *
 * Rent is delegated to `unbilledOccupancy` so that there is exactly one rule in
 * the application for "this tenancy's month was never billed" — including its
 * handling of the final month covered by the move-in advance.
 *
 * `closedThrough` months are excluded. A closed month's money is fingerprinted
 * and the integrity guard refuses any write that moves it, so posting into one
 * would be refused and nothing saved; reporting it as a backlog month would only
 * ask somebody to attempt the impossible. Reopen the period to bill it.
 */
export function billingBacklog(
  units: Unit[],
  tenancies: Tenancy[],
  charges: Charge[],
  asOf: string = today(),
  booksBeginOn?: string,
  closedThrough?: string
): BacklogMonth[] {
  const out: BacklogMonth[] = [];
  const thisMonth = monthOf(asOf);
  const floor = booksBeginOn ? monthOf(booksBeginOn) : null;
  const open = (month: string) => (!closedThrough || month > closedThrough) && (!floor || month >= floor);

  for (const row of unbilledOccupancy(units, tenancies, charges, asOf, booksBeginOn)) {
    for (const month of row.months) {
      if (!open(month)) continue;
      out.push({
        unit: row.unit,
        category: 'Rent',
        month,
        currency: row.currency,
        amount: rentBreakdown(row.unit, row.tenancy.monthlyRent, row.currency).total
      });
    }
  }

  for (const unit of units) {
    if (!isBillable(unit, 'Maintenance')) continue;
    const start = levyBillingBegan(charges, unit.id, asOf);
    if (start > thisMonth) continue;
    for (const month of monthsBetween(`${start}-01`, `${thisMonth}-01`)) {
      if (!open(month)) continue;
      if (alreadyBilled(charges, unit.id, 'Maintenance', month)) continue;
      out.push({
        unit,
        category: 'Maintenance',
        month,
        currency: chargeCurrency(unit, 'Maintenance'),
        amount: chargeAmount(unit, 'Maintenance')
      });
    }
  }

  return out.sort((a, b) => a.month.localeCompare(b.month) || a.unit.number.localeCompare(b.unit.number));
}

/** The distinct months the backlog touches, oldest first. Posting works a month at a time. */
export function monthsToPost(backlog: BacklogMonth[]): string[] {
  return [...new Set(backlog.map(b => b.month))].sort();
}
