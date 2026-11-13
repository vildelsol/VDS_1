/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three thousand adversarial scenarios, run against the application's own API.
 *
 * Commissioned by Ro on 2026-09-01, immediately before rebuilding the live
 * database from scratch: the point is to find what is wrong *now*, while the
 * books are still empty and a fix costs nothing but time.
 *
 * **The rule this suite is built on, and the thing that makes it different from
 * the other simulations:**
 *
 *     Nothing here corrupts the database behind the application's back.
 *     Every action is one a person at the desk could actually take, through
 *     the same HTTP API the screens use.
 *
 * So when the books end up contradicting themselves, that is never "the test
 * broke it". It means a sequence of legitimate operations was allowed to leave
 * the records in a state the application itself calls a serious fault — and the
 * fix belongs at the point of entry, as a guard, not in a report that tells
 * somebody afterwards. The other suites assert that the ledger survives; this
 * one asserts that **the application will not let a person break it.**
 *
 * The headline invariant, checked against the accumulated database as the
 * scenarios pile up:
 *
 *   - the application's own integrity checker reports **no serious finding**;
 *   - the books are internally coherent (receipts, balances, stays, deposits);
 *   - every reported figure is finite, positive where it must be, and 2dp;
 *   - the ageing schedule still totals exactly what is outstanding, per
 *     currency — the invariant the statutory return is built on;
 *   - no account is shown as *in credit* while money it owes sits stranded in
 *     the other currency;
 *   - the owner statement identity holds.
 *
 * Scenarios come from a seeded generator, so any failure names a seed that
 * reproduces it exactly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Three thousand adversarial scenarios';

const SCENARIO_COUNT = 3000;
/** How often the expensive whole-database audit runs. Every scenario gets the cheap one. */
const DEEP_EVERY = 25;

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-redteam-'));
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
const isBadNumber = v => typeof v === 'number' && !Number.isFinite(v);
const cents = v => Math.round(v * 100);
const ok = res => res.status >= 200 && res.status < 300;

/**
 * The months this simulation moves through.
 *
 * Deliberately spans a year boundary and a February. Receipt numbers carry the
 * year, month-end arithmetic differs by month, and a 31st does not exist in
 * half of them — none of which is exercised by a simulation that lives inside
 * one quarter.
 */
const MONTHS = [
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
  '2027-01', '2027-02'
];
const monthOf = n => MONTHS[n % MONTHS.length];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;

/* ------------------------------------------------------------------ *
 * Is the database talking sense?
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
    // Money is stored to the cent. A third decimal place is a rounding fault
    // that will not show on screen and will not reconcile to a bank statement.
    if (typeof p.amount === 'number' && Number.isFinite(p.amount) && Math.abs(p.amount * 100 - Math.round(p.amount * 100)) > 1e-6) {
      problems.push(`payment ${p.id} is stored at sub-cent precision (${p.amount})`);
    }
  }

  for (const c of charges) {
    if (isBadNumber(c.amount)) problems.push(`charge ${c.id} has a non-finite amount`);
    if (typeof c.amount === 'number' && c.amount <= 0) problems.push(`charge ${c.id} is not positive`);
    if (typeof c.amount === 'number' && Number.isFinite(c.amount) && Math.abs(c.amount * 100 - Math.round(c.amount * 100)) > 1e-6) {
      problems.push(`charge ${c.id} is stored at sub-cent precision (${c.amount})`);
    }
  }

  // One ordinary charge per unit, category and month. One-offs and the
  // advance-final-month charge legitimately share a period; neither is a
  // double-billing.
  const seen = new Map();
  for (const c of charges.filter(x => x.status === 'open' && !x.oneOffType && x.kind !== 'advance-final-month')) {
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
  for (const u of utilities) if (isBadNumber(u.amountCharged)) problems.push(`utility ${u.id} has a non-finite figure`);
  for (const u of units) {
    if (isBadNumber(u.monthlyRent) || isBadNumber(u.monthlyMaintenance)) problems.push(`villa ${u.number} has a non-finite rate`);
  }
  for (const t of tenancies) {
    if (t.depositReturnedOn && t.depositAmount === undefined) problems.push(`tenancy ${t.id} returned a deposit it never held`);
    if (isBadNumber(t.depositAmount) || isBadNumber(t.monthlyRent)) problems.push(`tenancy ${t.id} has a non-finite figure`);
    if (t.endedOn && t.startedOn && t.endedOn < t.startedOn) problems.push(`tenancy ${t.id} ended before it began`);
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Do the figures management is shown still agree with the ledger?
 * ------------------------------------------------------------------ */

