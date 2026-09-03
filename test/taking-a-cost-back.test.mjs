/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Taking a cost back.
 *
 * Ro, 2026-09-03, working on the live records: *"when the line items are posted
 * under monthly costs, there is no option to completely remove that item from the
 * system. When the expenses are posted, there is no option to recall the posting
 * in the event an error was made. Those are real operational gaps as errors do
 * happen."*
 *
 * He is right, and the second gap was the worse of the two: posting a month
 * raised up to twenty costs in one action and nothing could take them back, so a
 * run posted for the wrong month, or twice, or off the wrong invoice, stayed in
 * the operating statement, the proprietors' reports and the annual accounts
 * forever.
 *
 * This file is written the way Ro states the rules, not the way the code names
 * its functions — because a test named after a function only proves the function
 * is self-consistent, and that is exactly how five faults survived 1,575 passing
 * tests on 2026-09-02. The rules being asserted:
 *
 *   1. A monthly cost added by mistake can be taken out of the system entirely,
 *      not merely stopped.
 *   2. One whose costs are still on the books cannot — it says which months, and
 *      what to do about them.
 *   3. A month posted in error comes back in one action, the way it went in.
 *   4. **A cost taken back is counted by nothing.** Every figure returns to
 *      exactly what it was before the posting — not approximately, exactly.
 *   5. It is not deleted. The register still shows it, with who took it back and
 *      why.
 *   6. A month taken back can be posted again.
 *   7. A cost the books say was *paid* is not taken back on the first ask.
 *   8. The person who takes money is not the person who erases the record of it.
 *
 * Rule 4 is asserted by comparing the reports to themselves — the same reports,
 * over the same period, before the posting and after the recall. A figure that
 * quietly kept a recalled cost would show up as a difference, wherever it lived.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Taking a cost back';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-void-'));
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

