/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards added after the 2026-11-16 administration review, each with a positive
 * control. The tenancy, deposit, utility and work-order guards are asserted in
 * workflow-tenancy and workflow-records; this file holds what they do not.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday } from './harness.mjs';

export const title = 'Review fixes: one-off charges are not dated into a future month';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Wfx-1234567!', projectRoot });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Wfx-1234567!', 'WfxNew-98765!');
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 50000, monthlyMaintenance: 10000 });
    const today = localToday();
    const [y, m] = today.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-05` : `${y}-${String(m + 1).padStart(2, '0')}-05`;
    const lastMonth = m === 1 ? `${y - 1}-12-05` : `${y}-${String(m - 1).padStart(2, '0')}-05`;
    const base = { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 1000, currency: 'JMD', description: 'fee' };
    const count = async () => (await c.get('/api/db')).body.charges.filter(x => x.kind === 'one-off').length;

    const n0 = await count();
    const fut = await c.post('/api/charges', { ...base, dueDate: nextMonth });
    T.check('a one-off charge dated in next month is refused with a reason', fut.status === 400 && /future month/i.test(fut.body?.error || ''), `status ${fut.status}`);
    T.check('...and nothing was created', (await count()) === n0);
    const far = await c.post('/api/charges', { ...base, dueDate: '2099-01-01' });
    T.check('a charge dated years ahead is refused too', far.status === 400);

    const now = await c.post('/api/charges', { ...base, dueDate: today });
    T.check('control: a charge dated today is accepted', now.status === 200);
    const past = await c.post('/api/charges', { ...base, dueDate: lastMonth, description: 'opening balance' });
    T.check('control: a charge dated in a past month is accepted (opening balances and late invoices)', past.status === 200);
    const noDate = await c.post('/api/charges', { ...base });
    T.check('control: no date means today and is accepted', noDate.status === 200);
    T.check('the three accepted charges are the only ones created', (await count()) === n0 + 3);
    return T.done();
  } finally {
    await srv.stop();
  }
}