function auditReporting(db, fin, asOf) {
  const problems = [];
  const { units = [], charges = [], payments = [], expenses = [], utilities = [] } = db;

  const ageing = fin.arrearsAgeing(units, charges, payments, asOf);
  for (const entry of ageing) {
    const b = entry.buckets;
    for (const [key, value] of Object.entries(b)) {
      if (isBadNumber(value)) problems.push(`ageing ${entry.currency}.${key} is not finite`);
      if (typeof value === 'number' && value < 0) problems.push(`ageing ${entry.currency}.${key} is negative`);
    }
    const summed = cents(b.d30) + cents(b.d60) + cents(b.d90) + cents(b.over90);
    if (summed !== cents(b.total)) problems.push(`ageing ${entry.currency} columns do not total`);

    // A let villa's levy is part of the unpaid rent it sits inside: owed once, not twice.
    const owed = units.reduce((total, unit) => {
      const rent = fin.accountBalance(unit, 'Rent', charges, payments, asOf, units);
      const maint = fin.accountBalance(unit, 'Maintenance', charges, payments, asOf, units);
      const inside = fin.maintenanceFundedFromRent(unit) && rent.balance > 0 && maint.balance > 0 && maint.balance <= rent.balance;
      for (const account of inside ? [rent] : [rent, maint]) {
        if (account.currency === entry.currency && account.balance > 0) total += cents(account.balance);
      }
      return total;
    }, 0);
    if (summed !== owed) problems.push(`ageing ${entry.currency} totals ${summed} but ${owed} is outstanding`);
  }

  /*
   * An account must never be shown as in credit while money it genuinely owes
   * is sitting in the other currency, unreported.
   *
   * This is the shape of the fault found on the live books on 2026-09-01: a
   * villa was re-denominated, its open charges were left behind in the currency
   * it is no longer billed in, "Billed to date" read nil, and the receipt that
   * did match then made the villa look like it was in credit. Money owed,
   * presented as money owing back.
   */
  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance']) {
      const account = fin.accountBalance(unit, category, charges, payments, asOf, units);
      if (account.mismatchedCurrencyCharges.length > 0 || account.mismatchedCurrencyPayments.length > 0) {
        const warned = fin
          .currencyMismatchWarnings(units, charges, payments)
          .some(w => w.unit.id === unit.id && w.category === category);
        if (!warned) problems.push(`villa ${unit.number} ${category} holds stranded money but raises no warning`);
      }
      if (isBadNumber(account.balance) || isBadNumber(account.charged) || isBadNumber(account.paid)) {
        problems.push(`villa ${unit.number} ${category} balance is not finite`);
      }
    }
  }

  // The owner statement identity, on the corrected arithmetic: what is deducted
  // is the contribution still outstanding, not the whole of what was billed.
  const statements = fin.ownerStatements(units, charges, payments, expenses, utilities, '2026-01-01', '2027-12-31');
  for (const s of statements) {
    for (const [field, value] of Object.entries({
      collected: s.collected,
      maintenanceBilled: s.maintenanceBilled,
      maintenancePaid: s.maintenancePaid,
      utilityBilled: s.utilityBilled,
      expenses: s.expenses,
      net: s.net
    })) {
      if (isBadNumber(value)) problems.push(`statement ${s.unit.number} ${s.currency}: ${field} is not finite`);
    }
    const owedForPeriod = cents(s.maintenanceBilled) - cents(s.maintenancePaid);
    const expected = cents(s.utilityCollected) - owedForPeriod - cents(s.utilityBilled) - cents(s.expenses);
    if (cents(s.net) !== expected) {
      problems.push(`statement ${s.unit.number} ${s.currency}: net ${cents(s.net)} does not equal ${expected}`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'RedTeam-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'RedTeam-1234!', 'RedTeamNew-9876!');

    // The books open at the start of the simulated period, as they do live.
    const settings = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...settings, booksBeginOn: '2026-01-01' });

    /* ---------------- a property that looks like the real one ---------------- */

    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const setup = rng(97);
    const longLets = [];
    const shortLets = [];
    const owned = [];

    for (let i = 0; i < unitIds.length; i++) {
      const id = unitIds[i];
      const number = id.replace('unit-', '');
      let body;
      if (i % 4 === 3) {
        body = { number, ownerName: `Owner ${i}`, status: 'short-term', monthlyMaintenance: money(setup, 150, 600), currency: 'USD', maintCurrency: 'USD' };
        shortLets.push(id);
      } else if (i === 14) {
        body = { number, ownerName: `Owner ${i}`, status: 'unavailable', currency: 'JMD', maintCurrency: 'JMD' };
      } else if (i === 13 || i === 11) {
        // Proprietors who only ever pay maintenance — the ordinary case at this
        // property, and the one the statement fault was found on.
        body = { number, ownerName: `Owner ${i}`, status: 'owner-occupied', monthlyMaintenance: money(setup, 8000, 18000), currency: 'JMD', maintCurrency: 'JMD' };
        owned.push(id);
      } else if (i === 12) {
        // Billed entirely in USD, so no currency is ever the only one in play.
        body = { number, ownerName: `Owner ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: `Tenant ${i}`, status: 'long-term', monthlyRent: money(setup, 700, 2400), monthlyMaintenance: money(setup, 100, 400), currency: 'USD', maintCurrency: 'USD', rentDueDay: 1, maintDueDay: 1 };
        longLets.push(id);
      } else if (i === 10) {
        // Rent in USD, maintenance in JMD: the split-currency villa, which is
        // exactly the shape of the live villa that went wrong.
        body = { number, ownerName: `Owner ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: `Tenant ${i}`, status: 'long-term', monthlyRent: money(setup, 500, 1200), monthlyMaintenance: money(setup, 8000, 15000), currency: 'USD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 };
        longLets.push(id);
      } else {
        body = { number, ownerName: `Owner ${i}`, tenantChangeIntent: 'changeover', ownerChangeIntent: 'correction', tenantName: `Tenant ${i}`, status: 'long-term', monthlyRent: money(setup, 45000, 140000), monthlyMaintenance: money(setup, 8000, 20000), currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 };
        longLets.push(id);
      }
      await c.put(`/api/units/${id}`, body);
    }

    const anyLong = rand => pick(rand, longLets);
    const anyShort = rand => pick(rand, shortLets);
    const anyOwned = rand => pick(rand, owned.length ? owned : longLets);
    const anyUnit = rand => pick(rand, unitIds);

    /* ---------------- what a person at the desk can do ---------------- */

    const scenarios = [
      // --- the ordinary month ---
      async ({ month }) => {
        await c.post('/api/charges/post-month', { monthString: month });
      },

      async ({ month, rand }) => {
        const unitId = anyLong(rand);
        const p = await c.post('/api/payments', { unitId, category: 'Rent', amount: money(rand, 20000, 140000), currency: 'JMD', payerName: 'Tenant', method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']), date: dayIn(month, 1 + Math.floor(rand() * 27)), confirmNoOpenCharge: true });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      // A proprietor settling their contribution — the transaction the live
      // statement fault was found on.
      async ({ month, rand }) => {
        const unitId = anyOwned(rand);
        const p = await c.post('/api/payments', { unitId, category: 'Maintenance', amount: money(rand, 5000, 20000), currency: 'JMD', payerName: 'Proprietor', method: 'Bank Transfer', date: dayIn(month, 1 + Math.floor(rand() * 27)), confirmNoOpenCharge: true });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
      },

      /* ================================================================
       * Re-denominating a villa while charges are open against it.
       *
       * The live fault of 2026-09-01, generalised. Changing the currency on
       * the register is one keystroke and entirely legitimate; every charge
       * already raised then belongs to a currency the account is no longer
       * billed in, and is counted by neither side of the balance.
       * ================================================================ */
      async ({ rand }) => {
        const unitId = anyLong(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        const flip = cur => (cur === 'JMD' ? 'USD' : 'JMD');
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: unit.ownerName,
          tenantName: unit.tenantName,
          status: unit.status,
          monthlyRent: unit.monthlyRent,
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: flip(unit.currency),
          maintCurrency: unit.maintCurrency,
          rentDueDay: unit.rentDueDay,
          maintDueDay: unit.maintDueDay,
          // Half the time the officer confirms and goes through with it, so the
          // void-the-stranded-charges path is exercised and not only the refusal.
          ...(rand() > 0.5 ? { currencyChangeIntent: 'void-open-charges' } : {})
        });
      },

      // And the maintenance side of the same edit, independently.
      async ({ rand }) => {
        const unitId = anyOwned(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: unit.ownerName,
          status: unit.status,
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: unit.currency,
          maintCurrency: (unit.maintCurrency || unit.currency) === 'JMD' ? 'USD' : 'JMD',
          // The live case of 2026-09-01: maintenance moved to USD after the owner
          // asked for it, with JMD contributions already raised against the villa.
          ...(rand() > 0.4 ? { currencyChangeIntent: 'void-open-charges' } : {})
        });
        // And the month re-posted in the new currency afterwards, which is what
        // the officer is told to do.
        await c.post('/api/charges/post-month', { monthString: pick(rand, MONTHS) });
      },

      /* ================================================================
       * The books-begin date moved after data has been entered.
       *
       * It governs billing as well as alerts since v1.9.0, so moving it is
       * not a display preference — it changes what may be charged.
       * ================================================================ */
      async ({ rand }) => {
        const s = (await c.get('/api/settings')).body;
        await c.put('/api/settings', { ...s, booksBeginOn: pick(rand, ['2026-01-01', '2026-06-01', '2027-01-01', '']) });
        await c.post('/api/charges/post-month', { monthString: pick(rand, MONTHS) });
        await c.put('/api/settings', { ...s, booksBeginOn: '2026-01-01' });
      },

      /* ================================================================
       * Calendar edges.
       * ================================================================ */
      async ({ rand }) => {
        // A due day that does not exist in every month.
        const unitId = anyLong(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: unit.ownerName,
          tenantName: unit.tenantName,
          status: unit.status,
          monthlyRent: unit.monthlyRent,
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: unit.currency,
          maintCurrency: unit.maintCurrency,
          rentDueDay: pick(rand, [1, 28, 29, 30, 31]),
          maintDueDay: pick(rand, [1, 15, 31])
        });
        await c.post('/api/charges/post-month', { monthString: '2026-02' });
        await c.post('/api/charges/post-month', { monthString: '2027-02' });
      },

      // Posting a month repeatedly, out of order, and far outside the books.
      async ({ rand }) => {
        const m = pick(rand, MONTHS);
        await c.post('/api/charges/post-month', { monthString: m });
        await c.post('/api/charges/post-month', { monthString: m });
        await c.post('/api/charges/post-month', { monthString: pick(rand, ['1999-01', '2099-12', '2026-13', 'not-a-month', '', '2026-00']) });
      },

      /* ================================================================
       * Money handed back.
       * ================================================================ */
      async ({ month, rand }) => {
        const db = (await c.get('/api/db')).body;
        const settled = db.payments.filter(p => p.status === 'completed' && !p.refundedOn);
        if (!settled.length) return;
        const p = pick(rand, settled);
        // A refund of part, then an attempt to refund more than was ever taken.
        await c.post(`/api/payments/${p.id}/refund`, { amount: Math.round(p.amount * 0.4 * 100) / 100, reason: 'overpaid', method: 'Cash', refundedOn: dayIn(month, 20) });
        await c.post(`/api/payments/${p.id}/refund`, { amount: p.amount, reason: 'again', method: 'Cash', refundedOn: dayIn(month, 21) });
      },

      // Voiding a receipt that has already been refunded, and refunding a void.
      async ({ month, rand }) => {
        const db = (await c.get('/api/db')).body;
        const settled = db.payments.filter(p => p.status === 'completed');
        if (!settled.length) return;
        const p = pick(rand, settled);
        await c.post(`/api/payments/${p.id}/reverse`, { reason: 'entered against the wrong villa' });
        await c.post(`/api/payments/${p.id}/refund`, { amount: 1, reason: 'after void', method: 'Cash', refundedOn: dayIn(month, 22) });
      },

      /* ================================================================
       * A charge voided after it has been paid.
       * ================================================================ */
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const open = db.charges.filter(x => x.status === 'open');
        if (!open.length) return;
        const charge = pick(rand, open);
        const p = await c.post('/api/payments', { unitId: charge.unitId, category: charge.category, amount: charge.amount, currency: charge.currency, payerName: 'Payer', method: 'Cash', confirmNoOpenCharge: true });
        if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
        await c.post(`/api/charges/${charge.id}/void`, { reason: 'raised in error' });
      },

      /* ================================================================
       * One-off charges at the edges of the books.
       * ================================================================ */
      async ({ rand }) => {
        const unitId = anyOwned(rand);
        for (const dueDate of ['2025-01-01', '2026-01-01', '2030-01-01', 'not-a-date', '']) {
          await c.post('/api/charges', {
            unitId,
            category: 'Maintenance',
            oneOffType: pick(rand, ['Opening balance', 'Insurance share', 'Late fee']),
            amount: money(rand, 500, 50000),
            currency: 'JMD',
            dueDate,
            description: 'carried over'
          });
        }
      },

      /* ================================================================
       * Ownership and tenancy churn while money is outstanding.
       * ================================================================ */
      async ({ month, rand, i }) => {
        const unitId = anyLong(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: `New Owner ${i}`,
          ownerChangeIntent: pick(rand, ['sold', 'correction']),
          tenantName: unit.tenantName,
          status: unit.status,
          monthlyRent: unit.monthlyRent,
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: unit.currency,
          maintCurrency: unit.maintCurrency,
          ownershipChangedOn: dayIn(month, 15)
        });
      },

      async ({ month, rand, i }) => {
        const unitId = anyLong(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: unit.ownerName,
          tenantName: `Resident ${i}`,
          tenantChangeIntent: pick(rand, ['changeover', 'correction']),
          status: 'long-term',
          monthlyRent: money(rand, 40000, 120000),
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: unit.currency,
          maintCurrency: unit.maintCurrency,
          tenancyStartedOn: dayIn(month, 1),
          firstAndLastRent: rand() > 0.5
        });
      },

      // Moved out, then the same villa re-let in the same month — the advance
      // must be spent exactly once.
      async ({ month, rand, i }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active');
        if (!live.length) return;
        const t = pick(rand, live);
        const unit = db.units.find(u => u.id === t.unitId);
        if (!unit) return;
        await c.put(`/api/units/${t.unitId}`, { number: unit.number, ownerName: unit.ownerName, status: 'vacant', tenantName: '', monthlyRent: 0, tenantChangeIntent: 'moved-out' });
        await c.put(`/api/units/${t.unitId}`, { number: unit.number, ownerName: unit.ownerName, status: 'long-term', tenantName: `Replacement ${i}`, monthlyRent: money(rand, 40000, 90000), monthlyMaintenance: unit.monthlyMaintenance, currency: unit.currency, maintCurrency: unit.maintCurrency, tenantChangeIntent: 'changeover', tenancyStartedOn: dayIn(month, 20) });
      },

      /* ================================================================
       * Deposits.
       * ================================================================ */
      async ({ rand }) => {
        const db = (await c.get('/api/db')).body;
        const live = db.tenancies.filter(t => t.status === 'active' && !t.depositAmount);
        if (!live.length) return;
        const t = pick(rand, live);
        const held = money(rand, 10000, 60000);
        const taken = await c.post(`/api/tenancies/${t.id}/deposit`, { amount: held, currency: 'JMD', method: 'Cash' });
        if (!ok(taken)) return;
        // More returned than was ever held — must be refused, never absorbed.
        await c.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held * 2, withheldAmount: 0, reason: 'over-return' });
        await c.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held, withheldAmount: 0, reason: 'returned in full' });
        await c.post(`/api/tenancies/${t.id}/deposit/settle`, { returnedAmount: held, withheldAmount: 0, reason: 'returned twice' });
      },

      /* ================================================================
       * Figures and dates that are not figures and dates.
       * ================================================================ */
      async ({ rand }) => {
        const unitId = anyLong(rand);
        for (const amount of ['1.500.000', '1e999', '50000abc', -5, 0, 0.001, 1e-9, 9.99e15, Infinity, NaN, null, {}, [], '0x10', ' 500 ']) {
          await c.post('/api/payments', { unitId, category: 'Rent', amount, currency: 'JMD', payerName: 'Fat finger', method: 'Cash', confirmNoOpenCharge: true });
        }
      },

      async ({ rand }) => {
        const unitId = anyShort(rand);
        for (const [checkIn, checkOut] of [['2026-13-45', '2026-13-46'], ['not-a-date', '2026-05-05'], ['2026-05-10', '2026-05-10'], ['2026-05-10', '2026-05-01'], ['2026-02-30', '2026-03-01']]) {
          await c.post('/api/bookings', { unitId, guestName: 'Bad dates', checkIn, checkOut, amount: 100, depositPaid: 0, currency: 'USD', source: 'Direct' });
        }
      },

      // Text where text is not expected.
      async ({ rand, i }) => {
        const unitId = anyUnit(rand);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) return;
        await c.put(`/api/units/${unitId}`, {
          number: unit.number,
          ownerName: pick(rand, ['<script>alert(1)</script>', 'Ω'.repeat(500), '   ', 'Robert\u0000Tables', `Owner ${i}`]),
          status: unit.status,
          monthlyRent: unit.monthlyRent,
          monthlyMaintenance: unit.monthlyMaintenance,
          currency: unit.currency,
          maintCurrency: unit.maintCurrency,
          ownerChangeIntent: 'correction'
        });
      },

      /* ================================================================
       * Two people at the desk, and a flaky connection.
       * ================================================================ */
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

      // The same month posted from two machines at once.
      async ({ month }) => {
        await Promise.all([
          c.post('/api/charges/post-month', { monthString: month }),
          c.post('/api/charges/post-month', { monthString: month }),
          c.post('/api/charges/post-month', { monthString: month })
        ]);
      },

      async ({ rand, i }) => {
        const key = `redteam-${i}`;
        const body = { unitId: anyLong(rand), category: 'Rent', amount: money(rand, 1000, 9000), currency: 'JMD', payerName: 'Retried', method: 'Cash', confirmNoOpenCharge: true };
        await c.post('/api/payments', body, { headers: { 'Idempotency-Key': key } });
        await c.post('/api/payments', body, { headers: { 'Idempotency-Key': key } });
      },

      /* ================================================================
       * Costs, meters and stays, so the reporting layer has real ground.
       * ================================================================ */
      async ({ month, rand }) => {
        await c.post('/api/expenses', {
          category: pick(rand, ['Maintenance', 'Security', 'Landscaping', 'Utilities', 'Payroll', 'Supplies', 'Contractors', 'Property Taxes']),
          description: 'simulated cost',
          amount: money(rand, 500, 60000),
          currency: pick(rand, ['JMD', 'USD']),
          date: dayIn(month, 1 + Math.floor(rand() * 27)),
          vendor: 'Vendor',
          unitNumber: pick(rand, ['General', 'Office', ''])
        });
      },

      async ({ month, rand }) => {
        const unitId = anyLong(rand);
        const u = await c.post('/api/utilities', { unitId, type: pick(rand, ['Electricity', 'Water']), billingPeriod: month, amountCharged: money(rand, 1000, 30000), currency: 'JMD', consumption: Math.floor(rand() * 400) });
        const id = u.body?.utility?.id;
        if (!id) return;
        const settled = await c.post(`/api/utilities/${id}/settle`, { method: 'Cash' });
        if (settled.body?.payment?.id) await c.post(`/api/payments/${settled.body.payment.id}/confirm`, {});
      },

      async ({ month, rand, i }) => {
        const unitId = anyShort(rand);
        const start = 1 + (i % 20);
        await c.post('/api/bookings', { unitId, guestName: `Guest ${i}`, checkIn: dayIn(month, start), checkOut: dayIn(month, start + 1 + (i % 5)), amount: money(rand, 200, 3000), depositPaid: money(rand, 50, 400), currency: 'USD', source: pick(rand, ['Direct', 'Airbnb', 'Booking.com', 'Blocked']) });
      },

      // Many tiny amounts on one account, hunting for floating-point drift.
      async ({ month, rand }) => {
        const unitId = anyLong(rand);
        for (let k = 0; k < 12; k++) {
          const p = await c.post('/api/payments', { unitId, category: 'Rent', amount: 0.07 + k * 0.01, currency: 'JMD', payerName: 'Small change', method: 'Cash', date: dayIn(month, 1 + k), confirmNoOpenCharge: true });
          if (p.body?.payment?.id) await c.post(`/api/payments/${p.body.payment.id}/confirm`, {});
        }
      }
    ];

    /* ---------------- run them ---------------- */

    const failures = [];
    let deepRuns = 0;
    let actionsRun = 0;

    for (let i = 0; i < SCENARIO_COUNT; i++) {
      const seed = 9000 + i;
      const rand = rng(seed);
      const scenario = scenarios[i % scenarios.length];
      const repetition = Math.floor(i / scenarios.length);
      const month = monthOf(repetition + (i % 3));

      try {
        await scenario({ month, rand, i, seed });
        actionsRun++;
      } catch (err) {
        failures.push(`seed ${seed} (scenario ${i % scenarios.length}) threw — ${err.message}`);
        continue;
      }

      if (i % DEEP_EVERY !== 0 && i !== SCENARIO_COUNT - 1) continue;
      deepRuns++;

      const db = (await c.get('/api/db')).body;
      const asOf = '2027-03-01';

      const bookProblems = auditDatabase(db);
      if (bookProblems.length) failures.push(`seed ${seed}: ${bookProblems.slice(0, 3).join('; ')}`);

      const reportProblems = auditReporting(db, fin, asOf);
      if (reportProblems.length) failures.push(`seed ${seed}: ${reportProblems.slice(0, 3).join('; ')}`);

      /*
       * The application's own opinion of its records.
       *
       * Nothing above reached past the API, so a serious finding here is not
       * damage the test did — it is a state the application allowed a person to
       * create and then calls a misstatement of money. That is a missing guard.
       */
      const integrity = (await c.get('/api/integrity')).body;
      const serious = (integrity?.findings || []).filter(f => f.severity === 'serious');
      if (serious.length) {
        failures.push(`seed ${seed}: the books report ${serious.map(f => `${f.code} (${f.records?.length ?? 0})`).join(', ')}`);
      }

      if (failures.length > 6) break;
    }

    T.check(`all ${SCENARIO_COUNT} scenarios ran through the API`, actionsRun >= SCENARIO_COUNT - failures.length, `${actionsRun} completed`);
    T.check('and the books were audited repeatedly as they accumulated', deepRuns > 50, `${deepRuns} deep audits`);
    T.check(
      'no sequence of legitimate operations left the books contradicting themselves',
      failures.length === 0,
      failures.slice(0, 6).join(' | ')
    );

    /* ---------------- the property is still usable afterwards ---------------- */

    const finalDb = (await c.get('/api/db')).body;
    T.check('the simulation moved real money', finalDb.payments.filter(p => p.status === 'completed').length > 100, `${finalDb.payments.length} payments`);
    T.check('and raised real charges', finalDb.charges.length > 100, `${finalDb.charges.length} charges`);
    T.check('the server is still answering', (await c.get('/api/db')).status === 200);
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
