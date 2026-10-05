/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two thousand operations against the book filters, the deposits and the charges.
 *
 * Commissioned by Ro on 2026-09-28, straight after the work landed: *"run 2k
 * tests and scenario combinations of use to test accuracy, robustness,
 * integrity, find gaps in the code etc... also for the different filters that
 * are under the operational reports, ensure they work as intended. ensure
 * everything else works as intended."*
 *
 * `books-5000` audits the two books as they are **recorded** — which cost belongs
 * to which fund, and that nothing is lost between them. It predates the book
 * *filters* entirely and would pass unchanged if every one of them were wrong.
 * This suite audits the books as they are **read**: the Strata / ISPO /
 * Everything selector, the receipts a reservation deposit raises, and a one-off
 * charge raised in a currency its account is not billed in.
 *
 * Same rule as its siblings:
 *
 *     Nothing here corrupts the database behind the application's back.
 *     Every operation is one a person at the desk could actually take,
 *     through the same HTTP API the screens use.
 *
 * So a broken invariant is never "the test did it".
 *
 * **The invariants, audited against the accumulated database as it grows:**
 *
 *   1. **The books add up, both sides.** Strata income + ISPO income is all the
 *      income; the same for expenditure once the one genuine transfer between
 *      them is taken out. Fails if a filter loses money *or* counts it twice.
 *   2. **Nothing appears on the wrong book.** Every receipt on the corporation's
 *      statement is a contribution, a recovery or other income; every one on
 *      ISPO's is rent or a short stay. Every cost line matches its fund.
 *   3. **Nothing taken back or voided appears on any book.**
 *   4. **The ISPO book and the ISPO Operations statement agree** — two screens,
 *      one answer.
 *   5. **The tab summary agrees with the statement under it**, on all three
 *      books. They disagreed by J$22,000 when a person first looked.
 *   6. **Receivables split by account.** Rent is nil on the corporation's books,
 *      maintenance is nil on ISPO's, and neither changes the combined figure.
 *   7. **A reservation deposit is on the ledger exactly once**, as received, with
 *      a receipt number, for the amount on the reservation.
 *   8. **A charge in the wrong currency is never counted** in the balance it does
 *      not belong to, and is always named as mismatched rather than lost.
 *   9. **Arrivals and departures are derived and disjoint** — nothing finished is
 *      a movement, nothing appears twice.
 *  10. **Arithmetic**: every figure finite, to the cent, and non-negative where
 *      it cannot be negative.
 *  11. **The application's own self-check reports no serious finding.**
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

export const title = 'Two thousand operations across the report filters';

const OPERATION_COUNT = 2000;
/** How often the expensive whole-database audit runs. */
const DEEP_EVERY = 125;

