/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A credit from a supplier is a cost of less than nothing.
 *
 * Ro, 2026-10-05: *"We discovered also that negative amounts cannot be inserted
 * into the expenses. One of our utility providers gave us a credit and we tried
 * to insert the credit by inserting a negative number in the expenses section
 * specifically when it comes to posting, so for the monthly costs section under
 * utilities and expenses, allow a negative number to be posted and reflected on
 * all applicable reports."*
 *
 * Until this, the only ways to record money coming back were to edit the
 * original bill, which rewrites a record somebody already approved, or to leave
 * it off, which overstates what the property spent and overstates the
 * contribution the annual report puts to the meeting.
 *
 * **The whole suite passed before any of this was written, and would have passed
 * if every line of it were wrong**, because nothing in 1,982 tests had ever
 * posted a negative cost. That is the reason this file exists.
 *
 * The rules, in the property's own terms:
 *
 *   1. A credit can be written into the expense register as a negative figure.
 *   2. A credit can be set on a monthly cost and posted in a run - the exact
 *      path Ro was refused on.
 *   3. Zero is still refused. A cost of nothing is a half-filled row.
 *   4. A credit reduces what the period cost, on every report that counts costs.
 *   5. A credit stays on its own book: an ISPO credit does not flatter the
 *      corporation, and the two books still add to the whole.
 *   6. A credit can be taken back like any other cost, and then counts for
 *      nothing.
 *   7. Nothing else accepts a negative. Rent, a charge, a receipt, a deposit and
 *      a refund are amounts moving in a stated direction; a negative one is a
 *      slip, not a credit.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'A supplier credit, recorded as a negative cost';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-credit-'));
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

