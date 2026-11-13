/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reading the Operational Reports tab on one set of books.
 *
 * Ro, 2026-09-28: *"The operational reports tab is showing payments for both ISPO
 * and the BNS Strata. Both are not supposed to be mixed... The operating statement
 * section shows all figures calculated in both with no separation or option to be
 * separated. The 'Internal-Everything' tab does not separate the calculations,
 * neither does the 'For the Strata corporation' which is precisely what it was
 * built in for... Short term rentals should also be an internal calculation and
 * not a part of the strata operating statement or calculations especially when
 * printed. The filters and metrics need to actually work. Strata, ISPO and
 * Everything. There must be options to separate, especially for when the
 * accountant comes."*
 *
 * `test/two-books.test.mjs` already proves ISPO's costs stay off every
 * owner-facing and statutory document. This file is about the one document that
 * was deliberately left combined — the operating statement — and the management
 * figures above it, neither of which could be read on one book at all.
 *
 * The rules, in the property's own terms rather than the code's:
 *
 *   1. On the corporation's books there is no rent and no short-stay rental, and
 *      none of ISPO's costs.
 *   2. On ISPO's books there is nothing but rent and short-stay rental, and
 *      nothing but ISPO's own costs — plus the maintenance ISPO paid over, which
 *      is a real cost to it and has no bill behind it anywhere.
 *   3. The two books add up to everything, on both sides, in both currencies.
 *      Nothing is lost and nothing is counted twice.
 *   4. ISPO's book and the ISPO Operations statement answer the same question
 *      about the same period, so they must give the same answer.
 *   5. Every page says which books it was read on.
 *   6. A caller that names no book gets everything — the combined statement Ro
 *      keeps as his all-in view, unchanged.
 *   7. A contribution typed into the cost register as well as receipted is counted
 *      once on ISPO's book, and named rather than dropped in silence.
 *   8. Receivables split the same way: rent arrears are ISPO's, maintenance
 *      arrears are the corporation's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Reading the reports on one set of books';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rbooks-'));
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