/** A month safely in the past, so posting it is allowed. */
function lastMonth() {
  const now = new Date();
  const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Recall-1234!', projectRoot });
  const T = reporter(title);
  const { mod: fin, cleanup } = await loadFinance(projectRoot);
  const {
    operatingStatement,
    operationsStatement,
    monthlyOwnersReport,
    annualOwnersReport,
    ownerStatements,
    expensesInPeriod,
    expenseBreakdown,
    form13CDebts,
    liveExpenses
  } = fin;

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Recall-1234!', 'RecallNew-9876!');

    const month = lastMonth();
    const from = `${month}-01`;
    const to = `${month}-28`;
    const year = Number(month.substring(0, 4));

    await makeLongTermUnit(c);

    /*
     * Money in, so the reports have something on the income side and the
     * comparison is between two live statements rather than two empty ones. An
     * assertion over nothing is a statement about nothing.
     */
    await c.post('/api/charges/post-month', { monthString: month });
    await recordAndConfirmPayment(c, {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 40000,
      currency: 'JMD',
      payerName: 'Owner One',
      method: 'Bank Transfer',
      date: `${month}-04`
    });

    /**
     * Every figure the property looks at, in one object, so the whole set can be
     * compared in one line. If a recalled cost is still counted anywhere in here,
     * the comparison fails and names the report.
     */
    const everyFigure = db => {
      const { units, charges, payments, expenses, utilities } = db;
      const out = {};
      for (const currency of ['JMD', 'USD']) {
        const op = operatingStatement(payments, expenses, units, currency, from, to);
        const ops = operationsStatement(expenses, payments, currency, from, to);
        const monthly = monthlyOwnersReport(units, charges, payments, expenses, currency, month);
        const annual = annualOwnersReport(units, charges, payments, expenses, currency, year, {});
        out[currency] = {
          expensesPaid: expensesInPeriod(expenses, currency, from, to),
          breakdown: expenseBreakdown(expenses, currency, from, to),
          operatingExpenditure: op.totalExpenditure,
          operatingSurplus: op.surplus,
          opsCostsPaid: ops.costsPaid,
          opsCostsUnpaid: ops.costsUnpaid,
          opsSurplus: ops.surplus,
          opsGroups: ops.groups.map(g => ({ category: g.category, total: g.total })),
          opsVillaRecharged: ops.villaRecharged,
          monthlyCostsPaid: monthly.costsPaid,
          monthlyUnpaid: monthly.unpaidAtMonthEnd,
          monthlyUnpaidCount: monthly.unpaidCount,
          monthlySurplus: monthly.surplus,
          monthlyCategories: monthly.categories,
          annualExpenditure: annual.expenditure,
          annualCommunityPosition: annual.annualCommunityPosition,
          annualCategories: (annual.categories || []).map(r => ({ category: r.category, actual: r.actual })),
          ageing: form13CDebts(expenses, `${month}-28`).totalsByCurrency,
          ownerStatements: ownerStatements(units, charges, payments, expenses, utilities, from, to).map(s => ({
            unit: s.unit.number,
            currency: s.currency,
            expenses: s.expenses,
            net: s.net
          }))
        };
      }
      return out;
    };

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /*
     * A cost typed in by hand, standing in the same month as the run that is
     * about to be posted. It is part of the baseline on purpose: a recall must
     * leave it exactly where it is, and the way to prove that is for the figures
     * to come back to a baseline that includes it.
     */
    const byHand = await c.post('/api/expenses', {
      category: 'Supplies',
      vendor: 'Hardware Depot',
      description: 'Pool chemicals',
      unitNumber: 'General',
      amount: 7400,
      currency: 'JMD',
      status: 'paid',
      date: `${month}-15`,
      datePaid: `${month}-15`
    });
    T.check('a cost logged by hand is recorded', byHand.status === 200, String(byHand.body?.error || ''));

    let db = (await c.get('/api/db')).body;
    const before = everyFigure(db);
    T.check(
      'the baseline is a real set of figures, not an empty one',
      before.JMD.expensesPaid === 7400 && before.JMD.monthlyCostsPaid === 7400,
      JSON.stringify({ paid: before.JMD.expensesPaid, monthly: before.JMD.monthlyCostsPaid })
    );

    /* ================================================================
     * Rule 1 — a monthly cost added by mistake goes away completely
     * ================================================================ */

    const typo = await c.post('/api/recurring-expenses', {
      category: 'Other',
      vendor: 'Typed By Mistake Ltd',
      unitNumber: 'General',
      amount: 999,
      currency: 'JMD',
      dueDay: 3
    });
    T.check('a monthly cost can be set up', typo.status === 200, String(typo.body?.error || ''));

    const gone = await c.del(`/api/recurring-expenses/${typo.body.template.id}`);
    T.check('and one that never raised anything can be removed outright', gone.status === 200, String(gone.body?.error || ''));

    db = (await c.get('/api/db')).body;
    T.check(
      'it is out of the system, not sitting there greyed out',
      !db.recurringExpenses.some(t => t.id === typo.body.template.id),
      'the template survived the delete'
    );
    T.check(
      'and removing it is on the record',
      db.auditLogs.some(a => a.recordType === 'RecurringExpense' && /Removed the monthly cost/.test(a.action)),
      'no audit entry for the removal'
    );
    T.check('nothing else moved', same(before, everyFigure(db)), 'a figure changed when an unused template was deleted');

    /* ================================================================
     * Set up a real month's run
     * ================================================================ */

    const security = (
      await c.post('/api/recurring-expenses', {
        category: 'Security',
        vendor: 'Guardsman Ltd',
        unitNumber: 'General',
        amount: 96000,
        currency: 'JMD',
        dueDay: 5
      })
    ).body.template;

    const power = (
      await c.post('/api/recurring-expenses', {
        category: 'Utilities',
        vendor: 'JPS',
        unitNumber: 'General',
        amount: 42000,
        currency: 'JMD',
        dueDay: 12
      })
    ).body.template;

    // A cost against one villa, so the recharged side of the reports is exercised
    // too — it is the figure that reconciles the operations statement to the
    // register, and it must move with the rest.
    const plumber = (
      await c.post('/api/recurring-expenses', {
        category: 'Maintenance',
        vendor: 'Ocho Plumbing',
        unitId: 'unit-1',
        amount: 18000,
        currency: 'JMD',
        dueDay: 8
      })
    ).body.template;

    const posted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: security.id }, { recurringId: power.id, amount: 51350 }, { recurringId: plumber.id }]
    });
    T.check('the month posts', posted.body?.created === 3, String(posted.body?.error || posted.body?.created));

    db = (await c.get('/api/db')).body;
    const afterPosting = everyFigure(db);
    T.check(
      'and the posting genuinely moved the figures — otherwise this test proves nothing',
      !same(before, afterPosting),
      'posting three costs changed no figure anywhere'
    );

    /* ================================================================
     * Rule 2 — a monthly cost with costs on the books cannot be removed
     * ================================================================ */

    const inUse = await c.del(`/api/recurring-expenses/${security.id}`);
    T.check('a monthly cost still carrying posted costs is not removed', inUse.status === 400, `status ${inUse.status}`);
    T.check('the refusal is machine-readable', inUse.body?.code === 'monthly-cost-has-postings', String(inUse.body?.code));
    T.check(
      'and it names the month, so the person knows what to take back',
      String(inUse.body?.error || '').includes(month),
      String(inUse.body?.error || '')
    );
    db = (await c.get('/api/db')).body;
    T.check(
      'the template is still there and so are its costs',
      db.recurringExpenses.some(t => t.id === security.id) && db.expenses.some(e => e.recurringId === security.id),
      'the refused delete removed something anyway'
    );

    /* ================================================================
     * Rule 3 and 4 — the month comes back in one action, and is then
     * counted by nothing
     * ================================================================ */

    const recalled = await c.post('/api/expenses/recall-month', {
      monthString: month,
      reason: 'Posted against the wrong month at the desk'
    });
    T.check('a posted month can be taken back in one action', recalled.status === 200, String(recalled.body?.error || ''));
    T.check('and it takes back the whole run', recalled.body?.recalled === 3, `${recalled.body?.recalled} taken back`);

    db = (await c.get('/api/db')).body;
    const afterRecall = everyFigure(db);

    // The rule, stated the only way that can fail honestly: every figure, in both
    // currencies, is back to what it was before the run was ever posted.
    T.check(
      'a cost taken back is counted by nothing — every figure is back where it started',
      same(before, afterRecall),
      `JMD before: ${JSON.stringify(before.JMD)}\nJMD after:  ${JSON.stringify(afterRecall.JMD)}`
    );

    // And the one thing that must NOT have gone back: the cost somebody typed in
    // by hand is untouched.
    const hand = db.expenses.find(e => e.vendor === 'Hardware Depot');
    T.check('a cost logged by hand in the same month is left alone', hand?.status === 'paid', String(hand?.status));
    T.check(
      'so the register still holds it',
      liveExpenses(db.expenses).some(e => e.vendor === 'Hardware Depot'),
      'the recall swept up a hand-entered cost'
    );

    /* ================================================================
     * Rule 5 — taken back is not deleted
     * ================================================================ */

    const takenBack = db.expenses.filter(e => e.periodMonth === month);
    T.check('the lines are still on file', takenBack.length === 3, `${takenBack.length} rows remain`);
    T.check('each one is marked as taken back', takenBack.every(e => e.status === 'void'), takenBack.map(e => e.status).join(','));
    T.check(
      'with who did it, when, and why, on every one',
      takenBack.every(e => !!e.voidedBy && !!e.voidedAt && e.voidReason === 'Posted against the wrong month at the desk'),
      JSON.stringify(takenBack.map(e => ({ by: e.voidedBy, at: e.voidedAt, why: e.voidReason })))
    );
    T.check(
      'the amounts are untouched, so the record still says what was raised',
      takenBack.find(e => e.vendor === 'JPS')?.amount === 51350,
      String(takenBack.find(e => e.vendor === 'JPS')?.amount)
    );
    T.check(
      'and the recall is in the audit trail as one act',
      db.auditLogs.some(a => new RegExp(`Recalled the monthly costs posted for ${month}`).test(a.action)),
      'no audit entry for the recall'
    );

    /* ================================================================
     * Rule 6 — a month taken back can be posted again
     * ================================================================ */

    const reposted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: security.id }, { recurringId: power.id, amount: 48900 }, { recurringId: plumber.id }]
    });
    T.check('the month posts again after being taken back', reposted.body?.created === 3, String(reposted.body?.error || reposted.body?.created));
    T.check('and nothing was skipped as "already posted"', reposted.body?.skipped === 0, `${reposted.body?.skipped} skipped`);

    db = (await c.get('/api/db')).body;
    T.check(
      'the corrected figure is the one that counts now, not the recalled one',
      liveExpenses(db.expenses).find(e => e.vendor === 'JPS')?.amount === 48900,
      String(liveExpenses(db.expenses).find(e => e.vendor === 'JPS')?.amount)
    );
    T.check(
      'and only one JPS cost counts for the month, not two',
      liveExpenses(db.expenses).filter(e => e.vendor === 'JPS' && e.periodMonth === month).length === 1,
      String(liveExpenses(db.expenses).filter(e => e.vendor === 'JPS' && e.periodMonth === month).length)
    );

    const check = await c.get('/api/integrity');
    const findings = check.body?.findings || [];
    T.check('the self-check ran', check.status === 200 && Array.isArray(findings), String(check.status));
    T.check(
      'and the self-check does not report the remedy as a double posting',
      !findings.some(f => f.code === 'monthly-cost-posted-twice'),
      JSON.stringify(findings.filter(f => f.code === 'monthly-cost-posted-twice'))
    );
    T.check(
      'nor a taken-back cost as missing its reason',
      !findings.some(f => f.code === 'void-cost-without-a-reason'),
      JSON.stringify(findings.filter(f => f.code === 'void-cost-without-a-reason'))
    );

    /* ================================================================
     * The cost charged to a villa, settled — so the figures that reach a
     * proprietor's own statement are in the comparison too
     * ================================================================ */

    /*
     * Until this point the villa-allocated cost had only ever been pending, and a
     * proprietor's statement counts paid costs only — so that arm of the
     * comparison was 0 against 0, which proves nothing. Settling it puts a real
     * figure on Villa 1's statement and into the recharged total that reconciles
     * the operations statement to the register.
     */
    const villaCost = db.expenses.find(e => e.vendor === 'Ocho Plumbing' && e.status === 'pending');
    await c.put(`/api/expenses/${villaCost.id}`, {
      ...villaCost,
      unitId: 'unit-1',
      status: 'paid',
      datePaid: `${month}-09`
    });
    db = (await c.get('/api/db')).body;
    const withVillaCost = everyFigure(db);
    T.check(
      'a settled cost charged to a villa reaches that proprietor’s own statement',
      withVillaCost.JMD.ownerStatements.find(s => s.unit === '1' && s.currency === 'JMD')?.expenses === 18000,
      JSON.stringify(withVillaCost.JMD.ownerStatements)
    );
    T.check(
      'and it is carried as recharged, not as a common cost of the fund',
      withVillaCost.JMD.opsVillaRecharged === 18000 &&
        !withVillaCost.JMD.opsGroups.some(g => g.category === 'Maintenance'),
      JSON.stringify({ recharged: withVillaCost.JMD.opsVillaRecharged, groups: withVillaCost.JMD.opsGroups })
    );

    /* ================================================================
     * Rule 7 — a cost the books say was paid is not taken back on the
     * first ask
     * ================================================================ */

    const bill = db.expenses.find(e => e.vendor === 'Guardsman Ltd' && e.status === 'pending');
    await c.put(`/api/expenses/${bill.id}`, {
      ...bill,
      unitNumber: 'General',
      status: 'paid',
      datePaid: `${month}-06`
    });

    const firstAsk = await c.post(`/api/expenses/${bill.id}/void`, { reason: 'Never actually paid — entered in error' });
    T.check('taking back a cost the books call paid is refused first time', firstAsk.status === 400, `status ${firstAsk.status}`);
    T.check('with the code the screen acts on', firstAsk.body?.code === 'expense-already-settled', String(firstAsk.body?.code));
    T.check(
      'and it says what would leave the books',
      /operating statement/i.test(String(firstAsk.body?.error || '')),
      String(firstAsk.body?.error || '')
    );
    db = (await c.get('/api/db')).body;
    T.check(
      'nothing happened on the refusal',
      db.expenses.find(e => e.id === bill.id)?.status === 'paid',
      String(db.expenses.find(e => e.id === bill.id)?.status)
    );

    const secondAsk = await c.post(`/api/expenses/${bill.id}/void`, {
      reason: 'Never actually paid — entered in error',
      confirmSettled: true
    });
    T.check('confirmed, it goes back', secondAsk.status === 200, String(secondAsk.body?.error || ''));
    db = (await c.get('/api/db')).body;
    const settledVoid = db.expenses.find(e => e.id === bill.id);
    T.check('and it is marked as having been settled when it was taken back', settledVoid?.voidedFromPaid === true, JSON.stringify(settledVoid));
    T.check(
      'a cost taken back cannot then be edited back into a live one',
      (await c.put(`/api/expenses/${bill.id}`, { ...settledVoid, unitNumber: 'General', status: 'pending' })).status === 400,
      'a voided cost was editable'
    );
    T.check(
      'and it cannot be taken back twice',
      (await c.post(`/api/expenses/${bill.id}/void`, { reason: 'Trying again for no reason' })).status === 400,
      'a voided cost was voided again'
    );

    /* ---------------- a reason is not optional ---------------- */

    const other = db.expenses.find(e => e.status === 'pending');
    T.check(
      'no reason, no void',
      (await c.post(`/api/expenses/${other.id}/void`, {})).status === 400,
      'a cost was taken back with no reason given'
    );
    T.check(
      'and "x" is not a reason',
      (await c.post(`/api/expenses/${other.id}/void`, { reason: 'x' })).status === 400,
      'a one-character reason was accepted'
    );

    /* ---------------- a month with nothing to take back ---------------- */

    T.check(
      'a month that has nothing posted has nothing to take back, and says so',
      (await c.post('/api/expenses/recall-month', { monthString: '2019-04', reason: 'Nothing there at all' })).status === 404,
      'recalling an empty month reported success'
    );
    T.check(
      'and a month that is not a month is refused',
      (await c.post('/api/expenses/recall-month', { monthString: 'whenever', reason: 'Nonsense month' })).status === 400,
      'a malformed month was accepted'
    );

    /* ================================================================
     * Rule 8 — the person who takes the money does not erase it
     * ================================================================ */

    await c.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    T.check(
      'the junior is signed in, so a refusal below is about authority and not about the session',
      (await jr.get('/api/db')).body?.currentUser?.role === 'JUNIOR_OFFICER',
      String((await jr.get('/api/db')).body?.currentUser?.role)
    );

    // Valid in every other respect, so the only thing that can refuse it is the
    // permission — a request refused on validation tests nothing about authority.
    const live = (await c.get('/api/db')).body.expenses.find(e => e.status === 'pending');
    T.check('there is a live cost to try this on', !!live, 'no pending cost left to test the permission with');
    T.check(
      'a junior officer cannot take a cost back',
      (await jr.post(`/api/expenses/${live.id}/void`, { reason: 'Should never be written' })).status === 403,
      'a junior took a cost off the books'
    );
    T.check(
      'nor recall a whole month',
      (await jr.post('/api/expenses/recall-month', { monthString: month, reason: 'Should never be written' })).status === 403,
      'a junior recalled a month'
    );
    T.check(
      'nor remove a monthly cost from the system',
      (await jr.del(`/api/recurring-expenses/${power.id}`)).status === 403,
      'a junior deleted a monthly cost'
    );
    T.check(
      'and the cost is untouched after all three',
      (await c.get('/api/db')).body.expenses.find(e => e.id === live.id)?.status === 'pending',
      'a refused request changed something'
    );

    /* ================================================================
     * The way out that Ro asked for, end to end: take the postings back,
     * then the template itself goes
     * ================================================================ */

    const recallAgain = await c.post('/api/expenses/recall-month', {
      monthString: month,
      reason: 'Clearing the month to remove the cost entirely',
      includeSettled: true
    });
    T.check('the month can be cleared again, settled lines included', recallAgain.status === 200, String(recallAgain.body?.error || ''));

    const nowRemovable = await c.del(`/api/recurring-expenses/${power.id}`);
    T.check(
      'and with nothing of its own left on the books, the monthly cost can be removed',
      nowRemovable.status === 200,
      String(nowRemovable.body?.error || '')
    );
    db = (await c.get('/api/db')).body;
    T.check(
      'the template is gone',
      !db.recurringExpenses.some(t => t.id === power.id),
      'the template survived'
    );
    T.check(
      'its taken-back costs stay on file, still readable without it',
      db.expenses.filter(e => e.recurringId === power.id).every(e => e.status === 'void' && e.vendor === 'JPS'),
      JSON.stringify(db.expenses.filter(e => e.recurringId === power.id).map(e => ({ s: e.status, v: e.vendor })))
    );

    // And the whole point of all of it: with everything taken back, the books
    // read as though the mistake never happened.
    const atTheEnd = everyFigure(db);
    T.check(
      'the proprietor’s statement no longer carries the cost that was taken back',
      atTheEnd.JMD.ownerStatements.find(s => s.unit === '1' && s.currency === 'JMD')?.expenses === 0,
      JSON.stringify(atTheEnd.JMD.ownerStatements)
    );
    T.check(
      'with the run and the settled lines all taken back, every figure is where it started',
      same(before, atTheEnd),
      `JMD before: ${JSON.stringify(before.JMD)}\nJMD now:    ${JSON.stringify(everyFigure(db).JMD)}`
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
