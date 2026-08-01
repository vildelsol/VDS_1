/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maintenance requests as work, not notes.
 *
 * The thing that matters is that a reported problem can be chased to an end and
 * costed — and that the cost reaches the accounts exactly once, rather than being
 * typed twice or not at all.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Maintenance work orders';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Work-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Work-1234!', 'WorkNew-9876!');
    await makeLongTermUnit(c);

    const logActivity = (activityType, notes, extra = {}) =>
      c.post('/api/unit-activities', {
        unitId: 'unit-1',
        residentName: 'Tenant',
        residentRole: 'Tenant',
        activityType,
        dateCaptured: '2026-07-10',
        notes,
        ...extra
      });

    // --- a request starts as work; other activity does not ---
    const req1 = await logActivity('Maintenance Request', 'Kitchen tap dripping.');
    T.check('a maintenance request opens as Reported', req1.body?.activity?.workStatus === 'Reported', req1.body?.activity?.workStatus);

    const notice = await logActivity('Noise / Event Notice', 'Party on Saturday.');
    T.check('other activity is not turned into a work order', notice.body?.activity?.workStatus === undefined, String(notice.body?.activity?.workStatus));
    const rejected = await c.put(`/api/unit-activities/${notice.body.activity.id}`, { workStatus: 'Scheduled' });
    T.check('and cannot be progressed as one', rejected.status === 400, `status ${rejected.status}`);

    const id = req1.body.activity.id;

    // --- it can be assigned and moved along ---
    const assigned = await c.put(`/api/unit-activities/${id}`, { workStatus: 'Scheduled', assignedTo: 'Jamaica Plumbers Ltd' });
    T.check('it can be assigned to a contractor', assigned.body?.activity?.assignedTo === 'Jamaica Plumbers Ltd');
    T.check('and scheduled', assigned.body?.activity?.workStatus === 'Scheduled');
    T.check('an open request carries no completion date', !assigned.body?.activity?.completedOn);

    const bogus = await c.put(`/api/unit-activities/${id}`, { workStatus: 'Teleported' });
    T.check('an unknown status is refused', bogus.status === 400, `status ${bogus.status}`);

    // --- closing it records how it ended ---
    const done = await c.put(`/api/unit-activities/${id}`, {
      workStatus: 'Completed',
      completedOn: '2026-07-14',
      outcome: 'Replaced the washer.',
      costAmount: 4500,
      costCurrency: 'JMD'
    });
    T.check('completing it records the date', done.body?.activity?.completedOn === '2026-07-14');
    T.check('and how it was resolved', /washer/i.test(done.body?.activity?.outcome || ''));
    T.check('and what it cost', done.body?.activity?.costAmount === 4500);
    T.check('the cost is not an expense until it is raised', done.body?.expense == null);

    let db = (await c.get('/api/db')).body;
    T.check('so the expense register is still empty', db.expenses.length === 0, `${db.expenses.length} expenses`);

    // --- raising the expense puts the cost in the accounts, exactly once ---
    const raised = await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
    T.check('the cost can be raised as a property expense', !!raised.body?.expense, JSON.stringify(raised.body?.expense || null).slice(0, 60));
    T.check('allocated to the villa it was spent on', raised.body?.expense?.unitId === 'unit-1');
    T.check('for the amount recorded on the request', raised.body?.expense?.amount === 4500);
    T.check('naming the contractor as the vendor', raised.body?.expense?.vendor === 'Jamaica Plumbers Ltd');

    const again = await c.put(`/api/unit-activities/${id}`, { raiseExpense: true });
    T.check('asking twice does not raise it twice', again.body?.expense == null);
    db = (await c.get('/api/db')).body;
    T.check('and the register holds exactly one', db.expenses.length === 1, `${db.expenses.length} expenses`);

    // --- reopening clears the completion date, so it cannot read as both ---
    const reopened = await c.put(`/api/unit-activities/${id}`, { workStatus: 'In progress' });
    T.check('reopening clears the completion date', !reopened.body?.activity?.completedOn);
    T.check('but keeps the cost already recorded', reopened.body?.activity?.costAmount === 4500);

    // --- cancelling is a close, with a reason ---
    const cancelled = await c.put(`/api/unit-activities/${id}`, { workStatus: 'Cancelled', outcome: 'Tenant fixed it themselves.' });
    T.check('cancelling closes it with a date', !!cancelled.body?.activity?.completedOn);

    // --- and every step is on the record ---
    db = (await c.get('/api/db')).body;
    T.check(
      'progress is written to the audit trail',
      db.auditLogs.filter(a => /maintenance request/i.test(a.action)).length >= 3,
      `${db.auditLogs.filter(a => /maintenance request/i.test(a.action)).length} entries`
    );
  } finally {
    await srv.stop();
  }
  return T.done();
}