function lastMonth() {
  const now = new Date();
  const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

/** Every payer named anywhere on a statement's income side. */
function payersOn(statement) {
  return statement.income.flatMap(g => g.lines.map(l => l.payer));
}

/** Every payee named anywhere on a statement's expenditure side. */
function payeesOn(statement) {
  return statement.expenditure.flatMap(g => g.lines.map(l => l.payee));
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'RBooks-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const {
    operatingStatement,
    ispoOperations,
    chargeCategoriesInBook,
    chargesInBook,
    expensesForBook,
    expensesInPeriod,
    paymentsInBook,
    expensesInBook,
    bookOfPaymentCategory,
    accountBalance,
    REPORT_BOOK_SCOPE
  } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'RBooks-1234!', 'RBooksNew-9876!');

    const month = lastMonth();
    const from = `${month}-01`;
    const to = `${month}-28`;

    // Villa 1 is let by VDS on its own account. Villa 2 belongs to a proprietor.
    await makeLongTermUnit(c, 'unit-1', { ownerName: 'Villaggio Del Sol' });
    /*
     * A proprietor's villa is `owner-occupied`: the corporation bills it
     * maintenance only and never collects its rent, so its contribution is a
     * proprietor's money arriving, not VDS moving money between its own books.
     */
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'A Proprietor',
      status: 'owner-occupied',
      monthlyRent: 0,
      monthlyMaintenance: 10000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    await c.post('/api/charges/post-month', { monthString: month });

    /* ---------------- the money ---------------- */

    const CONTRIBUTION = 10000;
    for (const unitId of ['unit-1', 'unit-2']) {
      await recordAndConfirmPayment(c, {
        unitId,
        category: 'Maintenance',
        amount: CONTRIBUTION,
        currency: 'JMD',
        payerName: unitId === 'unit-1' ? 'Villaggio Del Sol' : 'A Proprietor',
        method: 'Bank Transfer',
        date: `${month}-04`
      });
    }

    const RENT = 50000;
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Rent',
      amount: RENT,
      currency: 'JMD',
      payerName: 'A Long Tenant',
      method: 'Bank Transfer',
      date: `${month}-03`
    });

    const BOOKING = 27000;
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Booking',
      amount: BOOKING,
      currency: 'JMD',
      payerName: 'A Short Guest',
      method: 'Cash',
      date: `${month}-06`
    });

    const UTILITY_RECOVERED = 4000;
    await recordAndConfirmPayment(c, {
      unitId: 'unit-2',
      category: 'Utility',
      amount: UTILITY_RECOVERED,
      currency: 'JMD',
      payerName: 'A Proprietor',
      method: 'Cash',
      date: `${month}-07`
    });

    /* ---------------- the costs ---------------- */

    const STRATA_COSTS = [
      { category: 'Security', vendor: 'Guardsman Ltd', amount: 96000 },
      { category: 'Landscaping', vendor: 'Grounds Crew', amount: 30000 }
    ];
    for (const cost of STRATA_COSTS) {
      await c.post('/api/expenses', {
        ...cost,
        unitNumber: 'General',
        currency: 'JMD',
        status: 'paid',
        date: `${month}-10`,
        datePaid: `${month}-10`
      });
    }
    const STRATA_TOTAL = 96000 + 30000;

    const ISPO_COSTS = [
      { category: 'Utilities', vendor: 'Digicel', description: 'Company cell phones', amount: 18000 },
      { category: 'Other', vendor: 'Insurance Co', description: 'Company vehicle insurance', amount: 12000 }
    ];
    for (const cost of ISPO_COSTS) {
      await c.post('/api/expenses', {
        ...cost,
        unitNumber: 'General',
        currency: 'JMD',
        fund: 'ispo',
        status: 'paid',
        date: `${month}-12`,
        datePaid: `${month}-12`
      });
    }
    const ISPO_TOTAL = 18000 + 12000;

    const db = (await c.get('/api/db')).body;
    const st = book => operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to, { book });

    const everything = st('everything');
    const strata = st('strata');
    const ispo = st('ispo');

    T.check(
      'the period went in as intended — there is rent, a booking, contributions and both kinds of cost to separate',
      everything.totalIncome === RENT + BOOKING + UTILITY_RECOVERED + CONTRIBUTION * 2 &&
        everything.totalExpenditure === STRATA_TOTAL + ISPO_TOTAL,
      `income ${everything.totalIncome}, expenditure ${everything.totalExpenditure}`
    );

    /* ================================================================
     * Rule 1 — the corporation's books carry no rent and no short stays
     * ================================================================ */

    T.check(
      'rent is not income of the strata corporation',
      !payersOn(strata).includes('A Long Tenant') && !strata.income.some(g => g.label === 'Rent'),
      JSON.stringify(strata.income.map(g => g.label))
    );
    T.check(
      'a short-stay guest is not income of the strata corporation',
      !payersOn(strata).includes('A Short Guest') && !strata.income.some(g => g.label === 'Short-stay bookings'),
      JSON.stringify(strata.income.map(g => g.label))
    );
    T.check(
      'the corporation’s income is its contributions and what it recovered, and nothing else',
      strata.totalIncome === CONTRIBUTION * 2 + UTILITY_RECOVERED,
      `${strata.totalIncome}, expected ${CONTRIBUTION * 2 + UTILITY_RECOVERED}`
    );
    T.check(
      'the company cell phone is not expenditure of the strata corporation',
      !payeesOn(strata).includes('Digicel'),
      JSON.stringify(payeesOn(strata))
    );
    T.check(
      'nor is the company vehicle insurance',
      !payeesOn(strata).includes('Insurance Co'),
      JSON.stringify(payeesOn(strata))
    );
    T.check(
      'the corporation’s expenditure is the costs contributions fund, and nothing else',
      strata.totalExpenditure === STRATA_TOTAL && strata.ispoExpenditure === 0,
      `${strata.totalExpenditure} total, ${strata.ispoExpenditure} ISPO`
    );

    /* ================================================================
     * Rule 2 — ISPO's books carry its trade and its own costs
     * ================================================================ */

    T.check(
      'ISPO’s income is the rent and the short stay',
      ispo.totalIncome === RENT + BOOKING,
      `${ispo.totalIncome}, expected ${RENT + BOOKING}`
    );
    T.check(
      'no proprietor’s contribution is counted as ISPO’s income',
      !payersOn(ispo).includes('A Proprietor'),
      JSON.stringify(payersOn(ispo))
    );
    T.check(
      'security and grounds are not ISPO’s costs',
      !payeesOn(ispo).includes('Guardsman Ltd') && !payeesOn(ispo).includes('Grounds Crew'),
      JSON.stringify(payeesOn(ispo))
    );
    T.check(
      'the maintenance ISPO paid on the villa it lets is a cost on its own books, though no bill exists for it',
      ispo.internalTransfer === CONTRIBUTION &&
        ispo.expenditure.some(g => g.label === 'Maintenance contributions paid to the corporation' && g.total === CONTRIBUTION),
      `transfer ${ispo.internalTransfer}; groups ${JSON.stringify(ispo.expenditure.map(g => g.label))}`
    );
    T.check(
      'so ISPO’s expenditure is its own costs plus what it paid the corporation',
      ispo.totalExpenditure === ISPO_TOTAL + CONTRIBUTION,
      `${ispo.totalExpenditure}, expected ${ISPO_TOTAL + CONTRIBUTION}`
    );

    /* ================================================================
     * Rule 3 — the two books add up to everything, both sides
     * ================================================================ */

    /*
     * The arithmetic guarantee against double counting, and the assertion that
     * would fail if a filter dropped a class of money rather than moving it. The
     * internal transfer is taken off ISPO's side because it is the one figure that
     * is genuinely on both books — see rule 2 and `internalTransfer`'s own note.
     */
    T.check(
      'income: the corporation’s plus ISPO’s is all of it, with nothing lost and nothing doubled',
      strata.totalIncome + ispo.totalIncome === everything.totalIncome,
      `${strata.totalIncome} + ${ispo.totalIncome} vs ${everything.totalIncome}`
    );
    T.check(
      'expenditure: the same, once the one transfer between the books is taken out',
      strata.totalExpenditure + ispo.totalExpenditure - ispo.internalTransfer === everything.totalExpenditure,
      `${strata.totalExpenditure} + ${ispo.totalExpenditure} - ${ispo.internalTransfer} vs ${everything.totalExpenditure}`
    );
    T.check(
      'and the combined statement still names the split it always named',
      everything.strataExpenditure === STRATA_TOTAL && everything.ispoExpenditure === ISPO_TOTAL,
      `${everything.strataExpenditure} strata, ${everything.ispoExpenditure} ISPO`
    );

    /* ================================================================
     * Rule 4 — ISPO's book and the ISPO statement must agree
     * ================================================================ */

    const ops = ispoOperations(db.expenses, db.payments, db.units, 'JMD', from, to);
    T.check(
      'the ISPO Operations statement and the operating statement on ISPO’s books report the same income',
      ops.totalIncome === ispo.totalIncome,
      `${ops.totalIncome} vs ${ispo.totalIncome}`
    );
    T.check(
      'the same costs',
      ops.totalCosts === ispo.totalExpenditure,
      `${ops.totalCosts} vs ${ispo.totalExpenditure}`
    );
    T.check(
      'and therefore the same position for the period — two screens, one answer',
      ops.net === ispo.surplus,
      `${ops.net} vs ${ispo.surplus}`
    );

    /* ================================================================
     * Rule 5 — every page says which books it was read on
     * ================================================================ */

    T.check(
      'a statement carries the book it was read on, so a printed page can name it',
      everything.book === 'everything' && strata.book === 'strata' && ispo.book === 'ispo',
      `${everything.book} / ${strata.book} / ${ispo.book}`
    );
    T.check(
      'and each book has a sentence stating its scope, for the head of a printed page',
      ['everything', 'strata', 'ispo'].every(b => typeof REPORT_BOOK_SCOPE[b] === 'string' && REPORT_BOOK_SCOPE[b].length > 40),
      JSON.stringify(REPORT_BOOK_SCOPE)
    );

    /* ================================================================
     * Rule 6 — naming no book gives everything, exactly as before
     * ================================================================ */

    const unspecified = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to);
    T.check(
      'a caller that names no book gets the combined statement, unchanged',
      unspecified.totalIncome === everything.totalIncome &&
        unspecified.totalExpenditure === everything.totalExpenditure &&
        unspecified.book === 'everything',
      `${unspecified.totalIncome}/${unspecified.totalExpenditure}/${unspecified.book}`
    );

    /* ================================================================
     * Rule 7 — a contribution typed into the cost register too
     * ================================================================ */

    /*
     * The one shape that would be the same money twice on ISPO's books: the
     * contribution is already counted from its receipt, so a cost row for it as
     * well must not be added. It is named on the statement rather than dropped,
     * which is this codebase's standing rule.
     */
    await c.post('/api/expenses', {
      category: 'Maintenance',
      vendor: 'The Proprietors, Strata Plan No. 2324',
      description: 'Monthly contribution on villa 1',
      unitId: 'unit-1',
      unitNumber: '1',
      amount: CONTRIBUTION,
      currency: 'JMD',
      fund: 'ispo',
      status: 'paid',
      date: `${month}-05`,
      datePaid: `${month}-05`
    });
    const db2 = (await c.get('/api/db')).body;
    const ispo2 = operatingStatement(db2.payments, db2.expenses, db2.units, 'JMD', from, to, { book: 'ispo' });

    T.check(
      'a contribution typed into the cost register as well does not raise ISPO’s costs a second time',
      ispo2.totalExpenditure === ispo.totalExpenditure,
      `${ispo2.totalExpenditure}, expected ${ispo.totalExpenditure}`
    );
    T.check(
      'and it is named on the statement rather than dropped in silence',
      ispo2.excludedExpenditure.some(e => e.total === CONTRIBUTION && /register/i.test(e.label)),
      JSON.stringify(ispo2.excludedExpenditure)
    );
    T.check(
      'the ISPO Operations statement and the operating statement still agree after it',
      ispoOperations(db2.expenses, db2.payments, db2.units, 'JMD', from, to).net === ispo2.surplus,
      `${ispoOperations(db2.expenses, db2.payments, db2.units, 'JMD', from, to).net} vs ${ispo2.surplus}`
    );

    /* ================================================================
     * Rule 8 — receivables split the same way
     * ================================================================ */

    T.check(
      'rent arrears belong to ISPO’s books and maintenance arrears to the corporation’s',
      JSON.stringify(chargeCategoriesInBook('strata')) === JSON.stringify(['Maintenance']) &&
        JSON.stringify(chargeCategoriesInBook('ispo')) === JSON.stringify(['Rent']) &&
        JSON.stringify(chargeCategoriesInBook('everything')) === JSON.stringify(['Rent', 'Maintenance']),
      JSON.stringify([chargeCategoriesInBook('strata'), chargeCategoriesInBook('ispo'), chargeCategoriesInBook('everything')])
    );

    const receivable = (book, category) => {
      const cs = chargesInBook(db2.charges, book);
      const ps = paymentsInBook(db2.payments, book);
      return db2.units
        .map(u => accountBalance(u, category, cs, ps, to, db2.units))
        .filter(a => a.currency === 'JMD')
        .reduce((total, a) => total + a.balance, 0);
    };

    /*
     * A maintenance account read on ISPO's books has no charges and no receipts,
     * so it stands at nil — not at the arrears the combined view shows. That is
     * the whole point of the separation, and it is asserted rather than assumed
     * because the filter is applied by choosing which categories to walk.
     */
    T.check(
      'a maintenance account read on ISPO’s books is nil, because none of it is ISPO’s',
      receivable('ispo', 'Maintenance') === 0,
      String(receivable('ispo', 'Maintenance'))
    );
    T.check(
      'a rent account read on the corporation’s books is nil, because the corporation does not collect rent',
      receivable('strata', 'Rent') === 0,
      String(receivable('strata', 'Rent'))
    );
    T.check(
      'and the corporation’s maintenance receivable is unchanged by the separation',
      receivable('strata', 'Maintenance') === receivable('everything', 'Maintenance'),
      `${receivable('strata', 'Maintenance')} vs ${receivable('everything', 'Maintenance')}`
    );

    /* ================================================================
     * Rule 9 — the summary at the top of the tab agrees with the
     *          statement underneath it, on every book
     * ================================================================ */

    /*
     * Two parts of one screen answering the same question. The management summary
     * builds "Expenses paid" from the cost register and the operating statement
     * builds its expenditure total from the same register — and on ISPO's book
     * they disagreed by the contribution ISPO pays the corporation, which is real
     * money out with no bill behind it, and again by a contribution typed into the
     * register as well, which the statement excluded and the summary did not.
     *
     * Asserted here with the very expressions the screen uses, so neither can be
     * changed without the other.
     */
    for (const b of ['everything', 'strata', 'ispo']) {
      const statement = operatingStatement(db2.payments, db2.expenses, db2.units, 'JMD', from, to, { book: b });
      const costs = expensesForBook(db2.expenses, db2.units, b, 'JMD');
      const summarySpent =
        expensesInPeriod(costs, 'JMD', from, to) + (b === 'ispo' ? statement.internalTransfer : 0);
      T.check(
        `on the ${b} book, what the summary says was paid out is what the statement totals`,
        summarySpent === statement.totalExpenditure,
        `summary ${summarySpent} vs statement ${statement.totalExpenditure}`
      );
    }
    T.check(
      'and that comparison was made against real money, not three zeros agreeing',
      operatingStatement(db2.payments, db2.expenses, db2.units, 'JMD', from, to, { book: 'ispo' }).totalExpenditure > 0 &&
        operatingStatement(db2.payments, db2.expenses, db2.units, 'JMD', from, to, { book: 'strata' }).totalExpenditure > 0,
      'one of the books had nothing in it'
    );

    /* ---------------- the mapping itself, stated once ---------------- */

    T.check(
      'rent and short stays are ISPO’s; contributions, recoveries and other income are the corporation’s',
      bookOfPaymentCategory('Rent') === 'ispo' &&
        bookOfPaymentCategory('Booking') === 'ispo' &&
        bookOfPaymentCategory('Maintenance') === 'strata' &&
        bookOfPaymentCategory('Utility') === 'strata' &&
        bookOfPaymentCategory('Other') === 'strata',
      'the income mapping moved'
    );
    T.check(
      'and a cost with no book named stays the corporation’s under the book filter',
      expensesInBook(db2.expenses, 'strata').every(e => e.fund !== 'ispo') &&
        expensesInBook(db2.expenses, 'strata').some(e => e.vendor === 'Guardsman Ltd'),
      JSON.stringify(expensesInBook(db2.expenses, 'strata').map(e => e.vendor))
    );

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
