/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two gaps found by redteam-pm-10000 on 2026-11-13: a due day outside 1-31 was
 * clamped and stored with a success response, and a negative rent was accepted on
 * a villa where rent does not apply. Both must now be refused and leave the
 * record untouched. Every refusal is paired with a positive control.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Unit register refuses impossible due days and negative rent';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const PW = 'UnitVal-1234!';
  const srv = await startServer({ port, adminPassword: PW, projectRoot });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, PW, PW + 'x');
    const base = { number: '1', ownerName: 'O', tenantName: 'T', tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 5, maintDueDay: 6 };
    const get = async () => (await c.get('/api/db')).body.units.find(u => u.id === 'unit-1');
    T.check('control: a normal unit saves', (await c.put('/api/units/unit-1', base)).status === 200);

    for (const [field, label] of [['rentDueDay', 'rent'], ['maintDueDay', 'maintenance']]) {
      for (const bad of [45, 0, -3, 32, 2.5, 'abc', 'x1']) {
        const r = await c.put('/api/units/unit-1', { ...base, [field]: bad });
        const u = await get();
        T.check(`${label} due day ${JSON.stringify(bad)} is refused`, r.status === 400, `status ${r.status}`);
        T.check(`...and the stored ${label} due day is unchanged`, u[field] === base[field], `stored ${u[field]}`);
      }
      for (const good of [1, 28, 29, 30, 31, '15']) {
        const r = await c.put('/api/units/unit-1', { ...base, [field]: good });
        T.check(`control: ${label} due day ${JSON.stringify(good)} is accepted`, r.status === 200, `status ${r.status}`);
      }
      await c.put('/api/units/unit-1', base);
    }
    const omitted = await c.put('/api/units/unit-1', { ...base, rentDueDay: undefined, maintDueDay: undefined });
    T.check('control: leaving the due days out keeps what was there', omitted.status === 200 && (await get()).rentDueDay === 5);

    // Negative rent on a villa where rent does not apply.
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Own', status: 'owner-occupied', monthlyMaintenance: 9000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    const u2 = (await c.get('/api/db')).body.units.find(u => u.id === 'unit-2');
    for (const status of ['owner-occupied', 'unavailable']) {
      const r = await c.put('/api/units/unit-2', { ...u2, status, monthlyRent: -1 });
      T.check(`negative rent is refused on a ${status} villa`, r.status === 400, `status ${r.status}`);
    }
    const ok = await c.put('/api/units/unit-2', { ...u2, monthlyRent: 0 });
    T.check('control: zero rent on an owner-occupied villa is accepted', ok.status === 200, `status ${ok.status}`);
    const neg = await c.put('/api/units/unit-1', { ...base, monthlyRent: -1 });
    T.check('control: negative rent on a let villa is still refused', neg.status === 400);
    return T.done();
  } finally {
    await srv.stop();
  }
}
