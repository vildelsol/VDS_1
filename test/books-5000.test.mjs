/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Five thousand operations against the two books, the voids and the recalls.
 *
 * Commissioned by Ro on 2026-09-03, immediately after both changes landed:
 * *"You keep finding little bugs and things to fix. Run 5000 tests /
 * simulations for robustness, mapping, bugs, accuracy, arithmetic, etc. now that
 * changes have been made."*
 *
 * The existing red-team suites are thorough and they predate all of this — they
 * never mark a cost's book, never take one back, never recall a month, and so
 * they would pass unchanged if the new code were completely wrong. This one
 * exercises exactly the surface that is new, under the same rule as the others:
 *
 *     Nothing here corrupts the database behind the application's back.
 *     Every operation is one a person at the desk could actually take,
 *     through the same HTTP API the screens use.
 *
 * So a broken invariant is never "the test did it". It means a sequence of
 * legitimate acts left the books misstating themselves, and the fix belongs at
 * the point of entry.
 *
 * **The invariants, audited against the accumulated database as it grows:**
 *
 *   1. **strata + ISPO = the whole**, per currency, over several periods. The
 *      direct answer to *"ensure there's no double counting anywhere"*: it fails
 *      if a cost is counted twice or if one falls between the two books.
 *   2. **A cost taken back is counted by nothing** — not by either book, not by
 *      the combined total, not by any owner-facing document.
 *   3. **No ISPO cost ever reaches a proprietor**: not the monthly report, not
 *      the annual report, not Form 13C, not an owner statement.
 *   4. **The ISPO statement and the shortfall report agree** on the villas they
 *      both describe.
 *   5. **The contribution is counted once**: the internal transfer never exceeds
 *      the maintenance actually received on own-account villas.
 *   6. **Arithmetic**: every figure finite, 2dp, and non-negative where it
 *      cannot be negative.
 *   7. **The application's own self-check reports no serious finding.**
 *
 * Operations come from a seeded generator, so a failure names a seed that
 * reproduces it exactly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Five thousand operations across the two books';

const OPERATION_COUNT = 5000;
/** How often the expensive whole-database audit runs. */
const DEEP_EVERY = 250;

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-books5k-'));
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

/** Months in the past, so every one of them may legitimately be posted. */
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;

const CATEGORIES = ['Maintenance', 'Security', 'Landscaping', 'Utilities', 'Payroll', 'Supplies', 'Contractors', 'Other'];
const FUNDS = ['strata', 'ispo'];

/* ------------------------------------------------------------------ *
 * The audit
 * ------------------------------------------------------------------ */

/**
 * Everything that must be true of the books, whatever has been done to them.
 *
 * Returns a list of plain sentences. An empty list is the pass.
 */
