/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The monthly costs run.
 *
 * Payroll, electricity, water and the security contract were re-typed by hand
 * every month. The templates make that a review rather than twenty acts of
 * transcription, and the two things that must hold are:
 *
 *   - a month posts once, however many times the button is pressed; and
 *   - what is posted is a bill raised, not money gone. A run that marked its
 *     lines paid would assert payments nobody made, and every one of them would
 *     flow straight into a proprietor's statement as a deduction from their rent.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Recurring expenses';

function lastMonth() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Recur-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Recur-1234!', 'RecurNew-9876!');
    const month = lastMonth();
    await makeLongTermUnit(c);

    /* ---------------- the templates ---------------- */

    const security = await c.post('/api/recurring-expenses', {
      category: 'Security',
      vendor: 'Guardsman Ltd',
      description: 'Overnight security detail',
      unitNumber: 'General',
      amount: 96000,
      currency: 'JMD',
      paymentMethod: 'Bank Transfer',
      dueDay: 5
    });
    T.check('a monthly cost can be set up', security.status === 200, String(security.body?.error || ''));
    T.check('and it starts active', security.body?.template?.active === true);

    const power = await c.post('/api/recurring-expenses', {
      category: 'Utilities',
      vendor: 'JPS',
      unitNumber: 'General',
      amount: 42000,
      currency: 'JMD',
      dueDay: 12
    });
    const payroll = await c.post('/api/recurring-expenses', {
      category: 'Payroll',
      vendor: 'Groundskeeper',
      unitNumber: 'General',
      amount: 60000,
      currency: 'JMD',
      dueDay: 28
    });
    T.check('so can the rest of them', power.status === 200 && payroll.status === 200);

    // A day that does not exist in February would move for four months of the
    // year, which reads as a data error rather than a decision.
    const badDay = await c.post('/api/recurring-expenses', {
      category: 'Other',
      vendor: 'Nobody',
      unitNumber: 'General',
      amount: 100,
      currency: 'JMD',
      dueDay: 31
    });
    T.check('a due day no month is guaranteed to have is refused', badDay.status === 400, `status ${badDay.status}`);

    /* ---------------- posting a month ---------------- */

    // Electricity is never the usual figure. The run carries what the poster
    // actually read off the bill, not what the template guessed.
    const posted = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [
        { recurringId: security.body.template.id },
        { recurringId: power.body.template.id, amount: 51350 },
        { recurringId: payroll.body.template.id, skip: true }
      ]
    });
    T.check('the month posts', posted.status === 200, String(posted.body?.error || ''));
    T.check('two lines were raised and the skipped one was not', posted.body?.created === 2, `${posted.body?.created} created`);

    let db = (await c.get('/api/db')).body;
    const raised = db.expenses.filter(e => e.periodMonth === month);
    T.check('both landed in the expense register', raised.length === 2, `${raised.length}`);
    T.check(
      'and every one of them is awaiting payment, not recorded as money already gone',
      raised.every(e => e.status === 'pending'),
      raised.map(e => e.status).join(',')
    );
    T.check(
      'the corrected amount was written, not the template default',
      raised.find(e => e.vendor === 'JPS')?.amount === 51350,
      String(raised.find(e => e.vendor === 'JPS')?.amount)
    );
    T.check(
      'each line is dated to the month it belongs to, not the day it was typed',
      raised.every(e => e.date.startsWith(month)),
      raised.map(e => e.date).join(',')
    );
    T.check(
      'and it carries the due day from its template',
      raised.find(e => e.vendor === 'Guardsman Ltd')?.dueDate === `${month}-05`,
      String(raised.find(e => e.vendor === 'Guardsman Ltd')?.dueDate)
    );
    T.check(
      'lineage back to the template is kept',
      raised.every(e => !!e.recurringId),
      raised.map(e => e.recurringId).join(',')
    );

    /* ---------------- posting it again ---------------- */

    // Two officers both work through the month-end list, or one presses the
    // button twice on a slow connection. Neither may double the property's costs.
    const again = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: security.body.template.id }, { recurringId: power.body.template.id, amount: 51350 }]
    });
    T.check('re-posting the month raises nothing', again.body?.created === 0, `${again.body?.created} created`);
    T.check('and says what it left alone', again.body?.skipped === 2, `${again.body?.skipped} skipped`);
    db = (await c.get('/api/db')).body;
    T.check('the register still holds two lines for the month', db.expenses.filter(e => e.periodMonth === month).length === 2);

    // The one that was skipped was never posted, so it is still available — a
    // skip is "not this month", not "already done".
    const catchUp = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: payroll.body.template.id, amount: 65000 }]
    });
    T.check('a line skipped earlier can still be posted afterwards', catchUp.body?.created === 1, `${catchUp.body?.created}`);

    /* ---------------- one-off items in the same run ---------------- */

    const withExtra = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [
        {
          category: 'Contractors',
          vendor: 'Gate Repair Co',
          description: 'Motor replaced on the main gate',
          unitNumber: 'General',
          amount: 34000,
          currency: 'JMD',
          paymentMethod: 'Cash',
          dueDay: 1
        }
      ]
    });
    T.check('something that only came up this month posts alongside the rest', withExtra.body?.created === 1, String(withExtra.body?.error || ''));

    db = (await c.get('/api/db')).body;
    const gate = db.expenses.find(e => e.vendor === 'Gate Repair Co');
    T.check('it is raised awaiting payment like everything else', gate?.status === 'pending', String(gate?.status));
    T.check('and it did not quietly become a template', db.recurringExpenses.length === 3, `${db.recurringExpenses.length}`);

    const extraTwice = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [
        {
          category: 'Contractors',
          vendor: 'Gate Repair Co',
          unitNumber: 'General',
          amount: 34000,
          currency: 'JMD',
          dueDay: 1
        }
      ]
    });
    T.check('the same one-off submitted twice is not doubled either', extraTwice.body?.created === 0, `${extraTwice.body?.created}`);

    /* ---------------- stopping one ---------------- */

    const stopped = await c.put(`/api/recurring-expenses/${payroll.body.template.id}`, {
      ...payroll.body.template,
      unitNumber: 'General',
      active: false
    });
    T.check('a cost can be stopped', stopped.body?.template?.active === false, String(stopped.body?.error || ''));
    db = (await c.get('/api/db')).body;
    T.check(
      'and stopping it leaves the costs it already raised on file',
      db.expenses.some(e => e.recurringId === payroll.body.template.id),
      'the raised expense disappeared'
    );

    /* ---------------- what a run is not allowed to do ---------------- */

    const future = new Date();
    const futureMonth = `${future.getFullYear() + 1}-01`;
    const ahead = await c.post('/api/expenses/post-month', { monthString: futureMonth, items: [] });
    T.check('a month that has not happened cannot be posted', ahead.status === 400, `status ${ahead.status}`);

    const nonsense = await c.post('/api/expenses/post-month', { monthString: 'whenever', items: [] });
    T.check('nor can a month that is not a month', nonsense.status === 400, `status ${nonsense.status}`);

    const ghost = await c.post('/api/expenses/post-month', {
      monthString: month,
      items: [{ recurringId: 'rex-does-not-exist' }]
    });
    T.check('a template deleted from under the screen is caught rather than skipped', ghost.status === 400, `status ${ghost.status}`);

    /* ---------------- settling one ---------------- */

    // The point of posting pending: the cost only counts against a proprietor
    // once the money has actually left, which happens through the ordinary form.
    const bill = db.expenses.find(e => e.vendor === 'Guardsman Ltd' && e.periodMonth === month);
    const settled = await c.put(`/api/expenses/${bill.id}`, {
      ...bill,
      unitNumber: 'General',
      status: 'paid',
      datePaid: `${month}-06`,
      paymentMethod: 'Bank Transfer'
    });
    T.check('a raised cost is settled through the expense register', settled.body?.expense?.status === 'paid', String(settled.body?.error || ''));
    T.check(
      'and settling it does not lose which monthly cost it came from',
      settled.body?.expense?.recurringId === security.body.template.id,
      String(settled.body?.expense?.recurringId)
    );
    T.check(
      'nor which month it was raised for',
      settled.body?.expense?.periodMonth === month,
      String(settled.body?.expense?.periodMonth)
    );
  } finally {
    await srv.stop();
  }

  return T.done();
}
