/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Four hundred scenarios on a fully populated property, auditing the books
 * *and* the management reporting layer after every single one.
 *
 * The existing simulations prove the ledger survives being battered. This one
 * adds the question those cannot ask: after all that battering, do the figures
 * management is shown still agree with the ledger they are drawn from?
 *
 * That matters because the reporting layer restates the same money three ways —
 * an ageing schedule, an occupancy series, a collection rate — and each of those
 * is a chance to disagree with the balance it came from. The statutory return is
 * built on the same ageing function, so a divergence here is a divergence in a
 * document filed with the Commission.
 *
 * After each scenario this asserts, over the whole accumulated database:
 *
 *  - every invariant the ledger simulations assert (receipts, balances, stays);
 *  - the aged arrears buckets total exactly the outstanding balance, per
 *    currency — the invariant Form 13B is built on;
 *  - the management ageing and the statutory return bucket the same debt
 *    identically;
 *  - occupancy never exceeds the register, and never goes negative;
 *  - no reported figure anywhere is NaN or Infinity;
 *  - and the collection rate is either a finite number or an honest null.
 *
 * Scenarios come from a seeded generator, so a failure names a seed that
 * reproduces it exactly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Four hundred scenarios with reporting integrity';

const SCENARIO_COUNT = 400;

/** The real client-side finance module, not a copy of its rules. */
async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-400-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const money = (rand, low, high) => Math.round((low + rand() * (high - low)) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
/**
 * The month a scenario acts in.
 *
 * Derived from how many times this scenario has already run, **not** from `i`
 * directly. A scenario only runs when `i % scenarios.length` selects it, so
 * `monthOf(i)` is *constant* for a given scenario whenever the scenario count is
 * a multiple of twelve — every run lands in the same month, records that dedupe
 * per period collapse to one, and the simulation quietly stops covering the
 * ground its assertions claim. Adding two scenarios took the count to 24 and cut
 * utility readings from dozens to ten, all settled.
 *
 * Taking the repetition number instead varies the month whatever the scenario
 * count is.
 */
const monthOf = n => `2026-${pad((n % 12) + 1)}`;
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;
const isBadNumber = v => typeof v === 'number' && !Number.isFinite(v);
const cents = v => Math.round(v * 100);

/* ------------------------------------------------------------------ *
 * The books
 * ------------------------------------------------------------------ */

function auditDatabase(db) {
  const problems = [];
  const { payments = [], charges = [], bookings = [], units = [], expenses = [], utilities = [], tenancies = [] } = db;

  const ids = payments.map(p => p.id);
  if (new Set(ids).size !== ids.length) problems.push('two payments share an id');

  const numbers = payments.filter(p => p.receiptNo).map(p => p.receiptNo);
  if (new Set(numbers).size !== numbers.length) problems.push('two receipts share a number');

  for (const p of payments) {
    if (p.status === 'pending' && p.receiptNo) problems.push(`pending payment ${p.id} holds a receipt`);
    if (p.status === 'completed' && !p.receiptNo) problems.push(`received payment ${p.id} has no receipt number`);
    if (isBadNumber(p.amount)) problems.push(`payment ${p.id} has a non-finite amount`);
    if (typeof p.amount === 'number' && p.amount <= 0) problems.push(`payment ${p.id} is not a positive amount`);
    if (p.refundedAmount && p.refundedAmount > p.amount + 1e-9) problems.push(`payment ${p.id} over-refunded`);
    if (p.currency && !['JMD', 'USD'].includes(p.currency)) problems.push(`payment ${p.id} is in ${p.currency}`);
  }

  for (const c of charges) {
    if (isBadNumber(c.amount)) problems.push(`charge ${c.id} has a non-finite amount`);
    if (typeof c.amount === 'number' && c.amount <= 0) problems.push(`charge ${c.id} is not positive`);
  }

  /*
   * A re-post after a void must never double-bill a month.
   *
   * Two charge kinds legitimately share a unit, category and period, and neither
   * is a double-billing:
   *
   *   - a one-off (a late fee, a repair recharge) sits alongside the rent for
   *     the month it was raised in;
   *   - the advance charge for a tenant's *final* month, raised at move-in under
   *     first-and-last-rent, carries the move-in month as its period even though
   *     it is not that month's rent. It is marked `advance-final-month` and is
   *     consumed when the tenancy closes.
   *
   * The invariant is one *ordinary* charge per unit, category and month. The
   * other two scenario suites use the narrower rule and would raise the same
   * false alarm if their scenarios ever opened a first-and-last tenancy.
   */
  const seen = new Map();
  const ordinary = charges.filter(x => x.status === 'open' && !x.oneOffType && x.kind !== 'advance-final-month');
  for (const c of ordinary) {
    const key = `${c.unitId}|${c.category}|${c.periodMonth}`;
    if (seen.has(key)) problems.push(`${key} is billed twice`);
    else seen.set(key, c.id);
  }

  for (const b of bookings) {
    if (b.checkOut <= b.checkIn) problems.push(`booking ${b.id} checks out before it checks in`);
    if (isBadNumber(b.amount) || isBadNumber(b.depositPaid)) problems.push(`booking ${b.id} has a non-finite figure`);
  }
  const byUnit = new Map();
  for (const b of bookings.filter(x => x.status === 'confirmed')) {
    const list = byUnit.get(b.unitId) || [];
    for (const other of list) {
      if (b.checkIn < other.checkOut && other.checkIn < b.checkOut) {
        problems.push(`villa ${b.unitNumber} is sold twice over ${b.checkIn}..${b.checkOut}`);
      }
    }
    list.push(b);
    byUnit.set(b.unitId, list);
  }

  for (const e of expenses) if (isBadNumber(e.amount)) problems.push(`expense ${e.id} has a non-finite amount`);

  // A standing cost posted twice for one month would pay the vendor twice.
  const postedMonths = new Map();
  for (const e of expenses.filter(x => x.recurringId && x.periodMonth)) {
    const key = `${e.recurringId}|${e.periodMonth}`;
    if (postedMonths.has(key)) problems.push(`standing cost ${key} is posted twice`);
    else postedMonths.set(key, e.id);
  }

  // A work order's cost must reach the expense register exactly once.
  for (const a of (db.unitActivities || []).filter(x => x.expenseId)) {
    const matches = expenses.filter(e => e.id === a.expenseId).length;
    if (matches > 1) problems.push(`work order ${a.id} raised its cost ${matches} times`);
  }
  for (const u of utilities) if (isBadNumber(u.amountCharged)) problems.push(`utility ${u.id} has a non-finite figure`);
  for (const u of units) {
    if (isBadNumber(u.monthlyRent) || isBadNumber(u.monthlyMaintenance)) problems.push(`villa ${u.number} has a non-finite rate`);
  }
  for (const t of tenancies) {
    if (t.depositReturnedOn && t.depositAmount === undefined) problems.push(`tenancy ${t.id} returned a deposit it never held`);
    if (isBadNumber(t.depositAmount) || isBadNumber(t.monthlyRent)) problems.push(`tenancy ${t.id} has a non-finite figure`);
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * The figures management is shown
 * ------------------------------------------------------------------ */

/**
 * Everything the reporting layer restates must still agree with the ledger.
 * `fin` is the real finance module the application itself renders from.
 */
function auditReporting(db, fin, asOf) {
  const problems = [];
  const { units = [], charges = [], payments = [], tenancies = [], bookings = [] } = db;

  /* --- ageing totals the balance, per currency --- */

  const ageing = fin.arrearsAgeing(units, charges, payments, asOf);
  for (const entry of ageing) {
    const b = entry.buckets;
    for (const [key, value] of Object.entries(b)) {
      if (isBadNumber(value)) problems.push(`ageing ${entry.currency}.${key} is not finite`);
      if (typeof value === 'number' && value < 0) problems.push(`ageing ${entry.currency}.${key} is negative`);
    }
    const summed = cents(b.d30) + cents(b.d60) + cents(b.d90) + cents(b.over90);
    if (summed !== cents(b.total)) {
      problems.push(`ageing ${entry.currency} columns (${summed}) do not total ${cents(b.total)}`);
    }

    // The whole point: the schedule must equal the money actually outstanding.
    const owed = units.reduce((total, unit) => {
      for (const category of ['Rent', 'Maintenance']) {
        const account = fin.accountBalance(unit, category, charges, payments, asOf, units);
        if (account.currency === entry.currency && account.balance > 0) total += cents(account.balance);
      }
      return total;
    }, 0);
    if (summed !== owed) {
      problems.push(`ageing ${entry.currency} totals ${summed} but ${owed} is outstanding`);
    }
  }

  /* --- the chart and the statutory return agree --- */

  const form = fin.form13BContributions(units, charges, payments, asOf);
  for (const row of form.rows) {
    const viaShared = fin.ageAccountArrears(row.unit, 'Maintenance', charges, payments, asOf, units);
    for (const key of ['d30', 'd60', 'd90', 'over90', 'total']) {
      if (cents(viaShared.buckets[key]) !== cents(row.buckets[key])) {
        problems.push(`villa ${row.unit.number} ${key}: return ${row.buckets[key]} vs chart ${viaShared.buckets[key]}`);
      }
    }
  }

  /* --- occupancy stays inside the register --- */

  const occupied = fin.occupiedUnitIdsOn(units, tenancies, bookings, asOf);
  if (occupied.size > units.length) problems.push(`${occupied.size} villas occupied of ${units.length} on the register`);

  const series = fin.occupancySeries(units, tenancies, bookings, ['2026-01', '2026-06', '2026-12'], asOf);
  for (const row of series) {
    if (row.occupied < 0) problems.push(`${row.month} reports negative occupancy`);
    if (row.occupied > row.total) problems.push(`${row.month} reports ${row.occupied} let of ${row.total}`);
    if (row.rate !== null && (isBadNumber(row.rate) || row.rate < 0 || row.rate > 100)) {
      problems.push(`${row.month} occupancy rate is ${row.rate}`);
    }
  }

  /* --- the owner statement adds up, and bills one supply once --- */

  /*
   * The statement restates the same money a fourth way, so it gets the same
   * treatment as the ageing schedule: its own arithmetic must close, and it must
   * not bill a proprietor for something they were never charged.
   */
  const statements = fin.ownerStatements(units, charges, payments, db.expenses || [], db.utilities || [], '2026-01-01', '2026-12-31');
  for (const s of statements) {
    for (const [field, value] of Object.entries({
      collected: s.collected,
      maintenanceBilled: s.maintenanceBilled,
      utilityBilled: s.utilityBilled,
      expenses: s.expenses,
      net: s.net
    })) {
      if (isBadNumber(value)) problems.push(`statement ${s.unit.number} ${s.currency}: ${field} is not finite`);
    }

    /*
     * The identity the whole page is built on.
     *
     * What is deducted is the contribution still *outstanding* for the period,
     * not the whole of what was billed. Deducting `maintenanceBilled` alone told
     * a proprietor who had already paid that they still owed every penny of it —
     * found on real data on 2026-09-01, when a settled owner's statement read
     * "Due from <name>" beside a line confirming the money had been received.
     */
    const maintenanceOwed = cents(s.maintenanceBilled) - cents(s.maintenancePaid);
    const expected = cents(s.collected) - maintenanceOwed - cents(s.utilityBilled) - cents(s.expenses);
    if (cents(s.net) !== expected) {
      problems.push(`statement ${s.unit.number} ${s.currency}: net ${cents(s.net)} does not equal ${expected}`);
    }

    // A supplier's utility invoice is the corporation's cost, recovered by the
    // meter reading. Recharging it as well would bill one supply twice.
    if (s.expenseItems.some(e => e.category === 'Utilities')) {
      problems.push(`statement ${s.unit.number} ${s.currency}: a supplier utility invoice was recharged to the owner`);
    }

    // Every itemised figure must reconcile with the total it is shown beneath.
    const itemisedUtility = s.utilityCharges.reduce((sum, u) => sum + cents(u.amountCharged), 0);
    if (itemisedUtility !== cents(s.utilityBilled)) {
      problems.push(`statement ${s.unit.number} ${s.currency}: utility lines total ${itemisedUtility}, stated ${cents(s.utilityBilled)}`);
    }
    const itemisedMaint = s.maintenanceCharges.reduce((sum, ch) => sum + cents(ch.amount), 0);
    if (itemisedMaint !== cents(s.maintenanceBilled)) {
      problems.push(`statement ${s.unit.number} ${s.currency}: maintenance lines total ${itemisedMaint}, stated ${cents(s.maintenanceBilled)}`);
    }
    const itemisedExpenses = s.expenseItems.reduce((sum, e) => sum + cents(e.amount), 0);
    if (itemisedExpenses !== cents(s.expenses)) {
      problems.push(`statement ${s.unit.number} ${s.currency}: expense lines total ${itemisedExpenses}, stated ${cents(s.expenses)}`);
    }

    // Currency is never blended, on this page or any other.
    if (s.utilityCharges.some(u => u.currency !== s.currency)) {
      problems.push(`statement ${s.unit.number} ${s.currency}: carries a utility charge in another currency`);
    }
    if (s.maintenanceCharges.some(ch => ch.currency !== s.currency)) {
      problems.push(`statement ${s.unit.number} ${s.currency}: carries a charge in another currency`);
    }
  }

  /* --- collection rate is a number or an honest null --- */

  for (const currency of ['JMD', 'USD']) {
    const billed = fin.chargedInPeriod(charges, currency, '2026-01-01', '2026-12-31');
    const owner = fin.ownerBilledUnitIds(units);
    const collected = fin.collectedInPeriod(payments, currency, '2026-01-01', '2026-12-31', owner);
    const rate = fin.collectionRate(billed.total, collected.rent + collected.maintenance);
    if (rate !== null && isBadNumber(rate)) problems.push(`${currency} collection rate is ${rate}`);
    if (isBadNumber(billed.total) || isBadNumber(collected.total)) problems.push(`${currency} period totals are not finite`);

    // The receivable position the board pack and the statement both quote.
    for (const unit of units) {
      for (const category of ['Rent', 'Maintenance']) {
        const account = fin.accountBalance(unit, category, charges, payments, asOf, units);
        if (isBadNumber(account.balance)) problems.push(`villa ${unit.number} ${category} balance is not finite`);
        if (!Number.isSafeInteger(cents(account.balance))) {
          problems.push(`villa ${unit.number} ${category} does not total whole cents`);
        }
      }
    }
  }


  /* --- the annual report: the AGM document and the Commission's basis --- */

  // Audited on every scenario because these figures leave the building. An
  // owner adds the allocation column up with a pen, and the same numbers are
  // the basis of what goes to the Commission of Strata Corporations.
  for (const currency of ['JMD', 'USD']) {
    for (const year of [2025, 2026]) {
      const r = fin.annualOwnersReport(units, charges, payments, db.expenses || [], currency, year);

      for (const [name, v] of Object.entries({
        expenditure: r.expenditure,
        perUnitAnnual: r.perUnitAnnual,
        perUnitMonthly: r.perUnitMonthly,
        feeBilled: r.feeBilled,
        contributionsAnnual: r.contributionsAnnual,
        annualCommunityPosition: r.annualCommunityPosition,
        budgetExpenditure: r.budgetExpenditure,
        feeToCoverBudget: r.feeToCoverBudget,
        reserveAnnual: r.reserveAnnual,
        reductionRequired: r.reductionRequired
      })) {
        if (isBadNumber(v)) problems.push(`${currency} ${year} annual report ${name} is ${v}`);
      }

      // The allocation table has to add up exactly — this is the column an
      // owner checks by hand, and a penny out is what produced a corrections
      // log on the real 2026 report.
      if (cents(r.budgetExpenditure) + cents(r.reserveAnnual) !== cents(r.proposedAnnualCommunity)) {
        problems.push(
          `${currency} ${year} allocation column does not add up: ${r.budgetExpenditure} + ${r.reserveAnnual} != ${r.proposedAnnualCommunity}`
        );
      }

      // The recommended contribution must actually cover the budget it is
      // recommended for, never fall a few dollars short of it.
      if (r.contributingUnits > 0 && cents(r.feeToCoverBudget * r.contributingUnits * 12) < cents(r.budgetExpenditure)) {
        problems.push(`${currency} ${year} recommended contribution does not cover its own budget`);
      }

      // The breakdown must reconcile with the total it breaks down, and the
      // budget with its own lines.
      const actualSum = r.categories.reduce((t, c) => t + cents(c.actual), 0);
      if (actualSum !== cents(r.expenditure)) {
        problems.push(`${currency} ${year} category actuals sum to ${actualSum} against expenditure ${cents(r.expenditure)}`);
      }
      const budgetSum = r.categories.reduce((t, c) => t + cents(c.budget), 0);
      if (budgetSum !== cents(r.budgetExpenditure)) {
        problems.push(`${currency} ${year} category budgets sum to ${budgetSum} against ${cents(r.budgetExpenditure)}`);
      }

      // Twelve months, and they sum to the year.
      if (r.months.length !== 12) problems.push(`${currency} ${year} annual report has ${r.months.length} months`);
      const monthSum = r.months.reduce((t, m) => t + cents(m.expenditure), 0);
      if (monthSum !== cents(r.expenditure)) {
        problems.push(`${currency} ${year} monthly expenditure sums to ${monthSum} against ${cents(r.expenditure)}`);
      }
      if (r.monthsCovered + r.monthsOver.length !== 12) {
        problems.push(`${currency} ${year} months covered and over do not make twelve`);
      }

      // The headline gap is the contributions less the cost, and nothing else.
      if (cents(r.contributionsAnnual) - cents(r.expenditure) !== cents(r.annualCommunityPosition)) {
        problems.push(`${currency} ${year} community position does not equal contributions less expenditure`);
      }
    }
  }

  /* --- the health grade must be reproducible from what it shows --- */

  for (const currency of ['JMD', 'USD']) {
    const h = fin.operationalHealth(units, charges, payments, db.expenses || [], currency, '2026-01-01', '2026-12-31');
    if (!h) continue;

    if (isBadNumber(h.score)) problems.push(`${currency} health score is ${h.score}`);
    if (h.score < 0 || h.score > 100) problems.push(`${currency} health score is out of range: ${h.score}`);
    if (h.grade !== fin.gradeFor(h.score)) problems.push(`${currency} health grade ${h.grade} does not match score ${h.score}`);

    const weightSum = h.components.reduce((t, c) => t + c.weight, 0);
    if (Math.abs(weightSum - 100) > 0.05) problems.push(`${currency} health weights sum to ${weightSum}`);

    // The whole reason the card prints its components: the letter has to be
    // reproducible from exactly what is on screen beside it.
    const rebuilt = h.components.reduce((t, c) => t + c.score * (c.weight / 100), 0);
    if (Math.abs(rebuilt - h.score) > 0.05) {
      problems.push(`${currency} health score ${h.score} cannot be rebuilt from its components (${rebuilt})`);
    }
    for (const c of h.components) {
      if (isBadNumber(c.score) || c.score < 0 || c.score > 100) problems.push(`${currency} health component ${c.key} scores ${c.score}`);
      if (!c.detail) problems.push(`${currency} health component ${c.key} states no figures`);
    }
  }

  /* --- the out-of-pocket shortfall holds together --- */

  /*
   * Nothing in the simulation ticks "let on the corporation's own account", so
   * the engine would otherwise be audited against an empty report on every one
   * of the 400 scenarios — a green assertion that means nothing, which is the
   * failure mode this suite has already been caught by twice. Every third villa
   * is flagged on a *copy* of the register, so the engine sees real tenancies,
   * bookings and receipts without the simulation itself being changed.
   */
  {
    const flagged = units.map((u, i) => (i % 3 === 0 ? { ...u, letOnOwnAccount: true } : u));
    let linesSeen = 0;

    for (const currency of ['JMD', 'USD']) {
      const r = fin.outOfPocketShortfall(flagged, tenancies, bookings, payments, currency, '2026-01-01', asOf);
      linesSeen += r.lines.length;

      const named = new Set(r.currencyNotes.map(n => n.unitId));
      for (const line of r.lines) {
        if (isBadNumber(line.rentReceived) || isBadNumber(line.maintenancePaid) || isBadNumber(line.shortfall)) {
          problems.push(`${currency} shortfall line ${line.villa} ${line.month} carries a non-finite figure`);
        }
        if (line.shortfall < 0) problems.push(`${currency} shortfall for ${line.villa} ${line.month} is negative`);
        // Earnings are rent and short-stay together — a villa let on Airbnb pays
        // towards its own contribution, which is the correction Ro made on
        // 2026-09-02 after reading the first cut of this report.
        if (cents(line.earned) !== cents(line.rentReceived) + cents(line.shortStayReceived)) {
          problems.push(`${currency} ${line.villa} ${line.month} earned ${cents(line.earned)}, not rent plus short stay`);
        }
        // The definition, restated: what was paid over and above what came in.
        const expected = Math.max(0, cents(line.maintenancePaid) - cents(line.earned));
        if (cents(line.shortfall) !== expected) {
          problems.push(`${currency} shortfall for ${line.villa} ${line.month} is ${cents(line.shortfall)}, not ${expected}`);
        }
        if (line.occupiedDays > line.daysCounted) {
          problems.push(`${currency} ${line.villa} ${line.month} was let for ${line.occupiedDays} of ${line.daysCounted} days`);
        }
        if (line.vacant !== (line.occupiedDays === 0)) {
          problems.push(`${currency} ${line.villa} ${line.month} is marked vacant against ${line.occupiedDays} let day(s)`);
        }
        if (named.has(line.unitId)) {
          problems.push(`${currency} ${line.villa} was given a row and declared uncomputable at the same time`);
        }
      }

      // Two views off one engine: they have to agree, and with the totals.
      const fromLines = r.lines.reduce((t, l) => t + cents(l.shortfall), 0);
      const fromVillas = r.byVilla.reduce((t, v) => t + cents(v.shortfall), 0);
      const fromMonths = r.byMonth.reduce((t, m) => t + cents(m.shortfall), 0);
      if (fromLines !== fromVillas || fromLines !== fromMonths || fromLines !== cents(r.totalShortfall)) {
        problems.push(`${currency} shortfall views disagree: lines ${fromLines}, villas ${fromVillas}, months ${fromMonths}, total ${cents(r.totalShortfall)}`);
      }

      // The headline names every month that cost something — the empty ones are
      // a subset of it and can never be larger than the whole.
      const fundedLines = r.lines.filter(l => l.shortfall > 0);
      if (r.fundedVillaMonths !== fundedLines.length) {
        problems.push(`${currency} headline counts ${r.fundedVillaMonths} funded villa-months against ${fundedLines.length}`);
      }
      if (cents(r.vacantShortfall) > cents(r.totalShortfall) || r.vacantVillaMonths > r.fundedVillaMonths) {
        problems.push(`${currency} the empty-month subset is larger than the whole`);
      }
      if (cents(r.vacantShortfall) !== fundedLines.filter(l => l.vacant).reduce((t, l) => t + cents(l.shortfall), 0)) {
        problems.push(`${currency} vacant shortfall does not sum its own empty months`);
      }
      // Named, not merely counted — the figure is useless without the list.
      for (const v of r.fundedMonths) {
        const line = r.lines.find(l => l.unitId === v.unitId && l.month === v.month);
        if (!line || cents(line.shortfall) !== cents(v.shortfall) || line.vacant !== v.vacant) {
          problems.push(`${currency} named month ${v.villa} ${v.month} does not match its own line`);
        }
      }
      // A villa that is not VDS's own has no business on this report.
      const own = new Set(flagged.filter(u => u.letOnOwnAccount === true).map(u => u.id));
      for (const v of r.byVilla) {
        if (!own.has(v.unitId)) problems.push(`${currency} shortfall reports ${v.villa}, which is not let on the corporation's own account`);
      }
    }

    // The guard the annual-report lesson bought: assertions that ran against
    // nothing are not coverage.
    if (linesSeen === 0) problems.push('the shortfall audit ran against an empty report');
  }

  return problems;
}

/* ------------------------------------------------------------------ */

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'ThreeHundred-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'ThreeHundred-1234!', 'ThreeHundredNew-9876!');

    /* ---------------- a property that looks like a real one ---------------- */

    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const setup = rng(31);
    const longLets = [];
    const shortLets = [];

    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      let body;
      if (i % 4 === 3) {
        body = { number, ownerName: `Owner ${i}`, status: 'short-term', monthlyMaintenance: money(setup, 150, 600), currency: 'USD', maintCurrency: 'USD' };
        shortLets.push(id);
      } else if (i === 14) {
        body = { number, ownerName: `Owner ${i}`, status: 'unavailable', currency: 'JMD', maintCurrency: 'JMD' };
      } else if (i === 13) {
        body = { number, ownerName: `Owner ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 18000), currency: 'JMD', maintCurrency: 'JMD' };
      } else if (i === 12) {
        // One villa billed entirely in USD, so no currency is ever the only one.
        body = { number, ownerName: `Owner ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: `Tenant ${i}`, status: 'long-term', monthlyRent: money(setup, 700, 2400), monthlyMaintenance: money(setup, 100, 400), currency: 'USD', maintCurrency: 'USD', rentDueDay: 1, maintDueDay: 1 };
        longLets.push(id);
      } else {
        body = { number, ownerName: `Owner ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: `Tenant ${i}`, status: 'long-term', monthlyRent: money(setup, 45000, 140000), monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 };
        longLets.push(id);
      }
      await c.put(`/api/units/${id}`, body);
    }

    T.check('the property is fully configured', (await c.get('/api/db')).body.units.length === 16);
    T.check('with long lets, short lets, an owner-occupier and one off the market', longLets.length > 5 && shortLets.length >= 3);

    const templates = [];
    for (const [vendor, category, amount] of [
      ['Atlas Security Jamaica', 'Security', 180000],
      ['Jamaica Public Service Company', 'Utilities', 95000],
      ['Ocho Rios Garden Services', 'Landscaping', 60000]
    ]) {
      const t = await c.post('/api/recurring-expenses', { vendor, category, amount, currency: 'JMD', dueDay: 5, description: 'standing monthly cost' });
      if (t.body?.template?.id) templates.push(t.body.template.id);
    }
    T.check('the standing monthly costs are on file', templates.length === 3, `${templates.length} of 3`);

    /* ---------------- what a property actually does ---------------- */

    const ok = r => r.status === 200;
    const anyLong = rand => pick(rand, longLets);
    const anyShort = rand => pick(rand, shortLets);

    const scenarios = [
      // The month is billed and most tenants pay it.
      async ({ month, rand }) => {
        await c.post('/api/charges/post-month', { monthString: month });
        const db = (await c.get('/api/db')).body;
        const open = db.charges.filter(x => x.periodMonth === month && x.status === 'open');
        for (const charge of open) {
          if (rand() < 0.25) continue; // a quarter go unpaid, building real arrears
          const p = await c.post('/api/payments', { unitId: charge.unitId, category: charge.category, amount: charge.amount, currency: charge.currency, payerName: charge.payerName || 'Payer', method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']) });
          if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
        }
      },

      // A tenant pays part of what is owed.
      async ({ month, rand }) => {
        await c.post('/api/charges/post-month', { monthString: month });
        const unitId = anyLong(rand);
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount: money(rand, 1000, 25000), currency: 'JMD', payerName: 'Part payer', method: 'Cash', confirmNoOpenCharge: true });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // Money taken and handed back.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        const amount = money(rand, 5000, 40000);
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Refunded', method: 'Cash', confirmNoOpenCharge: true });
        const id = p.body?.payment?.id;
        if (!id) return;
        await c.post(`/api/payments/${id}/confirm`, {});
        await c.post(`/api/payments/${id}/refund`, { amount: Math.round(amount * pick(rand, [0.25, 0.5, 1]) * 100) / 100, reason: 'overcharged in error' });
      },

      // A receipt voided and taken again properly.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        const amount = money(rand, 3000, 30000);
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Voided', method: 'Cash', confirmNoOpenCharge: true });
        const id = p.body?.payment?.id;
        if (!id) return;
        await c.post(`/api/payments/${id}/confirm`, {});
        await c.post(`/api/payments/${id}/reverse`, { reversalReason: 'recorded against the wrong villa' });
        const again = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Voided', method: 'Bank Transfer', confirmNoOpenCharge: true });
        if (again.body?.payment?.id) await c.post(`/api/payments/${again.body.payment.id}/confirm`, {});
      },

      // A month posted, voided and posted again — the double-billing trap.
      async ({ month }) => {
        await c.post('/api/charges/post-month', { monthString: month });
        const open = (await c.get('/api/db')).body.charges.filter(x => x.periodMonth === month && x.status === 'open');
        if (open.length) await c.post(`/api/charges/${open[0].id}/void`, { reason: 'billed at the wrong rate' });
        await c.post('/api/charges/post-month', { monthString: month });
      },

      // A late fee, then settled.
      async ({ month, rand }) => {
        const unitId = anyLong(rand);
        const amount = money(rand, 500, 8000);
        const raised = await c.post('/api/charges', { unitId, category: 'Rent', oneOffType: pick(rand, ['Late fee', 'Repair recharge', 'Fine / breach', 'Amenity fee']), amount, dueDate: dayIn(month, 15), description: 'raised during the simulation' });
        if (!ok(raised)) return;
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Settled', method: 'Cash', confirmNoOpenCharge: true });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // A meter read and the bill settled.
      async ({ month, rand }) => {
        const unitId = anyLong(rand);
        const prev = Math.floor(rand() * 500);
        const u = await c.post('/api/utilities', { unitId, billingPeriod: month, previousReading: prev, currentReading: prev + Math.floor(rand() * 400), amountCharged: money(rand, 1000, 20000), currency: 'JMD' });
        const id = u.body?.utility?.id;
        if (!id) return;
        const settled = await c.post(`/api/utilities/${id}/settle`, { method: 'Cash' });
        if (settled.body?.payment?.id) await c.post(`/api/payments/${settled.body.payment.id}/confirm`, {});
      },

      // A short stay with a deposit.
      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const start = 1 + (i % 20);
        await c.post('/api/bookings', { unitId, guestName: `Guest ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 1 + (i % 5)), amount: money(rand, 200, 3000), depositPaid: money(rand, 50, 400), currency: 'USD', source: pick(rand, ['Direct', 'Airbnb', 'Booking.com']) });
      },

      // A stay cancelled after a deposit was taken.
      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const start = 1 + (i % 18);
        const b = await c.post('/api/bookings', { unitId, guestName: `Cancelling ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 2), amount: money(rand, 300, 2000), depositPaid: money(rand, 100, 300), currency: 'USD', source: 'Direct' });
        if (b.body?.booking?.id) await c.put(`/api/bookings/${b.body.booking.id}`, { status: 'cancelled' });
      },

      // Overlapping stays: the second must be refused.
      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const start = 1 + (i % 15);
        await c.post('/api/bookings', { unitId, guestName: `First ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 3), amount: 500, depositPaid: 0, currency: 'USD', source: 'Direct' });
        await c.post('/api/bookings', { unitId, guestName: `Clashing ${i}`, checkIn: dayIn(month, start + 1), checkOut: dayIn(month, start + 4), amount: 500, depositPaid: 0, currency: 'USD', source: 'Direct' });
      },

      // A calendar hold, which must never count as a guest in residence.
      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const start = 1 + (i % 12);
        await c.post('/api/bookings', { unitId, guestName: 'Owner block', checkIn: dayIn(month, start), checkOut: dayIn(month, start + 2), amount: 0, depositPaid: 0, currency: 'USD', source: pick(rand, ['Blocked', 'Unavailable']) });
      },

      // Running costs.
      async ({ month, rand }) => {
        await c.post('/api/expenses', { category: pick(rand, ['Maintenance', 'Security', 'Landscaping', 'Utilities', 'Payroll', 'Supplies', 'Contractors', 'Property Taxes']), description: 'simulated cost', amount: money(rand, 500, 60000), currency: pick(rand, ['JMD', 'USD']), date: dayIn(month, 1 + Math.floor(rand() * 27)), vendor: 'Vendor' });
      },

      // A tenancy begun, so occupancy has dated evidence to read.
      // Opened from the units register, which is the only way one is created —
      // there is no endpoint that mints a tenancy directly.
      async ({ month, rand, i }) => {
        const unitId = anyLong(rand);
        await c.put(`/api/units/${unitId}`, {
          number: unitId.replace('unit-', ''),
          ownerName: 'Owner',
          tenantName: `Resident ${i}`,
          tenantChangeIntent: 'changeover',
          ownerChangeIntent: 'correction',
          status: 'long-term',
          monthlyRent: money(rand, 40000, 120000),
          monthlyMaintenance: money(rand, 6000, 15000),
          currency: 'JMD',
          maintCurrency: 'JMD',
          rentDueDay: 1,
          maintDueDay: 1,
          tenancyStartedOn: dayIn(month, 1),
          leaseEndsOn: '2026-12-31'
        });
      },

      // And one ended, which must not erase the months it ran.
      async ({ month, rand }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active');
        if (!live.length) return;
        const t = pick(rand, live);
        await c.put(`/api/tenancies/${t.id}`, { endedOn: dayIn(month, 28), endReason: 'Lease ended; keys returned.' });
      },

      // A security deposit held, then returned with a deduction.
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active' && !t.depositAmount);
        if (!live.length) return;
        const t = pick(rand, live);
        const held = money(rand, 10000, 60000);
        const taken = await c.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Cash' });
        if (!ok(taken)) return;
        await c.post(`/api/tenancies/${t.id}/deposit/settle`, { withheldAmount: Math.round(held * 0.25 * 100) / 100, reason: 'damage to a door' });
      },

      // Money in the wrong currency — refused, never absorbed.
      async ({ rand }) => {
        await c.post('/api/payments', { unitId: anyLong(rand), category: 'Rent', amount: money(rand, 100, 5000), currency: 'USD', payerName: 'Confused payer', method: 'Cash', confirmNoOpenCharge: true });
      },

      // Figures that are not figures.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        for (const amount of ['1.500.000', '1e999', '50000abc', -5, 0, Infinity, NaN, null, {}, []]) {
          await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Fat finger', method: 'Cash', confirmNoOpenCharge: true });
        }
        await c.post('/api/expenses', { category: 'Maintenance', description: 'bad figure', amount: '1.500.000', currency: 'JMD', date: '2026-05-05', vendor: 'V' });
      },

      // Dates that are not dates.
      async ({ rand }) => {
        const unitId = anyShort(rand);
        for (const [checkIn, checkOut] of [['2026-13-45', '2026-13-46'], ['not-a-date', '2026-05-05'], ['2026-05-10', '2026-05-10'], ['2026-05-10', '2026-05-01']]) {
          await c.post('/api/bookings', { unitId, guestName: 'Bad dates', checkIn, checkOut, amount: 100, depositPaid: 0, currency: 'USD', source: 'Direct' });
        }
      },

      // A villa taken off the books mid-life.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        await c.put(`/api/units/${unitId}`, { number: unitId.replace('unit-', ''), ownerName: 'Owner', status: 'unavailable', currency: 'JMD', maintCurrency: 'JMD' });
        await c.post('/api/charges/post-month', { monthString: '2026-11' });
      },

      // And brought back into service.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        await c.put(`/api/units/${unitId}`, { number: unitId.replace('unit-', ''), ownerName: 'Owner', tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: 'Returned', status: 'long-term', monthlyRent: money(rand, 40000, 90000), monthlyMaintenance: money(rand, 6000, 14000), currency: 'JMD', maintCurrency: 'JMD' });
      },

      // Two people at the desk at once, on one account.
      async ({ rand }) => {
        const unitId = anyLong(rand);
        const amount = money(rand, 1000, 15000);
        const made = await Promise.all(
          Array.from({ length: 4 }, () => c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Simultaneous', method: 'Cash', confirmNoOpenCharge: true }))
        );
        const ids = made.map(r => r.body?.payment?.id).filter(Boolean);
        await Promise.all(ids.map(id => c.post(`/api/payments/${id}/confirm`, {})));
        if (ids[0]) await Promise.all([c.post(`/api/payments/${ids[0]}/confirm`, {}), c.post(`/api/payments/${ids[0]}/confirm`, {})]);
      },

      // The same action arriving twice from a flaky connection.
      async ({ rand, i }) => {
        const key = `sim400-${i}`;
        const body = { unitId: anyLong(rand), category: 'Rent', amount: money(rand, 1000, 9000), currency: 'JMD', payerName: 'Retried', method: 'Cash', confirmNoOpenCharge: true };
        await c.post('/api/payments', body, { headers: { 'Idempotency-Key': key } });
        await c.post('/api/payments', body, { headers: { 'Idempotency-Key': key } });
      },

      // Reconciled against the bank statement.
      async ({ rand }) => {
        const p = await c.post('/api/payments', { unitId: anyLong(rand), category: 'Rent', amount: money(rand, 5000, 50000), currency: 'JMD', payerName: 'Bank payer', method: 'Bank Transfer', confirmNoOpenCharge: true });
        const id = p.body?.payment?.id;
        if (!id) return;
        await c.post(`/api/payments/${id}/confirm`, {});
        await c.post(`/api/payments/${id}/reconcile`, { matched: true, statementRef: 'STMT-400' });
      },

      // Maintenance requested, done, and charged to the register.
      async ({ month, rand, i }) => {
        const unitId = anyLong(rand);
        const raised = await c.post('/api/unit-activities', {
          unitId,
          residentName: 'Tenant',
          residentRole: 'Tenant',
          activityType: 'Maintenance Request',
          dateCaptured: dayIn(month, 3),
          notes: `work order ${i}`
        });
        const id = raised.body?.activity?.id;
        if (!id) return;
        await c.put(`/api/unit-activities/${id}`, { workStatus: 'Scheduled', assignedTo: 'Jamaica Plumbers Ltd' });
        await c.put(`/api/unit-activities/${id}`, { workStatus: 'Completed', completedOn: dayIn(month, 12), outcome: 'Done.', costAmount: money(rand, 2000, 40000), costCurrency: 'JMD' });
        // The cost reaches the register only when someone raises it, deliberately.
        await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
        // And asking twice must not raise it twice.
        await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
      },

      // The standing monthly costs posted — and posted again, which must not
      // charge the property twice for the same month.
      async ({ month, rand }) => {
        const items = templates.map(id => ({ recurringId: id, ...(rand() > 0.6 ? { amount: money(rand, 50000, 200000) } : {}) }));
        await c.post('/api/expenses/post-month', { monthString: month, items });
        await c.post('/api/expenses/post-month', { monthString: month, items });
      },

      // Each lot's share of the annual insurance premium, entered by hand at a
      // figure the office adjusts per villa rather than a formula's output.
      async ({ month, rand }) => {
        for (const unitId of [...longLets, ...shortLets]) {
          if (rand() < 0.6) continue;
          await c.post('/api/charges', {
            unitId,
            category: 'Maintenance',
            oneOffType: 'Insurance share',
            amount: money(rand, 20000, 70000),
            currency: 'JMD',
            dueDate: dayIn(month, 1),
            description: 'Share of annual insurance premium'
          });
        }
      },

      // A villa the corporation meters itself, billed and sometimes settled.
      // A proprietor's own supply never reaches the corporation at all, so this
      // only ever applies to the villas it lets on its own account.
      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const prev = Math.floor(rand() * 900);
        const reading = await c.post('/api/utilities', {
          unitId,
          billingPeriod: month,
          previousReading: prev,
          currentReading: prev + Math.floor(rand() * 500),
          amountCharged: money(rand, 2000, 26000),
          currency: 'USD'
        });
        const id = reading.body?.utility?.id;
        // Deliberately leave some unsettled, chosen from the seeded generator
        // rather than from `i`. A scenario only runs when `i % scenarios.length`
        // picks it, so any test on `i % n` is constant for that scenario
        // whenever `n` divides the scenario count — adding two scenarios made
        // the count a multiple of three and this branch silently stopped firing
        // altogether, taking its coverage assertion down with it. Never gate a
        // scenario's internal branch on `i`.
        if (!id || rand() > 0.65) return;
        const settled = await c.post(`/api/utilities/${id}/settle`, { method: 'Cash' });
        if (settled.body?.payment?.id) await c.post(`/api/payments/${settled.body.payment.id}/confirm`, {});
      },

      // The supplier's own invoice for a metered villa. It is the corporation's
      // cost of supply, and must never be recharged on top of the reading.
      async ({ month, rand }) => {
        const unitId = anyShort(rand);
        await c.post('/api/expenses', {
          category: 'Utilities',
          description: 'Supplier invoice for a metered villa',
          amount: money(rand, 2000, 26000),
          currency: 'USD',
          date: dayIn(month, 20),
          datePaid: dayIn(month, 20),
          status: 'paid',
          unitId,
          vendor: 'Jamaica Public Service'
        });
      },

      // The annual report being prepared while the books are still moving.
      // Only the narrative and the budget are ever stored — every figure is
      // recomputed — so this must never be able to corrupt the ledger, and the
      // report audit above runs against whatever it leaves behind.
      async ({ rand, i }) => {
        const year = rand() > 0.5 ? 2026 : 2025;
        await c.put(`/api/annual-reports/${year}`, {
          currency: rand() > 0.85 ? 'USD' : 'JMD',
          narrative: {
            executiveSummary: `Draft ${i} of the position for ${year}.`,
            recommendation: rand() > 0.5 ? 'A contribution increase is proposed.' : ''
          },
          budgetByCategory: {
            Security: Math.round(money(rand, 0, 3000000)),
            // Zero is meaningful — it is how a service is cut — and clearing a
            // line must fall back to the run-rate rather than storing nothing.
            Payroll: rand() > 0.8 ? 0 : Math.round(money(rand, 100000, 2000000)),
            Utilities: rand() > 0.9 ? null : Math.round(money(rand, 50000, 900000))
          },
          proposedFee: rand() > 0.3 ? Math.round(money(rand, 15000, 45000)) : null,
          meetingDate: rand() > 0.6 ? `${year}-11-20` : null
        });
        // Rubbish at the same surface: a year that cannot exist, and a
        // narrative section nothing renders.
        await c.put('/api/annual-reports/1200', {});
        await c.put(`/api/annual-reports/${year}`, { narrative: { notARealSection: 'x'.repeat(50) } });
      },

      // Turning the health grade off and on while everything else runs.
      async ({ rand }) => {
        await c.post('/api/settings', { hidePropertyHealth: rand() > 0.5 });
      }
    ];

    /* ---------------- run them ---------------- */

    let ran = 0;
    const failures = [];
    const reportingFailures = [];
    // Only the scenario loop is under scrutiny; setup above is allowed to probe.
    c.clearNotFound();

    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const seed = 5000 + i;
      const rand = rng(seed);
      const index = i % scenarios.length;
      const context = { month: monthOf(Math.floor(i / scenarios.length)), rand, i, seed };

      try {
        await scenarios[index](context);
      } catch (err) {
        failures.push(`seed ${seed} (scenario ${index}) threw ${err.message}`);
        continue;
      }
      ran++;

      const db = (await c.get('/api/db')).body;

      const ledgerProblems = auditDatabase(db);
      if (ledgerProblems.length) failures.push(`seed ${seed} (scenario ${index}): ${ledgerProblems.slice(0, 2).join('; ')}`);

      // Run on every scenario, not a sample. This re-derives every balance in
      // the property, which is the expensive part — but a divergence that
      // appears at scenario 137 and heals by 140 is exactly the kind a sample
      // misses, and it is the kind this file exists to catch. Measured at a few
      // seconds across the whole run; cheap enough not to trade away.
      const problems = auditReporting(db, fin, '2026-12-31');
      if (problems.length) reportingFailures.push(`seed ${seed} (scenario ${index}): ${problems.slice(0, 2).join('; ')}`);
    }

    T.check(`all ${SCENARIO_COUNT} scenarios ran without the server failing`, ran === SCENARIO_COUNT, `${ran} of ${SCENARIO_COUNT}`);
    const dead = c.notFound();
    T.check(
      'every scenario called a route that exists, so none of them silently did nothing',
      dead.length === 0,
      `${dead.length} calls 404'd, e.g. ${[...new Set(dead)].slice(0, 3).join(' | ')}`
    );
    T.check('the books stayed coherent after every one of them', failures.length === 0, failures.slice(0, 4).join(' | '));
    T.check('and the reported figures never diverged from the ledger', reportingFailures.length === 0, reportingFailures.slice(0, 4).join(' | '));

    /* ---------------- the accumulated property ---------------- */

    const db = (await c.get('/api/db')).body;

    T.check('the simulation genuinely exercised the ledger', db.payments.length > 100, `${db.payments.length} payments`);
    T.check('it raised a substantial number of charges', db.charges.length > 100, `${db.charges.length} charges`);
    T.check('receipts were issued', db.payments.some(p => p.status === 'completed' && p.receiptNo));
    T.check('receipts were voided', db.payments.some(p => p.status === 'reversed'));
    T.check('money was refunded', db.payments.some(p => p.refundedAmount > 0));
    T.check('both currencies were used', new Set(db.payments.map(p => p.currency)).size === 2);
    T.check('one-off charges were raised', db.charges.some(x => x.oneOffType));
    T.check('charges were voided', db.charges.some(x => x.status !== 'open'));
    T.check('stays were booked and cancelled', db.bookings.some(b => b.status === 'cancelled'));
    T.check('calendar holds were recorded separately from guests', db.bookings.some(b => b.source === 'Blocked' || b.source === 'Unavailable'));
    T.check('tenancies were opened', db.tenancies.length > 0, `${db.tenancies.length} tenancies`);
    T.check('and some were closed', db.tenancies.some(t => t.status === 'ended'));
    // The exclusion above is only sound if this path is actually being walked —
    // otherwise it would be quietly widening the rule to cover nothing.
    T.check(
      "first-and-last rent raised a final month's rent in advance",
      db.charges.some(x => x.kind === 'advance-final-month'),
      'no advance charge was ever raised'
    );
    T.check(
      'and that advance is held against the tenancy that owes it',
      db.tenancies.filter(t => t.advanceRentChargeId).every(t => db.charges.some(c => c.id === t.advanceRentChargeId)),
      'a tenancy points at an advance charge that does not exist'
    );
    T.check('costs were recorded', db.expenses.length > 20, `${db.expenses.length} expenses`);
    // These two caught a scenario that was silently posting to a route that does
    // not exist, and therefore proving nothing at all.
    T.check('the standing monthly costs actually posted', db.expenses.some(x => x.recurringId), 'no expense carries a recurringId');
    T.check('and were never posted twice for the same month', auditDatabase(db).every(p => !/posted twice/.test(p)));
    T.check('maintenance work reached the expense register', db.unitActivities.some(a => a.expenseId && db.expenses.some(e => e.id === a.expenseId)));
    T.check('every action left an audit entry', db.auditLogs.length > 200, `${db.auditLogs.length} audit entries`);

    /* ---------------- arrears actually accumulated ---------------- */

    const finalAgeing = fin.arrearsAgeing(db.units, db.charges, db.payments, '2026-12-31');
    T.check('real arrears built up over the simulation', finalAgeing.length > 0, 'nothing was left outstanding');
    T.check(
      'and every ageing column totals the balance behind it',
      auditReporting(db, fin, '2026-12-31').filter(p => /ageing/.test(p)).length === 0,
      auditReporting(db, fin, '2026-12-31').filter(p => /ageing/.test(p)).slice(0, 2).join('; ')
    );
    T.check('debt reached the older buckets, not only the first', finalAgeing.some(e => e.buckets.d60 > 0 || e.buckets.d90 > 0 || e.buckets.over90 > 0));

    /* ---------------- the newest paths were genuinely walked ---------------- */

    /*
     * Without these the scenarios above could be posting to nothing and the run
     * would still be green — which has already happened once in this file.
     */
    T.check(
      'insurance shares were raised as their own kind of charge',
      db.charges.some(x => x.oneOffType === 'Insurance share'),
      'no insurance share was ever billed'
    );
    T.check(
      'and they age into arrears beside the maintenance they are collected with',
      db.charges.filter(x => x.oneOffType === 'Insurance share').every(x => x.category === 'Maintenance'),
      'an insurance share landed on the wrong account'
    );
    T.check('villas the corporation meters were billed for utilities', db.utilities.length > 0, `${db.utilities.length} readings`);
    T.check(
      'and some readings were left unsettled',
      db.utilities.some(u => u.status === 'unpaid'),
      `statuses seen: ${JSON.stringify([...new Set(db.utilities.map(u => u.status))])} across ${db.utilities.length} readings`
    );
    // The guard on the guard. Every coverage assertion in this file assumes the
    // simulation moved through the year; when the month froze per scenario, the
    // records that dedupe per period collapsed and the suite went on claiming
    // coverage it no longer had. Assert the spread itself.
    T.check(
      'the simulation moved through the year rather than repeating one month',
      new Set(db.charges.map(c => c.periodMonth).filter(Boolean)).size >= 6,
      `only ${new Set(db.charges.map(c => c.periodMonth).filter(Boolean)).size} distinct billing months were reached`
    );
    T.check(
      'and it read meters across several periods, not just one',
      new Set(db.utilities.map(u => u.billingPeriod)).size >= 4,
      `only ${new Set(db.utilities.map(u => u.billingPeriod)).size} distinct meter periods, across ${db.utilities.length} readings`
    );
    T.check(
      "the supplier's own utility invoices were recorded as the corporation's cost",
      db.expenses.some(e => e.category === 'Utilities' && e.unitId),
      'no supplier invoice was tied to a villa, so the double-billing guard was never tested'
    );

    const finalStatements = fin.ownerStatements(db.units, db.charges, db.payments, db.expenses, db.utilities, '2026-01-01', '2026-12-31');
    T.check('owner statements were produced from the accumulated property', finalStatements.length > 0, `${finalStatements.length} statements`);
    T.check(
      'and not one of them recharged a supplier utility invoice to a proprietor',
      finalStatements.every(s => !s.expenseItems.some(e => e.category === 'Utilities')),
      'one supply was billed twice'
    );
    T.check(
      'while the metered charge itself did reach the owner',
      finalStatements.some(s => s.utilityBilled > 0),
      'no statement carried a utility charge, so the mapping proves nothing'
    );

    /* ---------------- occupancy is readable across the year ---------------- */

    const year = ['2026-01', '2026-03', '2026-06', '2026-09', '2026-12'];
    const occupancy = fin.occupancySeries(db.units, db.tenancies, db.bookings, year, '2026-12-31');
    T.check('occupancy is reported for every month asked for', occupancy.length === year.length);
    T.check('and never exceeds the register', occupancy.every(r => r.occupied <= r.total));
    T.check('and is never a non-finite rate', occupancy.every(r => r.rate === null || Number.isFinite(r.rate)));

    /* ---------------- nothing unreadable became a stored figure ---------------- */

    T.check('no stored figure is 1.5 from a mistyped 1.500.000', !db.payments.some(p => p.amount === 1.5) && !db.expenses.some(e => e.amount === 1.5));
    T.check('no payment was stored at zero or below', !db.payments.some(p => p.amount <= 0));
    T.check('no booking ends before it starts', !db.bookings.some(b => b.checkOut <= b.checkIn));
    T.check('the final books are coherent', auditDatabase(db).length === 0, auditDatabase(db).slice(0, 3).join('; '));
    T.check('and the final reported figures agree with them', auditReporting(db, fin, '2026-12-31').length === 0, auditReporting(db, fin, '2026-12-31').slice(0, 3).join('; '));

    /* ---------------- the server survived it ---------------- */

    // The application's own self-check, against the busiest legitimate database
    // this suite can build. A checker that cries wolf on a real property gets
    // ignored inside a week, and the finding that matters is ignored with it.
    // Four hundred scenarios of refunds, voids, part-payments, cancelled stays
    // and re-posted months must still come back clean.
    const selfCheck = (await c.get('/api/integrity')).body;
    T.check(
      'the application checking its own records finds nothing wrong with them',
      selfCheck?.ok === true,
      JSON.stringify(selfCheck?.findings?.slice(0, 3))
    );
    T.check(
      'and it genuinely walked the whole property rather than an empty one',
      (selfCheck?.counts?.payments || 0) > 50 && (selfCheck?.counts?.charges || 0) > 50,
      JSON.stringify(selfCheck?.counts)
    );

    T.check('the server is still answering', (await c.get('/api/health')).status === 200);
    const reread = await c.get('/api/db');
    T.check('the database still reads back cleanly', reread.status === 200 && Array.isArray(reread.body.payments));

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