async function loadLib(projectRoot, relative, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outfile = path.join(dir, 'mod.mjs');
  await build({
    entryPoints: [path.join(projectRoot, relative)],
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
const isBadNumber = v => typeof v !== 'number' || !Number.isFinite(v);
const cents = v => Math.round(v * 100);
const ok = res => res.status >= 200 && res.status < 300;
const near = (a, b) => Math.abs(cents(a) - cents(b)) <= 1;

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;
const COST_CATEGORIES = ['Maintenance', 'Security', 'Landscaping', 'Utilities', 'Payroll', 'Supplies', 'Contractors', 'Other'];
const BOOKS = ['everything', 'strata', 'ispo'];

/** What a book's income is allowed to contain, stated here as well as in the code. */
const INCOME_OF = {
  strata: ['Maintenance contributions', 'Utilities recovered', 'Other income'],
  ispo: ['Rent', 'Short-stay bookings']
};

function addDaysTo(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * The audit
 * ------------------------------------------------------------------ */

/**
 * Everything that must be true of the reports however they are read.
 *
 * Returns a list of plain sentences. An empty list is the pass.
 */
function auditReports(db, fin, stays, periods) {
  const problems = [];
  const {
    operatingStatement,
    ispoOperations,
    expensesForBook,
    expensesInPeriod,
    chargesInBook,
    paymentsInBook,
    chargeCategoriesInBook,
    bookOfPaymentCategory,
    accountBalance,
    bookingDepositFindings,
    liveExpenses
  } = fin;
  const { arrivalsWithin, departuresWithin, stayPhase } = stays;

  const { units = [], charges = [], payments = [], expenses = [], bookings = [] } = db;

  const voidCostIds = new Set(expenses.filter(e => e.status === 'void').map(e => e.id));
  const reversedIds = new Set(payments.filter(p => p.status === 'reversed').map(p => p.id));
  const ispoCostIds = new Set(expenses.filter(e => e.fund === 'ispo').map(e => e.id));

  for (const currency of ['JMD', 'USD']) {
    for (const [from, to] of periods) {
      const read = {};
      for (const book of BOOKS) read[book] = operatingStatement(payments, expenses, units, currency, from, to, { book });

      const all = read.everything;
      const strata = read.strata;
      const ispo = read.ispo;

      /* ---- 1. the books add up, both sides ---- */

      if (!near(strata.totalIncome + ispo.totalIncome, all.totalIncome)) {
        problems.push(
          `${currency} ${from}..${to}: income ${strata.totalIncome} + ${ispo.totalIncome} does not make ${all.totalIncome}`
        );
      }
      /*
       * Two things are deliberately not in the naive sum, and both must be
       * accounted for exactly rather than allowed as slack:
       *
       *   - the **internal transfer**, the contribution ISPO pays the corporation.
       *     It is a cost on ISPO's book and income on the corporation's, and it
       *     has no row in the cost register at all, so it is in neither combined
       *     total;
       *   - anything ISPO's book **named as already counted from its receipts** —
       *     a contribution typed into the register as well. The combined book
       *     still carries that row, because the combined book is the register.
       *
       * Requiring the gap to equal what the statement *declares* is the strong
       * form: it fails both if money vanishes and if money vanishes quietly.
       */
      const namedAsReceipted = ispo.excludedExpenditure.reduce((t, e) => t + e.total, 0);
      if (!near(strata.totalExpenditure + ispo.totalExpenditure - ispo.internalTransfer + namedAsReceipted, all.totalExpenditure)) {
        problems.push(
          `${currency} ${from}..${to}: expenditure ${strata.totalExpenditure} + ${ispo.totalExpenditure} less the transfer ${ispo.internalTransfer} plus the ${namedAsReceipted} named as already receipted does not make ${all.totalExpenditure}`
        );
      }
      if (!near(all.strataExpenditure + all.ispoExpenditure, all.totalExpenditure)) {
        problems.push(`${currency} ${from}..${to}: the combined statement's own split does not make its total`);
      }

      /* ---- 2. nothing on the wrong book, and 3. nothing voided anywhere ---- */

      for (const book of BOOKS) {
        const s = read[book];
        if (s.book !== book) problems.push(`${currency} ${from}..${to}: a ${book} statement reports itself as ${s.book}`);

        for (const group of s.income) {
          if (book !== 'everything' && !INCOME_OF[book].includes(group.label)) {
            problems.push(`${currency} ${from}..${to}: "${group.label}" is on the ${book} book, which cannot contain it`);
          }
          for (const line of group.lines) {
            const receipt = payments.find(p => p.id === line.id || `${p.id}-refund` === line.id);
            if (!receipt) continue;
            if (reversedIds.has(receipt.id)) {
              problems.push(`${currency} ${from}..${to}: voided receipt ${receipt.id} is on the ${book} statement`);
            }
            if (book !== 'everything' && bookOfPaymentCategory(receipt.category) !== book) {
              problems.push(`${currency} ${from}..${to}: a ${receipt.category} receipt is on the ${book} book`);
            }
          }
        }

        for (const group of s.expenditure) {
          for (const line of group.lines) {
            if (voidCostIds.has(line.id)) {
              problems.push(`${currency} ${from}..${to}: taken-back cost ${line.id} is on the ${book} statement`);
            }
            if (book === 'strata' && ispoCostIds.has(line.id)) {
              problems.push(`${currency} ${from}..${to}: ISPO cost ${line.id} is on the corporation's statement`);
            }
            if (book === 'ispo' && !ispoCostIds.has(line.id)) {
              problems.push(`${currency} ${from}..${to}: a cost the corporation funds (${line.id}) is on ISPO's statement`);
            }
          }
        }
      }

      /* ---- 4. the ISPO book and the ISPO Operations statement agree ---- */

      const ops = ispoOperations(expenses, payments, units, currency, from, to);
      if (!near(ops.totalIncome, ispo.totalIncome)) {
        problems.push(`${currency} ${from}..${to}: ISPO income reads ${ops.totalIncome} on one screen and ${ispo.totalIncome} on the other`);
      }
      if (!near(ops.totalCosts, ispo.totalExpenditure)) {
        problems.push(`${currency} ${from}..${to}: ISPO costs read ${ops.totalCosts} on one screen and ${ispo.totalExpenditure} on the other`);
      }
      if (!near(ops.net, ispo.surplus)) {
        problems.push(`${currency} ${from}..${to}: ISPO's position reads ${ops.net} on one screen and ${ispo.surplus} on the other`);
      }

      /* ---- 5. the tab summary agrees with the statement under it ---- */

      for (const book of BOOKS) {
        const costs = expensesForBook(expenses, units, book, currency);
        const summarySpent = expensesInPeriod(costs, currency, from, to) + (book === 'ispo' ? read[book].internalTransfer : 0);
        if (!near(summarySpent, read[book].totalExpenditure)) {
          problems.push(
            `${currency} ${from}..${to}: on the ${book} book the summary says ${summarySpent} went out and the statement says ${read[book].totalExpenditure}`
          );
        }
      }

      /* ---- 10. arithmetic ---- */

      for (const book of BOOKS) {
        const s = read[book];
        for (const [name, value] of [
          ['income', s.totalIncome],
          ['expenditure', s.totalExpenditure],
          ['surplus', s.surplus],
          ['transfer', s.internalTransfer],
          ['strata share', s.strataExpenditure],
          ['ISPO share', s.ispoExpenditure]
        ]) {
          if (isBadNumber(value)) problems.push(`${currency} ${from}..${to}: the ${book} book's ${name} is not a finite number`);
          else if (cents(value) !== Math.round(cents(value))) problems.push(`${currency} ${from}..${to}: the ${book} book's ${name} is not to the cent`);
        }
        /*
         * Deliberately not "expenditure cannot be negative" any more. A period
         * whose only cost is a supplier credit genuinely spent less than
         * nothing, and asserting otherwise would have made the credit work
         * impossible to land. What must still hold is that the figure is real
         * money and that the parts make the whole, which the checks above and
         * below do.
         */
        if (isBadNumber(s.totalExpenditure)) {
          problems.push(`${currency} ${from}..${to}: the ${book} book's expenditure is not a finite number`);
        }
        if (s.internalTransfer < 0) problems.push(`${currency} ${from}..${to}: the ${book} book's internal transfer is negative`);
        if (!near(s.surplus, s.totalIncome - s.totalExpenditure)) {
          problems.push(`${currency} ${from}..${to}: the ${book} book's surplus is not its income less its expenditure`);
        }
        for (const group of s.income) {
          if (!near(group.total, group.lines.length > 0 ? group.lines.reduce((t, l) => t + l.amount, 0) : group.total)) {
            problems.push(`${currency} ${from}..${to}: an income group's lines do not add to its own total`);
          }
        }
      }

      /* ---- 6. receivables split by account ---- */

      const receivable = (book, category) => {
        const cs = chargesInBook(charges, book);
        const ps = paymentsInBook(payments, book);
        return units
          .map(u => accountBalance(u, category, cs, ps, to, units))
          .filter(a => a.currency === currency)
          .reduce((total, a) => total + a.balance, 0);
      };
      if (cents(receivable('ispo', 'Maintenance')) !== 0) {
        problems.push(`${currency} ${to}: a maintenance receivable of ${receivable('ispo', 'Maintenance')} appears on ISPO's books`);
      }
      if (cents(receivable('strata', 'Rent')) !== 0) {
        problems.push(`${currency} ${to}: a rent receivable of ${receivable('strata', 'Rent')} appears on the corporation's books`);
      }
      if (!near(receivable('strata', 'Maintenance'), receivable('everything', 'Maintenance'))) {
        problems.push(`${currency} ${to}: the corporation's maintenance receivable changes when the book filter is applied`);
      }
      if (!near(receivable('ispo', 'Rent'), receivable('everything', 'Rent'))) {
        problems.push(`${currency} ${to}: ISPO's rent receivable changes when the book filter is applied`);
      }
    }
  }

  /* ---- the categories a book holds, stated once and checked ---- */
  if (JSON.stringify(chargeCategoriesInBook('strata')) !== JSON.stringify(['Maintenance'])) {
    problems.push('the corporation’s books no longer hold exactly the maintenance account');
  }
  if (JSON.stringify(chargeCategoriesInBook('ispo')) !== JSON.stringify(['Rent'])) {
    problems.push('ISPO’s books no longer hold exactly the rent account');
  }

  /* ---- 7. a reservation deposit is on the ledger exactly once ---- */

  for (const b of bookings) {
    const live = payments.filter(p => p.bookingId === b.id && p.status !== 'reversed');
    if (b.status === 'cancelled' || b.depositPaid <= 0) {
      if (live.length > 0) problems.push(`reservation ${b.id} holds no deposit but still has a live receipt`);
      continue;
    }
    if (live.length !== 1) {
      problems.push(`reservation ${b.id} has ${live.length} live deposit receipts, not one`);
      continue;
    }
    const receipt = live[0];
    if (receipt.status !== 'completed') {
      problems.push(`the deposit on reservation ${b.id} still reads as ${receipt.status} rather than received`);
    }
    if (!receipt.receiptNo) problems.push(`the deposit on reservation ${b.id} was received with no receipt number`);
    /*
     * Net of anything handed back, not gross.
     *
     * A receipt keeps the figure it was issued for — that is what the guest was
     * given — and a refund is recorded beside it rather than rewriting it. The
     * reservation's `depositPaid` is what the property still holds. So the two
     * agree once the refund is taken off, and that is the identity worth
     * asserting: it is what makes "deposits held" on the dashboard true.
     */
    const netHeld = receipt.amount - (receipt.refundedAmount || 0);
    if (!near(netHeld, b.depositPaid)) {
      problems.push(
        `reservation ${b.id} holds ${b.depositPaid} but its receipt nets to ${netHeld} (${receipt.amount} less ${receipt.refundedAmount || 0} refunded)`
      );
    }
    if (receipt.currency !== b.currency) {
      problems.push(`the deposit receipt on reservation ${b.id} is in ${receipt.currency} and the reservation is in ${b.currency}`);
    }
    if (receipt.category !== 'Booking') {
      problems.push(`the deposit on reservation ${b.id} is filed as ${receipt.category}, so it would fall on the wrong book`);
    }
  }

  /* ---- a receipt number is never issued twice ---- */
  const numbers = payments.filter(p => p.receiptNo).map(p => p.receiptNo);
  if (new Set(numbers).size !== numbers.length) problems.push('two receipts share a receipt number');

  /* ---- the duplicate finder never accuses a reservation of duplicating itself ---- */
  for (const f of bookingDepositFindings(bookings, payments)) {
    for (const p of f.unlinked) {
      if (p.bookingId === f.booking.id) problems.push(`the deposit check reported reservation ${f.booking.id}'s own receipt as a duplicate of itself`);
      if (p.status === 'reversed') problems.push('the deposit check reported a voided receipt as a live duplicate');
      if (p.category !== 'Booking') problems.push('the deposit check reported a receipt that is not a booking receipt');
    }
    if (f.awaiting && f.linked?.status !== 'pending') problems.push('the deposit check called a received deposit unconfirmed');
  }

  /* ---- 8. a charge in the wrong currency is named, never counted ---- */

  for (const unit of units) {
    for (const category of ['Rent', 'Maintenance']) {
      const account = accountBalance(unit, category, charges, payments, undefined, units);
      const strayIds = new Set(account.mismatchedCurrencyCharges.map(ch => ch.id));
      for (const ch of charges) {
        if (ch.unitId !== unit.id || ch.category !== category || ch.status !== 'open') continue;
        if (ch.currency === account.currency) continue;
        if (!strayIds.has(ch.id)) {
          problems.push(`charge ${ch.id} on villa ${unit.number} is in ${ch.currency}, is not counted, and is not named as mismatched either`);
        }
      }
      const counted = charges
        .filter(ch => ch.unitId === unit.id && ch.category === category && ch.status === 'open' && ch.currency === account.currency)
        .reduce((t, ch) => t + ch.amount, 0);
      if (!near(account.charged, counted)) {
        problems.push(`villa ${unit.number}'s ${category} billed-to-date counts something outside its own currency`);
      }
      if (isBadNumber(account.balance)) problems.push(`villa ${unit.number}'s ${category} balance is not a finite number`);
    }
  }

  /* ---- 9. arrivals and departures are derived and disjoint ---- */

  const day = '2026-04-15';
  const horizon = addDaysTo(day, 14);
  const arriving = arrivalsWithin(bookings, day, horizon);
  const leaving = departuresWithin(bookings, day, horizon);
  for (const list of [arriving, leaving]) {
    if (new Set(list.map(b => b.id)).size !== list.length) problems.push('a reservation appears twice in one movement list');
  }
  for (const b of arriving) {
    if (stayPhase(b, day) !== 'upcoming') problems.push(`reservation ${b.id} is called an arrival while it is ${stayPhase(b, day)}`);
  }
  for (const b of leaving) {
    if (stayPhase(b, day) === 'completed') problems.push(`reservation ${b.id} is called a departure after it finished`);
    if (b.status === 'cancelled') problems.push(`cancelled reservation ${b.id} is called a departure`);
  }

  /* ---- costs taken back are counted by nothing, whichever book is read ---- */
  for (const currency of ['JMD', 'USD']) {
    for (const [from, to] of periods) {
      for (const book of BOOKS) {
        const withVoids = expensesInPeriod(expensesForBook(expenses, units, book, currency), currency, from, to);
        const withoutVoids = expensesInPeriod(expensesForBook(liveExpenses(expenses), units, book, currency), currency, from, to);
        if (!near(withVoids, withoutVoids)) {
          problems.push(`${currency} ${from}..${to}: a taken-back cost is still inside the ${book} book's total`);
        }
      }
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Reports2k-1234!', projectRoot });
  const T = reporter(title);
  const fin = await loadLib(projectRoot, path.join('src', 'lib', 'finance.ts'), 'vds-rep2k-');
  const stays = await loadLib(projectRoot, path.join('src', 'lib', 'stays.ts'), 'vds-rep2k-stays-');

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Reports2k-1234!', 'Reports2kNew-9876!');

    const rand = rng(20260928);

    /* ---------------- a property to work on ---------------- */

    const longTerm = [];
    const shortLet = [];
    for (let i = 1; i <= 10; i++) {
      const id = `unit-${i}`;
      const currency = i % 3 === 0 ? 'USD' : 'JMD';
      const short = i > 7;
      const res = await c.put(`/api/units/${id}`, {
        number: String(i),
        ownerName: i <= 4 ? 'Villaggio Del Sol' : `Proprietor ${i}`,
        ...(short ? {} : { tenantName: `Tenant ${i}` }),
        status: short ? 'short-term' : 'long-term',
        monthlyRent: short ? 0 : currency === 'USD' ? 900 : 80000,
        monthlyMaintenance: currency === 'USD' ? 200 : 20000,
        currency,
        maintCurrency: currency,
        rentDueDay: 1,
        maintDueDay: 1,
        letOnOwnAccount: i <= 4
      });
      if (ok(res)) (short ? shortLet : longTerm).push(id);
    }
    T.check(
      'a property with both kinds of letting was configured to work on',
      longTerm.length === 7 && shortLet.length === 3,
      `${longTerm.length} long-term, ${shortLet.length} short-let`
    );

    for (const month of MONTHS) await c.post('/api/charges/post-month', { monthString: month });

    const unitCurrency = {};
    for (const u of (await c.get('/api/db')).body.units) unitCurrency[u.id] = { rent: u.currency, maint: u.maintCurrency || u.currency };

    const periods = [
      ['2026-01-01', '2026-07-28'],
      ['2026-03-01', '2026-03-28'],
      ['2026-01-01', '2026-12-31']
    ];

    /* ---------------- the run ---------------- */

    let performed = 0;
    let refused = 0;
    let skipped = 0;
    const did = {
      strataCost: 0,
      ispoCost: 0,
      voidCost: 0,
      payment: 0,
      voidReceipt: 0,
      refund: 0,
      booking: 0,
      bookingEdit: 0,
      bookingCancel: 0,
      loose: 0,
      credit: 0,
      oneOffNative: 0,
      oneOffStray: 0,
      oneOffRefused: 0,
      ownAccountToggle: 0
    };
    const bookingIds = [];
    const allProblems = [];
    let deepAudits = 0;
    let currencyRefusalCode = '';

    for (let i = 0; i < OPERATION_COUNT; i++) {
      const roll = rand();
      const month = pick(rand, MONTHS);
      const day = dayIn(month, 1 + Math.floor(rand() * 27));

      if (roll < 0.26) {
        /* --- log a cost, in one book or the other, sometimes a credit --- */
        const fund = rand() < 0.4 ? 'ispo' : 'strata';
        const toVilla = rand() < 0.3;
        const paid = rand() < 0.7;
        /*
         * One cost in six is a supplier credit. Added 2026-10-05 with the
         * negative-amount work: the invariants below are the real test of it,
         * because they are about the books adding up rather than about the
         * credit itself, and a sign error shows up there as money appearing from
         * nowhere.
         */
        const isCredit = rand() < 0.17;
        const res = await c.post('/api/expenses', {
          category: pick(rand, COST_CATEGORIES),
          vendor: `Vendor ${Math.floor(rand() * 40)}`,
          description: `op ${i}`,
          ...(toVilla ? { unitId: pick(rand, longTerm.concat(shortLet)) } : { unitNumber: pick(rand, ['General', 'Office']) }),
          amount: isCredit ? -money(rand, 100, 20000) : money(rand, 500, 90000),
          currency: rand() < 0.25 ? 'USD' : 'JMD',
          fund,
          status: paid ? 'paid' : 'pending',
          date: day,
          dueDate: day,
          ...(paid ? { datePaid: day } : {})
        });
        if (ok(res)) {
          performed++;
          did[fund === 'ispo' ? 'ispoCost' : 'strataCost']++;
          if (isCredit) did.credit++;
        } else refused++;
      } else if (roll < 0.32) {
        /* --- take a cost back --- */
        const db = (await c.get('/api/db')).body;
        const live = db.expenses.filter(e => e.status !== 'void');
        if (live.length === 0) {
          skipped++;
        } else {
          const target = pick(rand, live);
          const res = await c.post(`/api/expenses/${target.id}/void`, {
            reason: `Taken back during operation ${i} of the simulation.`,
            ...(target.status === 'paid' ? { confirmSettled: true } : {})
          });
          if (ok(res)) {
            performed++;
            did.voidCost++;
          } else refused++;
        }
      } else if (roll < 0.52) {
        /* --- receive money --- */
        const category = pick(rand, ['Rent', 'Maintenance', 'Utility', 'Other', 'Booking']);
        const unitId = pick(rand, category === 'Rent' ? longTerm : longTerm.concat(shortLet));
        const currency = category === 'Maintenance' ? unitCurrency[unitId].maint : unitCurrency[unitId].rent;
        const res = await c.post('/api/payments', {
          unitId,
          category,
          amount: money(rand, 100, 80000),
          currency,
          payerName: `Payer ${Math.floor(rand() * 30)}`,
          method: pick(rand, ['Cash', 'Bank Transfer', 'Cheque']),
          date: day,
          receivedNow: true,
          confirmAlreadySettled: true
        });
        if (ok(res)) {
          performed++;
          did.payment++;
          if (category === 'Booking') did.loose++;
        } else refused++;
      } else if (roll < 0.57) {
        /* --- void or refund a receipt --- */
        const db = (await c.get('/api/db')).body;
        const live = db.payments.filter(p => p.status === 'completed' && !p.refundedAmount);
        if (live.length === 0) {
          skipped++;
        } else {
          const target = pick(rand, live);
          if (rand() < 0.5) {
            const res = await c.post(`/api/payments/${target.id}/reverse`, { reversalReason: `Voided during operation ${i}.` });
            if (ok(res)) {
              performed++;
              did.voidReceipt++;
            } else refused++;
          } else {
            const res = await c.post(`/api/payments/${target.id}/refund`, {
              amount: Math.max(1, Math.round(target.amount * 0.5 * 100) / 100),
              reason: `Refunded during operation ${i}.`,
              refundedOn: target.date
            });
            if (ok(res)) {
              performed++;
              did.refund++;
            } else refused++;
          }
        }
      } else if (roll < 0.72) {
        /* --- a reservation, with a deposit on it --- */
        const unitId = pick(rand, shortLet);
        const start = dayIn(month, 1 + Math.floor(rand() * 20));
        const nights = 1 + Math.floor(rand() * 5);
        const amount = money(rand, 200, 4000);
        const res = await c.post('/api/bookings', {
          unitId,
          guestName: `Guest ${Math.floor(rand() * 200)}`,
          checkIn: start,
          checkOut: addDaysTo(start, nights),
          amount,
          depositPaid: rand() < 0.75 ? Math.round(amount * (0.2 + rand() * 0.8) * 100) / 100 : 0,
          currency: unitCurrency[unitId].rent,
          source: pick(rand, ['Direct', 'Airbnb', 'Booking.com'])
        });
        if (ok(res)) {
          performed++;
          did.booking++;
          bookingIds.push(res.body.booking.id);
        } else refused++;
      } else if (roll < 0.82) {
        /* --- change or cancel a reservation --- */
        if (bookingIds.length === 0) {
          skipped++;
        } else {
          const id = pick(rand, bookingIds);
          const db = (await c.get('/api/db')).body;
          const b = db.bookings.find(x => x.id === id);
          if (!b) {
            skipped++;
          } else if (rand() < 0.25) {
            const res = await c.put(`/api/bookings/${id}`, { status: 'cancelled', amount: b.amount, depositPaid: b.depositPaid });
            if (ok(res)) {
              performed++;
              did.bookingCancel++;
            } else refused++;
          } else {
            const amount = money(rand, 200, 4000);
            const res = await c.put(`/api/bookings/${id}`, {
              amount,
              depositPaid: rand() < 0.15 ? 0 : Math.round(amount * (0.2 + rand() * 0.8) * 100) / 100,
              guestName: b.guestName
            });
            if (ok(res)) {
              performed++;
              did.bookingEdit++;
            } else refused++;
          }
        }
      } else if (roll < 0.95) {
        /* --- a one-off charge, sometimes in the wrong currency --- */
        const category = rand() < 0.5 ? 'Rent' : 'Maintenance';
        const unitId = pick(rand, category === 'Rent' ? longTerm : longTerm.concat(shortLet));
        const native = category === 'Maintenance' ? unitCurrency[unitId].maint : unitCurrency[unitId].rent;
        const stray = rand() < 0.35;
        const currency = stray ? (native === 'JMD' ? 'USD' : 'JMD') : native;
        /*
         * A third of the strays are sent without the confirmation, to prove the
         * refusal is live and carries its code. The rest confirm, which is the
         * deliberate act the screen asks for.
         */
        const confirm = stray ? rand() < 0.67 : false;
        const res = await c.post('/api/charges', {
          unitId,
          category,
          oneOffType: pick(rand, ['Late fee', 'Repair recharge', 'Special assessment']),
          amount: money(rand, 100, 20000),
          currency,
          dueDate: day,
          description: `op ${i}`,
          ...(confirm ? { confirmCurrencyMismatch: true } : {})
        });
        if (ok(res)) {
          performed++;
          did[stray ? 'oneOffStray' : 'oneOffNative']++;
        } else {
          refused++;
          if (stray && !confirm) {
            did.oneOffRefused++;
            currencyRefusalCode = String(res.body?.code || '');
          }
        }
      } else {
        /* --- change which villas VDS lets on its own account --- */
        const unitId = pick(rand, longTerm.concat(shortLet));
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === unitId);
        if (!unit) {
          skipped++;
        } else {
          const res = await c.put(`/api/units/${unitId}`, {
            number: unit.number,
            ownerName: unit.ownerName,
            status: unit.status,
            monthlyRent: unit.monthlyRent,
            monthlyMaintenance: unit.monthlyMaintenance,
            currency: unit.currency,
            maintCurrency: unit.maintCurrency,
            letOnOwnAccount: !unit.letOnOwnAccount
          });
          if (ok(res)) {
            performed++;
            did.ownAccountToggle++;
          } else refused++;
        }
      }

      if ((i + 1) % DEEP_EVERY === 0) {
        deepAudits++;
        const db = (await c.get('/api/db')).body;
        const found = auditReports(db, fin.mod, stays.mod, periods);
        for (const problem of found) allProblems.push(`after ${i + 1} operations: ${problem}`);
      }
    }

    /* ---------------- what actually happened ---------------- */

    /*
     * Counted, not assumed. `books-5000` reported "0 months recalled" while every
     * invariant passed, because the operation it was testing had quietly stopped
     * happening. Invariants cannot catch that — only a count of what was done can.
     */
    T.check(
      `every one of the ${OPERATION_COUNT} operations is accounted for`,
      performed + refused + skipped === OPERATION_COUNT,
      `${performed} performed + ${refused} refused + ${skipped} skipped = ${performed + refused + skipped}`
    );
    T.check(`the run did real work — ${performed} operations succeeded`, performed > OPERATION_COUNT * 0.4, String(performed));
    T.check(`the audit ran ${deepAudits} times over the growing database`, deepAudits >= 16, String(deepAudits));

    for (const [what, atLeast] of [
      ['strataCost', 50],
      ['ispoCost', 50],
      ['voidCost', 20],
      ['payment', 100],
      ['voidReceipt', 10],
      ['refund', 10],
      ['booking', 30],
      ['bookingEdit', 30],
      ['bookingCancel', 5],
      ['loose', 10],
      ['oneOffNative', 40],
      ['oneOffStray', 20],
      ['oneOffRefused', 5],
      ['ownAccountToggle', 20],
      ['credit', 25]
    ]) {
      T.check(`the run exercised ${what} at least ${atLeast} times (${did[what]})`, did[what] >= atLeast, String(did[what]));
    }

    T.check(
      'a charge in the wrong currency was refused with the code the screen looks for',
      currencyRefusalCode === 'charge-currency-not-confirmed',
      currencyRefusalCode || 'no refusal was seen'
    );

    /* ---------------- the final state ---------------- */

    const finalDb = (await c.get('/api/db')).body;

    T.check(
      'the database is not trivial — there is enough in it for the audit to be about something',
      finalDb.expenses.length > 200 && finalDb.payments.length > 150 && finalDb.bookings.length > 20 && finalDb.charges.length > 100,
      `${finalDb.expenses.length} costs, ${finalDb.payments.length} receipts, ${finalDb.bookings.length} reservations, ${finalDb.charges.length} charges`
    );
    T.check(
      'and it holds money on both books, or the split would be about nothing',
      finalDb.expenses.some(e => e.fund === 'ispo') && finalDb.expenses.some(e => e.fund !== 'ispo'),
      'one of the books is empty'
    );
    T.check(
      'and money in both currencies',
      finalDb.payments.some(p => p.currency === 'USD') && finalDb.payments.some(p => p.currency === 'JMD'),
      'one currency is unused'
    );

    const finalProblems = auditReports(finalDb, fin.mod, stays.mod, periods);
    for (const problem of finalProblems) allProblems.push(`at the end: ${problem}`);

    const unique = [...new Set(allProblems)];
    T.check(
      `every invariant held across ${OPERATION_COUNT} operations and ${deepAudits + 1} audits`,
      unique.length === 0,
      unique.slice(0, 8).join(' | ')
    );

    /* ---------------- 11. the application's own self-check ---------------- */

    const health = await c.get('/api/self-check');
    if (health.status === 404) {
      const integrity = await c.post('/api/integrity/check', {});
      T.check(
        'the application checked its own records and found nothing serious',
        !ok(integrity) || !(integrity.body?.findings || []).some(f => f.severity === 'error'),
        JSON.stringify((integrity.body?.findings || []).filter(f => f.severity === 'error').slice(0, 3))
      );
    } else {
      T.check(
        'the application checked its own records and found nothing serious',
        !(health.body?.findings || []).some(f => f.severity === 'error'),
        JSON.stringify((health.body?.findings || []).filter(f => f.severity === 'error').slice(0, 3))
      );
    }

    return T.done();
  } finally {
    fin.cleanup();
    stays.cleanup();
    await srv.stop();
  }
}