function auditBooks(db, fin, periods) {
  const problems = [];
  const {
    expensesInPeriod,
    strataExpenses,
    ispoExpenses,
    liveExpenses,
    operationsStatement,
    operatingStatement,
    ispoOperations,
    annualOwnersReport,
    ownerStatements,
    form13CDebts,
    outOfPocketShortfall
  } = fin;

  const { units = [], charges = [], payments = [], expenses = [], utilities = [], tenancies = [], bookings = [] } = db;

  /* ---- 6. the records themselves ---- */

  const ids = expenses.map(e => e.id);
  if (new Set(ids).size !== ids.length) problems.push('two costs share an id');

  for (const e of expenses) {
    if (isBadNumber(e.amount)) problems.push(`cost ${e.id} has a non-finite amount`);
    if (typeof e.amount === 'number' && e.amount <= 0) problems.push(`cost ${e.id} is not a positive amount`);
    if (!['paid', 'pending', 'void'].includes(e.status)) problems.push(`cost ${e.id} has status ${e.status}`);
    if (e.fund !== undefined && !FUNDS.includes(e.fund)) problems.push(`cost ${e.id} is filed under book ${e.fund}`);
    if (e.status === 'void' && (!e.voidedBy || !e.voidReason || !e.voidedAt)) {
      problems.push(`cost ${e.id} was taken back with no record of who or why`);
    }
    if (e.status !== 'void' && (e.voidedBy || e.voidReason)) {
      problems.push(`live cost ${e.id} carries void metadata`);
    }
  }

  for (const t of db.recurringExpenses || []) {
    if (t.fund !== undefined && !FUNDS.includes(t.fund)) problems.push(`monthly cost ${t.id} is filed under book ${t.fund}`);
  }

  /* ---- a template that was deleted left nothing live behind it ---- */
  const templateIds = new Set((db.recurringExpenses || []).map(t => t.id));
  for (const e of expenses) {
    if (e.recurringId && !templateIds.has(e.recurringId) && e.status !== 'void') {
      problems.push(`live cost ${e.id} descends from a monthly cost that has been removed`);
    }
  }

  /* ---- a template posts at most once per month, ignoring what was taken back ---- */
  const postedKey = new Set();
  for (const e of expenses) {
    if (!e.recurringId || !e.periodMonth || e.status === 'void') continue;
    const key = `${e.recurringId}|${e.periodMonth}`;
    if (postedKey.has(key)) problems.push(`monthly cost posted twice for ${key}`);
    postedKey.add(key);
  }

  for (const currency of ['JMD', 'USD']) {
    for (const [from, to] of periods) {
      /* ---- 1. the two books sum to the whole ---- */
      const whole = expensesInPeriod(expenses, currency, from, to);
      const a = expensesInPeriod(strataExpenses(expenses), currency, from, to);
      const b = expensesInPeriod(ispoExpenses(expenses), currency, from, to);
      if (Math.abs(cents(whole) - (cents(a) + cents(b))) > 1) {
        problems.push(`${currency} ${from}..${to}: strata ${a} + ISPO ${b} does not make ${whole}`);
      }
      if (isBadNumber(whole) || isBadNumber(a) || isBadNumber(b)) {
        problems.push(`${currency} ${from}..${to}: a spend figure is not a finite number`);
      }
      if (whole < 0 || a < 0 || b < 0) problems.push(`${currency} ${from}..${to}: a spend figure is negative`);

      /* ---- 2. a cost taken back is counted by nothing ---- */
      const live = expensesInPeriod(liveExpenses(expenses), currency, from, to);
      if (Math.abs(cents(live) - cents(whole)) > 1) {
        problems.push(`${currency} ${from}..${to}: a taken-back cost is still in the total (${live} vs ${whole})`);
      }

      /* ---- 3. no ISPO cost reaches a proprietor ---- */
      const ispoIds = new Set(ispoExpenses(expenses).map(e => e.id));
      const voidIds = new Set(expenses.filter(e => e.status === 'void').map(e => e.id));

      const ops = operationsStatement(expenses, payments, currency, from, to);
      for (const group of ops.groups) {
        for (const line of group.lines) {
          if (ispoIds.has(line.id)) problems.push(`${currency} ${from}: ISPO cost ${line.id} is on the proprietors' monthly report`);
          if (voidIds.has(line.id)) problems.push(`${currency} ${from}: taken-back cost ${line.id} is on the proprietors' monthly report`);
        }
      }
      for (const line of ops.unpaidLines) {
        if (ispoIds.has(line.id)) problems.push(`${currency} ${from}: ISPO bill ${line.id} is on the proprietors' unpaid memo`);
        if (voidIds.has(line.id)) problems.push(`${currency} ${from}: taken-back bill ${line.id} is on the proprietors' unpaid memo`);
      }

      const opsStrataOnly = operationsStatement(strataExpenses(expenses), payments, currency, from, to);
      if (Math.abs(cents(ops.costsPaid) - cents(opsStrataOnly.costsPaid)) > 1) {
        problems.push(`${currency} ${from}: the proprietors' report changes when ISPO's costs are removed, so it was counting them`);
      }

      /* ---- the combined statement's split is the whole of it ---- */
      const op = operatingStatement(payments, expenses, units, currency, from, to);
      if (Math.abs(cents(op.totalExpenditure) - (cents(op.strataExpenditure) + cents(op.ispoExpenditure))) > 1) {
        problems.push(
          `${currency} ${from}: the combined statement's split (${op.strataExpenditure} + ${op.ispoExpenditure}) does not make ${op.totalExpenditure}`
        );
      }
      if (op.internalTransfer < 0) problems.push(`${currency} ${from}: the internal transfer is negative`);

      /* ---- 5. the contribution is counted once ---- */
      /*
       * The same rule `isOwnAccount` applies, restated here on purpose: a check
       * that imported the function it is checking would agree with it by
       * construction. Everything except `owner-occupied` is ISPO's.
       */
      const ownIds = new Set(units.filter(u => u.status !== 'owner-occupied' && (u.maintCurrency || u.currency) === currency).map(u => u.id));
      const receivedOnOwn = payments
        .filter(p => p.status === 'completed' && p.currency === currency && p.category === 'Maintenance' && ownIds.has(p.unitId))
        .filter(p => p.date >= from && p.date <= to)
        .reduce((sum, p) => sum + p.amount, 0);
      if (cents(op.internalTransfer) > cents(receivedOnOwn) + 1) {
        problems.push(
          `${currency} ${from}: the internal transfer (${op.internalTransfer}) exceeds the contributions actually received on own-account villas (${receivedOnOwn})`
        );
      }

      /* ---- 4. the ISPO statement agrees with the shortfall report ---- */
      const ispo = ispoOperations(expenses, payments, units, currency, from, to);
      const shortfall = outOfPocketShortfall(units, tenancies, bookings, payments, currency, from, to);
      if (Math.abs(cents(ispo.maintenanceOnOwnVillas) - cents(shortfall.totalMaintenancePaid)) > 1) {
        problems.push(
          `${currency} ${from}..${to}: ISPO statement says ${ispo.maintenanceOnOwnVillas} of contributions on own villas, the shortfall report says ${shortfall.totalMaintenancePaid}`
        );
      }
      /*
       * Rent is deliberately scoped differently on the two documents, and the
       * simulation found that before a person did.
       *
       * ISPO's income is **every** rent and booking receipt, because the
       * corporation never collects a proprietor's rent, so any rent in the
       * system is money ISPO took. The shortfall report counts only villas
       * ticked as let on VDS's own account, because it is answering a narrower
       * question. So the right invariant is containment, not equality — and the
       * gap must be exactly what the ISPO statement declares as coming from
       * unflagged villas, which is the whole point of stating it there.
       */
      if (cents(ispo.rentReceived) < cents(shortfall.totalRentReceived) - 1) {
        problems.push(
          `${currency} ${from}..${to}: ISPO rent ${ispo.rentReceived} is less than the shortfall report's ${shortfall.totalRentReceived}, which it contains`
        );
      }
      const declaredGap = cents(ispo.incomeFromUnflaggedVillas);
      const actualGap = cents(ispo.rentReceived) + cents(ispo.bookingReceived) - cents(shortfall.totalRentReceived) - cents(shortfall.totalShortStayReceived);
      if (Math.abs(declaredGap - actualGap) > 1) {
        problems.push(
          `${currency} ${from}..${to}: the ISPO statement declares ${ispo.incomeFromUnflaggedVillas} from unflagged villas but the gap to the shortfall report is ${actualGap / 100}`
        );
      }
      if (ispo.incomeFromUnflaggedVillas > 0 && ispo.unflaggedVillasWithIncome.length === 0) {
        problems.push(`${currency} ${from}..${to}: income from unflagged villas is declared but no villa is named`);
      }
      for (const group of ispo.groups) {
        for (const line of group.lines) {
          if (!ispoIds.has(line.id)) problems.push(`${currency} ${from}: a strata cost (${line.id}) is on the ISPO statement`);
          if (voidIds.has(line.id)) problems.push(`${currency} ${from}: taken-back cost ${line.id} is on the ISPO statement`);
        }
      }
      if (isBadNumber(ispo.net) || isBadNumber(ispo.totalCosts)) problems.push(`${currency} ${from}: an ISPO figure is not finite`);
      if (ispo.totalCosts < 0 || ispo.ownCostsPaid < 0) problems.push(`${currency} ${from}: an ISPO cost total is negative`);
      // Own costs plus the contribution is the whole of the costs — nothing else
      // may creep into that total.
      if (Math.abs(cents(ispo.totalCosts) - (cents(ispo.ownCostsPaid) + cents(ispo.maintenanceOnOwnVillas))) > 1) {
        problems.push(`${currency} ${from}: ISPO total costs do not equal its own costs plus the contribution`);
      }

      /* ---- owner statements ---- */
      for (const st of ownerStatements(units, charges, payments, expenses, utilities, from, to)) {
        if (st.currency !== currency) continue;
        for (const item of st.expenseItems || []) {
          if (ispoIds.has(item.id)) problems.push(`ISPO cost ${item.id} is billed to villa ${st.unit.number}`);
          if (voidIds.has(item.id)) problems.push(`taken-back cost ${item.id} is billed to villa ${st.unit.number}`);
        }
        if (isBadNumber(st.net) || isBadNumber(st.expenses)) problems.push(`villa ${st.unit.number} has a non-finite figure`);
      }
    }

    /* ---- the statutory return ---- */
    const asOf = '2026-07-28';
    const debts = form13CDebts(expenses, asOf);
    const strataDebts = form13CDebts(strataExpenses(expenses), asOf);
    if (JSON.stringify(debts.totalsByCurrency) !== JSON.stringify(strataDebts.totalsByCurrency)) {
      problems.push("Form 13C changes when ISPO's bills are removed, so it was declaring them to the Commission");
    }
    for (const row of debts.rows) {
      if (isBadNumber(row.buckets.total)) problems.push('an ageing bucket is not a finite number');
      if (row.buckets.total < 0) problems.push('an ageing bucket is negative');
      const sum = row.buckets.d30 + row.buckets.d60 + row.buckets.d90 + row.buckets.over90;
      if (Math.abs(cents(sum) - cents(row.buckets.total)) > 1) problems.push('an ageing schedule does not add up to its own total');
    }

    /* ---- the annual report, and the fee it puts to the meeting ---- */
    const annual = annualOwnersReport(units, charges, payments, expenses, currency, 2026, {});
    const annualStrata = annualOwnersReport(units, charges, payments, strataExpenses(expenses), currency, 2026, {});
    if (Math.abs(cents(annual.expenditure) - cents(annualStrata.expenditure)) > 1) {
      problems.push(`${currency}: the annual report's expenditure counts ISPO's costs`);
    }
    if (Math.abs(cents(annual.feeToCoverBudget) - cents(annualStrata.feeToCoverBudget)) > 1) {
      problems.push(`${currency}: the contribution put to the meeting is affected by ISPO's costs`);
    }
    if (isBadNumber(annual.feeToCoverBudget) || annual.feeToCoverBudget < 0) {
      problems.push(`${currency}: the contribution put to the meeting is not a sane figure`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Books5k-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Books5k-1234!', 'Books5kNew-9876!');

    const rand = rng(20260903);

    /* ---------------- a property to work on ---------------- */

    const unitIds = [];
    for (let i = 1; i <= 8; i++) {
      const id = `unit-${i}`;
      const currency = i % 4 === 0 ? 'USD' : 'JMD';
      const res = await c.put(`/api/units/${id}`, {
        number: String(i),
        ownerName: i <= 3 ? 'Villaggio Del Sol' : `Proprietor ${i}`,
        tenantName: `Tenant ${i}`,
        status: 'long-term',
        monthlyRent: currency === 'USD' ? 900 : 80000,
        monthlyMaintenance: currency === 'USD' ? 200 : 20000,
        currency,
        maintCurrency: currency,
        rentDueDay: 1,
        maintDueDay: 1,
      });
      if (ok(res)) unitIds.push(id);
    }
    T.check('a property was configured to work on', unitIds.length === 8, `${unitIds.length} villas`);

    for (const month of MONTHS) await c.post('/api/charges/post-month', { monthString: month });

    /* ---------------- monthly costs in both books ---------------- */

    const templates = [];
    for (let i = 0; i < 6; i++) {
      const fund = i % 2 === 0 ? 'strata' : 'ispo';
      const res = await c.post('/api/recurring-expenses', {
        category: pick(rand, CATEGORIES),
        vendor: `${fund === 'ispo' ? 'ISPO' : 'Strata'} vendor ${i}`,
        unitNumber: 'General',
        amount: money(rand, 5000, 90000),
        currency: 'JMD',
        fund,
        dueDay: 1 + Math.floor(rand() * 27)
      });
      if (ok(res)) templates.push(res.body.template);
    }
    T.check('monthly costs exist in both books', templates.filter(t => t.fund === 'ispo').length > 0 && templates.filter(t => t.fund === 'strata').length > 0);

    /* ---------------- the run ---------------- */

    const periods = [
      ['2026-01-01', '2026-07-28'],
      ['2026-03-01', '2026-03-28'],
      ['2026-01-01', '2026-12-31']
    ];

    let performed = 0;
    let refused = 0;
    /*
     * Operations that found nothing to act on. Counted rather than ignored: the
     * first run's totals did not add up to five thousand and there was no way to
     * tell whether the missing operations had been skipped or silently lost.
     */
    let skipped = 0;
    let created = 0;
    let voided = 0;
    let recalled = 0;
    let removed = 0;
    let ispoCosts = 0;
    let strataCosts = 0;
    const allProblems = [];
    let deepAudits = 0;

    for (let i = 0; i < OPERATION_COUNT; i++) {
      const roll = rand();
      const month = pick(rand, MONTHS);

      if (roll < 0.34) {
        /* --- log a cost, in one book or the other --- */
        const fund = rand() < 0.35 ? 'ispo' : 'strata';
        const toVilla = rand() < 0.3;
        const paid = rand() < 0.65;
        const day = dayIn(month, 1 + Math.floor(rand() * 27));
        const res = await c.post('/api/expenses', {
          category: pick(rand, CATEGORIES),
          vendor: `Vendor ${Math.floor(rand() * 40)}`,
          description: `op ${i}`,
          ...(toVilla ? { unitId: pick(rand, unitIds) } : { unitNumber: pick(rand, ['General', 'Office']) }),
          amount: money(rand, 500, 120000),
          currency: rand() < 0.2 ? 'USD' : 'JMD',
          fund,
          status: paid ? 'paid' : 'pending',
          date: day,
          dueDate: day,
          ...(paid ? { datePaid: day } : {})
        });
        if (ok(res)) {
          performed++;
          if (fund === 'ispo') ispoCosts++;
          else strataCosts++;
        } else refused++;
      } else if (roll < 0.5) {
        /* --- take money --- */
        const unitId = pick(rand, unitIds);
        const category = pick(rand, ['Rent', 'Maintenance', 'Booking']);
        const unit = (await c.get('/api/db')).body.units.find(u => u.id === unitId);
        const currency = category === 'Maintenance' ? unit.maintCurrency || unit.currency : unit.currency;
        const created = await c.post('/api/payments', {
          unitId,
          category,
          amount: money(rand, 500, 90000),
          currency,
          payerName: `Payer ${Math.floor(rand() * 20)}`,
          method: 'Bank Transfer',
          date: dayIn(month, 1 + Math.floor(rand() * 27)),
          receivedNow: true
        });
        if (ok(created)) performed++;
        else refused++;
      } else if (roll < 0.62) {
        /* --- post a month's run --- */
        const res = await c.post('/api/expenses/post-month', { monthString: month });
        if (ok(res)) performed++;
        else refused++;
      } else if (roll < 0.74) {
        /* --- take a cost back --- */
        const db = (await c.get('/api/db')).body;
        const live = db.expenses.filter(e => e.status !== 'void');
        if (live.length === 0) { skipped++; continue; }
        const target = pick(rand, live);
        const res = await c.post(`/api/expenses/${target.id}/void`, {
          reason: `taken back by the simulation at op ${i}`,
          // Half the time, do not confirm — the settled refusal must hold.
          ...(rand() < 0.5 ? { confirmSettled: true } : {})
        });
        if (ok(res)) {
          performed++;
          voided++;
        } else {
          refused++;
          if (target.status === 'pending' && res.status === 400 && res.body?.code === 'expense-already-settled') {
            allProblems.push(`op ${i}: an unpaid cost was refused as though it were settled`);
          }
        }
      } else if (roll < 0.82) {
        /* --- recall a whole month --- */
        const res = await c.post('/api/expenses/recall-month', {
          monthString: month,
          reason: `month recalled by the simulation at op ${i}`,
          ...(rand() < 0.6 ? { includeSettled: true } : {})
        });
        if (ok(res)) {
          performed++;
          recalled++;
        } else refused++;
      } else if (roll < 0.88) {
        /* --- try to remove a monthly cost --- */
        const db = (await c.get('/api/db')).body;
        if ((db.recurringExpenses || []).length === 0) { skipped++; continue; }
        const target = pick(rand, db.recurringExpenses);
        let liveFromIt = db.expenses.filter(e => e.recurringId === target.id && e.status !== 'void');

        const first = await c.del(`/api/recurring-expenses/${target.id}`);
        if (ok(first)) {
          performed++;
          removed++;
          if (liveFromIt.length > 0) {
            allProblems.push(`op ${i}: a monthly cost with ${liveFromIt.length} live posting(s) was removed anyway`);
          }
        } else {
          refused++;
          if (liveFromIt.length === 0 && first.status === 400) {
            allProblems.push(`op ${i}: a monthly cost with nothing on the books was refused removal`);
          }
          if (liveFromIt.length > 0 && first.body?.code !== 'monthly-cost-has-postings') {
            allProblems.push(`op ${i}: a monthly cost still on the books was refused without the machine-readable code`);
          }

          /*
           * The remedy the refusal actually names, walked end to end: take the
           * postings back, then remove it. This is the workflow Ro will use, and
           * without it the simulation never reached the delete path at all — the
           * first run removed nothing in five thousand operations and the
           * coverage assertion said so.
           */
          if (rand() < 0.5 && liveFromIt.length > 0) {
            const months = [...new Set(liveFromIt.map(e => e.periodMonth).filter(Boolean))];
            for (const m of months) {
              await c.post('/api/expenses/recall-month', {
                monthString: m,
                reason: `clearing ${m} so the monthly cost can be removed`,
                includeSettled: true
              });
            }
            const after = (await c.get('/api/db')).body;
            liveFromIt = after.expenses.filter(e => e.recurringId === target.id && e.status !== 'void');
            const second = await c.del(`/api/recurring-expenses/${target.id}`);
            if (ok(second)) {
              performed++;
              removed++;
            } else if (liveFromIt.length === 0) {
              allProblems.push(
                `op ${i}: after taking every posting back, the monthly cost still could not be removed (${String(second.body?.error).slice(0, 120)})`
              );
            }
          }
        }
      } else if (roll < 0.94) {
        /* --- edit a cost, including moving it between the books --- */
        const db = (await c.get('/api/db')).body;
        const live = db.expenses.filter(e => e.status !== 'void');
        if (live.length === 0) { skipped++; continue; }
        const target = pick(rand, live);
        const res = await c.put(`/api/expenses/${target.id}`, {
          ...target,
          ...(target.unitId ? { unitId: target.unitId } : { unitNumber: target.unitNumber }),
          fund: pick(rand, FUNDS),
          amount: money(rand, 500, 120000)
        });
        if (ok(res)) performed++;
        else refused++;
      } else if (roll < 0.97) {
        /*
         * Set up a new monthly cost.
         *
         * Without this the simulation degenerated: the delete branch removed
         * templates faster than anything created them, so within a few hundred
         * operations there was nothing left to post, nothing to recall, and the
         * whole monthly-cost machinery stopped being exercised while every
         * invariant still passed. The coverage assertions caught it — "0
         * recalled" out of five thousand operations.
         */
        const fund = rand() < 0.4 ? 'ispo' : 'strata';
        const res = await c.post('/api/recurring-expenses', {
          category: pick(rand, CATEGORIES),
          vendor: `${fund === 'ispo' ? 'ISPO' : 'Strata'} vendor ${Math.floor(rand() * 500)}`,
          unitNumber: pick(rand, ['General', 'Office']),
          amount: money(rand, 2000, 90000),
          currency: rand() < 0.15 ? 'USD' : 'JMD',
          fund,
          dueDay: 1 + Math.floor(rand() * 27)
        });
        if (ok(res)) {
          performed++;
          created++;
        } else refused++;
      } else {
        /* --- change a monthly cost's book --- */
        const db = (await c.get('/api/db')).body;
        if ((db.recurringExpenses || []).length === 0) { skipped++; continue; }
        const target = pick(rand, db.recurringExpenses);
        const res = await c.put(`/api/recurring-expenses/${target.id}`, {
          ...target,
          unitNumber: target.unitNumber || 'General',
          fund: pick(rand, FUNDS)
        });
        if (ok(res)) performed++;
        else refused++;
      }

      if ((i + 1) % DEEP_EVERY === 0) {
        const db = (await c.get('/api/db')).body;
        deepAudits++;
        for (const problem of auditBooks(db, fin, periods)) {
          allProblems.push(`after op ${i + 1}: ${problem}`);
        }
      }
    }

    /* ---------------- what actually happened ---------------- */

    /*
     * Every operation is accounted for. `performed` can exceed the difference
     * because the remove branch walks a whole remedy — recall the months, then
     * remove — which is several API calls inside one operation.
     */
    T.check(
      'every one of the five thousand operations is accounted for',
      skipped + refused <= OPERATION_COUNT && performed + refused + skipped >= OPERATION_COUNT,
      `${performed} performed, ${refused} refused, ${skipped} found nothing to act on`
    );
    T.check('and a great many of them were accepted', performed > OPERATION_COUNT * 0.4, `${performed} performed`);
    T.check('the books were audited repeatedly as they accumulated', deepAudits >= 15, `${deepAudits} deep audits`);

    /*
     * Coverage assertions. Without these the invariants above could all hold
     * over a run that never exercised the thing being tested — the failure mode
     * this project has met more than once.
     */
    T.check('costs were raised in both books', ispoCosts > 100 && strataCosts > 100, `${strataCosts} strata, ${ispoCosts} ISPO`);
    T.check('costs were taken back', voided > 20, `${voided} taken back`);
    T.check('months were recalled', recalled > 20, `${recalled} recalled`);
    T.check('monthly costs were removed from the system', removed > 5, `${removed} removed`);
    T.check('and new ones were set up, so the population never died out', created > 50, `${created} created`);

    const db = (await c.get('/api/db')).body;
    T.check('the simulation moved real money', (db.payments || []).length > 100, `${(db.payments || []).length} receipts`);
    T.check('and raised real costs', (db.expenses || []).length > 200, `${(db.expenses || []).length} costs`);
    T.check(
      'and genuinely took some back, so the void path was exercised',
      db.expenses.filter(e => e.status === 'void').length > 20,
      `${db.expenses.filter(e => e.status === 'void').length} taken back on file`
    );
    T.check(
      'and both books are represented in the final database',
      db.expenses.some(e => e.fund === 'ispo') && db.expenses.some(e => e.fund !== 'ispo'),
      'one of the two books was empty at the end'
    );

    /* ---------------- the invariants ---------------- */

    for (const problem of auditBooks(db, fin, periods)) allProblems.push(`at the end: ${problem}`);

    T.check(
      'no sequence of legitimate operations left the two books misstating themselves',
      allProblems.length === 0,
      `${allProblems.length} problem(s); first few:\n  - ${allProblems.slice(0, 8).join('\n  - ')}`
    );

    /* ---------------- the application checking itself ---------------- */

    const check = await c.get('/api/integrity');
    const findings = check.body?.findings || [];
    const serious = findings.filter(f => f.severity === 'serious');
    T.check('the self-check ran against the accumulated books', check.status === 200, String(check.status));
    T.check(
      'and found nothing serious wrong with them',
      serious.length === 0,
      JSON.stringify(serious.map(f => ({ code: f.code, n: f.records?.length })))
    );

    T.check('the server is still answering', (await c.get('/api/health')).status === 200);
    T.check('the database still reads back cleanly', Array.isArray((await c.get('/api/db')).body?.expenses));
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