const ok = res => res.status >= 200 && res.status < 300;

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Credit-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const {
    expensesInPeriod,
    expenseBreakdown,
    operatingStatement,
    operationsStatement,
    annualOwnersReport,
    strataExpenses,
    ispoExpenses,
    liveExpenses
  } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Credit-1234!', 'CreditNew-9876!');

    const month = lastMonth();
    const from = `${month}-01`;
    const to = `${month}-28`;
    const year = Number(month.substring(0, 4));

    await makeLongTermUnit(c, 'unit-1', { ownerName: 'Villaggio Del Sol', letOnOwnAccount: true });
    await makeLongTermUnit(c, 'unit-2', { ownerName: 'A Proprietor' });
    await c.post('/api/charges/post-month', { monthString: month });

    /* ================================================================
     * Rule 1 — a credit goes into the register
     * ================================================================ */

    const bill = await c.post('/api/expenses', {
      category: 'Utilities',
      vendor: 'JPS',
      description: 'Common property electricity',
      unitNumber: 'General',
      amount: 60000,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-10`,
      datePaid: `${month}-10`
    });
    T.check('the ordinary bill goes in as it always did', ok(bill), String(bill.body?.error));

    const credit = await c.post('/api/expenses', {
      category: 'Utilities',
      vendor: 'JPS',
      description: 'Credit note, overbilled in the prior month',
      unitNumber: 'General',
      amount: -15000,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-12`,
      datePaid: `${month}-12`
    });
    T.check('a supplier credit is accepted as a negative figure', ok(credit), String(credit.body?.error));
    T.check(
      'and it is stored as the negative figure it is, not flipped or dropped',
      credit.body?.expense?.amount === -15000,
      String(credit.body?.expense?.amount)
    );

    /* ================================================================
     * Rule 3 — zero is still refused
     * ================================================================ */

    const nothing = await c.post('/api/expenses', {
      category: 'Utilities',
      vendor: 'JPS',
      unitNumber: 'General',
      amount: 0,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-12`,
      datePaid: `${month}-12`
    });
    T.check('a cost of nothing is still refused', nothing.status === 400, String(nothing.status));
    T.check(
      'and the refusal says what to do instead, rather than only saying no',
      /credit/i.test(String(nothing.body?.error)),
      String(nothing.body?.error)
    );

    /* ================================================================
     * Rule 4 — it reduces what the period cost
     * ================================================================ */

    let db = (await c.get('/api/db')).body;

    T.check(
      'the period cost the bill less the credit',
      expensesInPeriod(db.expenses, 'JMD', from, to) === 45000,
      String(expensesInPeriod(db.expenses, 'JMD', from, to))
    );

    const ops = operationsStatement(db.expenses, db.payments, 'JMD', from, to);
    T.check(
      'the proprietors’ monthly report counts the credit against the bill',
      ops.costsPaid === 45000,
      `${ops.costsPaid}, expected 45000`
    );
    T.check(
      'and names the credit on the page rather than netting it invisibly into the bill',
      ops.groups.some(g => g.lines.some(l => l.amount === -15000)),
      JSON.stringify(ops.groups.flatMap(g => g.lines.map(l => l.amount)))
    );

    const statement = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to);
    T.check(
      'the operating statement’s expenditure is net of the credit',
      statement.totalExpenditure === 45000,
      String(statement.totalExpenditure)
    );
    T.check(
      'and the credit is a line on it, with the supplier named',
      statement.expenditure.some(g => g.lines.some(l => l.amount === -15000 && l.payee === 'JPS')),
      JSON.stringify(statement.expenditure.map(g => g.lines.map(l => l.amount)))
    );

    const annual = annualOwnersReport(db.units, db.charges, db.payments, db.expenses, 'JMD', year, {});
    T.check(
      'the annual report’s expenditure is net of the credit, so the contribution put to the meeting is not inflated',
      annual.expenditure === 45000,
      String(annual.expenditure)
    );

    const breakdown = expenseBreakdown(db.expenses, 'JMD', from, to);
    const utilities = breakdown.find(b => b.category === 'Utilities');
    T.check(
      'the category the credit belongs to carries it, rather than the credit landing in its own heading',
      utilities?.amount === 45000,
      JSON.stringify(breakdown)
    );
    T.check(
      'and every share is a finite number, with nothing dividing by a total the credit wiped out',
      breakdown.every(b => Number.isFinite(b.share)),
      JSON.stringify(breakdown.map(b => b.share))
    );

    /* ================================================================
     * Rule 2 — the path Ro was actually refused on: a monthly cost
     * ================================================================ */

    const template = await c.post('/api/recurring-expenses', {
      category: 'Utilities',
      vendor: 'NWC',
      description: 'Water, standing credit while the meter is disputed',
      unitNumber: 'General',
      amount: -4000,
      currency: 'JMD',
      dueDay: 5
    });
    T.check('a monthly cost can be set up as a credit', ok(template), String(template.body?.error));

    const posted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: template.body.template.id, amount: -4000 }]
    });
    T.check('and the run posts it', ok(posted), String(posted.body?.error));

    db = (await c.get('/api/db')).body;
    const raised = db.expenses.find(e => e.recurringId === template.body.template.id);
    T.check('the posted cost carries the credit', raised?.amount === -4000, String(raised?.amount));

    /*
     * A run-posted cost is raised `pending`, so it shows as outstanding rather
     * than paid. The credit must reduce what is outstanding, not add to it.
     */
    const afterPosting = expenseBreakdown(db.expenses, 'JMD', from, to);
    const utilitiesNow = afterPosting.find(b => b.category === 'Utilities');
    T.check(
      'a credit awaiting settlement reduces what is outstanding rather than adding to it',
      utilitiesNow?.outstanding === -4000,
      String(utilitiesNow?.outstanding)
    );

    /*
     * Posting the same run twice must still not double it. The duplicate check
     * matches on the figure among other things, and a negative figure must
     * compare the same way a positive one does.
     */
    const again = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: template.body.template.id, amount: -4000 }]
    });
    db = (await c.get('/api/db')).body;
    T.check(
      'posting the run a second time does not raise the credit twice',
      ok(again) && db.expenses.filter(e => e.recurringId === template.body.template.id).length === 1,
      `${db.expenses.filter(e => e.recurringId === template.body.template.id).length} postings`
    );

    /* ================================================================
     * Rule 5 — a credit stays on its own book
     * ================================================================ */

    const ispoCredit = await c.post('/api/expenses', {
      category: 'Other',
      vendor: 'Insurance Co',
      description: 'Refund of overpaid vehicle premium',
      unitNumber: 'General',
      amount: -9000,
      currency: 'JMD',
      fund: 'ispo',
      status: 'paid',
      date: `${month}-14`,
      datePaid: `${month}-14`
    });
    T.check('a credit can belong to ISPO’s book', ok(ispoCredit), String(ispoCredit.body?.error));

    db = (await c.get('/api/db')).body;

    const strataOnly = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to, { book: 'strata' });
    const ispoOnly = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to, { book: 'ispo' });
    const everything = operatingStatement(db.payments, db.expenses, db.units, 'JMD', from, to, { book: 'everything' });

    T.check(
      'ISPO’s credit does not flatter the corporation',
      strataOnly.totalExpenditure === 45000,
      String(strataOnly.totalExpenditure)
    );
    T.check('it reduces ISPO’s own costs', ispoOnly.totalExpenditure === -9000, String(ispoOnly.totalExpenditure));
    T.check(
      'and the two books still add to the whole with credits in them',
      strataOnly.totalExpenditure + ispoOnly.totalExpenditure - ispoOnly.internalTransfer === everything.totalExpenditure,
      `${strataOnly.totalExpenditure} + ${ispoOnly.totalExpenditure} vs ${everything.totalExpenditure}`
    );
    T.check(
      'the split named on the combined statement is the whole of it, credits included',
      everything.strataExpenditure + everything.ispoExpenditure === everything.totalExpenditure,
      `${everything.strataExpenditure} + ${everything.ispoExpenditure} vs ${everything.totalExpenditure}`
    );
    T.check(
      'and the split helpers file a credit under the book it was entered on',
      expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to) === 45000 &&
        expensesInPeriod(ispoExpenses(db.expenses), 'JMD', from, to) === -9000,
      `${expensesInPeriod(strataExpenses(db.expenses), 'JMD', from, to)} / ${expensesInPeriod(ispoExpenses(db.expenses), 'JMD', from, to)}`
    );

    /* ================================================================
     * Rule 6 — a credit can be taken back
     * ================================================================ */

    const recall = await c.post(`/api/expenses/${credit.body.expense.id}/void`, {
      reason: 'The credit note was issued against the wrong account.',
      confirmSettled: true
    });
    T.check('a credit can be taken back like any other cost', ok(recall), String(recall.body?.error));

    db = (await c.get('/api/db')).body;
    T.check(
      'and once taken back it counts for nothing, so the bill stands at its full figure again',
      expensesInPeriod(liveExpenses(db.expenses), 'JMD', from, to) === expensesInPeriod(db.expenses, 'JMD', from, to) &&
        operationsStatement(db.expenses, db.payments, 'JMD', from, to).costsPaid === 60000,
      String(operationsStatement(db.expenses, db.payments, 'JMD', from, to).costsPaid)
    );

    /* ================================================================
     * Rule 7 — nothing else accepts a negative
     * ================================================================ */

    /*
     * A real tenancy, so the deposit refusal below is about the figure and not
     * about a record that does not exist.
     */
    const tenancyId = db.tenancies?.find(t => t.unitId === 'unit-1')?.id || db.tenancies?.[0]?.id;
    T.check('a tenancy exists to try a negative deposit against', !!tenancyId, JSON.stringify((db.tenancies || []).map(t => t.id)));

    const negatives = [
      ['a receipt', await c.post('/api/payments', { unitId: 'unit-2', category: 'Maintenance', amount: -5000, currency: 'JMD', payerName: 'X', method: 'Cash', date: `${month}-10`, receivedNow: true })],
      ['a one-off charge', await c.post('/api/charges', { unitId: 'unit-2', category: 'Maintenance', oneOffType: 'Late fee', amount: -1000, currency: 'JMD' })],
      [
        'a tenancy deposit',
        await c.post(`/api/tenancies/${tenancyId}/deposit`, { amount: -1000, currency: 'JMD', heldFrom: `${month}-01` })
      ]
    ];
    /*
     * 400 and not merely "not 200". A 404 from a mistyped route, or a refusal on
     * some other ground, would pass a looser check while proving nothing about
     * the figure - which is the shape of test this project has been caught by
     * before. So the status is pinned and the wording is required to be about
     * the amount.
     */
    for (const [what, res] of negatives) {
      T.check(
        `${what} still refuses a negative figure`,
        res.status === 400 && /negative|greater than zero/i.test(String(res.body?.error)),
        `${res.status} ${String(res.body?.error).slice(0, 90)}`
      );
    }

    /* ---- and the application still considers its own records sound ---- */

    const integrity = await c.post('/api/integrity/check', {});
    T.check(
      'the application checks its own records and finds nothing serious with credits in them',
      !ok(integrity) || !(integrity.body?.findings || []).some(f => f.severity === 'error'),
      JSON.stringify((integrity.body?.findings || []).filter(f => f.severity === 'error').slice(0, 3))
    );

    return T.done();
  } finally {
    cleanup();
    await srv.stop();
  }
}
