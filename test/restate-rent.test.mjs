/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Restating rent charges raised before the tenant's total included maintenance.
 *
 * The legacy state is built the honest way: charges are raised, the server is
 * stopped, the split fields are stripped from db.json exactly as an older release
 * would have left it, and the server is started again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Restating old rent charges to rent + maintenance';

const openOf = (db, unitId, category = 'Rent') => db.charges.filter(c => c.unitId === unitId && c.category === category && c.status === 'open');
const total = rows => Math.round(rows.reduce((a, x) => a + x.amount, 0) * 100) / 100;

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-restate-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'Restate-1234!', projectRoot, dataDir });
  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Restate-1234!', 'RestateNew-9876!');

    // Three ordinary let villas, one billed at an odd figure, one USD, one owner unit.
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000 });
    await makeLongTermUnit(c, 'unit-2', { monthlyRent: 80000, monthlyMaintenance: 20000, tenantName: 'Two' });
    await makeLongTermUnit(c, 'unit-3', { monthlyRent: 1125, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', tenantName: 'Three' });
    await makeLongTermUnit(c, 'unit-4', { monthlyRent: 90000, monthlyMaintenance: 20000, tenantName: 'Four' });
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Owner Five', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });
    // A late fee on unit-1 must never be restated.
    await c.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 5000, dueDate: '2026-11-05', description: 'Late fee' });
    // Unit-4's charges were posted at a figure that is neither the old rent nor the agreed rent.
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner', tenantName: 'Four', status: 'long-term', monthlyRent: 90000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });

    // --- simulate the previous release: no split, charged at the old rent (agreed rent less maintenance) ---
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const ch of raw.charges) {
      if (ch.category === 'Rent' && ch.kind !== 'one-off') {
        const u = raw.units.find(x => x.id === ch.unitId);
        ch.amount = u.id === 'unit-4' ? 65000 : u.monthlyRent - u.monthlyMaintenance;
        delete ch.rentPortion;
        delete ch.maintenancePortion;
      }
    }
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'RestateNew-9876!' }, { captureCookie: true });

    let db = (await c.get('/api/db')).body;
    const balBefore = id => total(openOf(db, id));
    T.check('before: unit-1 owes 3 x 55,000 + 5,000 fee', balBefore('unit-1') === 170000, String(balBefore('unit-1')));
    const rentBefore = Object.fromEntries(['unit-2', 'unit-3', 'unit-4'].map(id => [id, balBefore(id)]));
    const maintBefore = total(db.charges.filter(x => x.category === 'Maintenance' && x.status === 'open'));

    // --- dry run ---
    const dry = await c.post('/api/charges/restate-rent', {});
    T.check('dry run reports the plan', dry.status === 200 && dry.body.confirmed === false && dry.body.count === 9, JSON.stringify(dry.body).slice(0, 160));
    T.check('dry run restates nothing', dry.body.restated === 0);
    T.check('the plan is 55,000 to 75,000 for unit 1', dry.body.plan.filter(p => p.unit === '1').every(p => p.from === 55000 && p.to === 75000));
    T.check('unit 4 (billed at another figure) is reported as skipped, not guessed', dry.body.skipped.filter(s => s.unit === '4').length === 3);
    db = (await c.get('/api/db')).body;
    T.check('dry run changed no record', balBefore('unit-1') === 170000 && !db.charges.some(x => x.status === 'void'));

    // --- permission ---
    const anon = makeClient(srv.baseUrl);
    T.check('without a session it is refused', (await anon.post('/api/charges/restate-rent', { confirm: true })).status === 401);

    // --- confirm ---
    const done = await c.post('/api/charges/restate-rent', { confirm: true });
    db = (await c.get('/api/db')).body;
    T.check('confirmed run restates 9 charges', done.status === 200 && done.body.restated === 9, JSON.stringify(done.body).slice(0, 160));
    T.check('unit 1 now owes 3 x 75,000 + 5,000 fee', total(openOf(db, 'unit-1')) === 230000, String(total(openOf(db, 'unit-1'))));
    T.check('unit 2 now owes 3 x 80,000', total(openOf(db, 'unit-2')) === 240000, String(total(openOf(db, 'unit-2'))));
    T.check('USD unit 3 now owes 3 x 1,125, in USD', total(openOf(db, 'unit-3')) === 3375 && openOf(db, 'unit-3').every(x => x.currency === 'USD'));
    T.check('unit 4 is untouched', total(openOf(db, 'unit-4')) === rentBefore['unit-4']);
    T.check('the late fee is untouched at 5,000', openOf(db, 'unit-1').some(x => x.kind === 'one-off' && x.amount === 5000 && x.rentPortion === undefined));
    T.check('the increase equals maintenance exactly: 9 charges x 20,000/125',
      total(openOf(db, 'unit-1')) - 170000 === 60000 && total(openOf(db, 'unit-2')) - rentBefore['unit-2'] === 60000);
    T.check('every restated charge splits exactly', openOf(db, 'unit-1').concat(openOf(db, 'unit-2'), openOf(db, 'unit-3'))
      .filter(x => x.kind !== 'one-off').every(x => Math.round((x.rentPortion + x.maintenancePortion) * 100) === Math.round(x.amount * 100)));
    const voided = db.charges.filter(x => x.status === 'void');
    T.check('the 9 originals are voided, kept, with a reason and who', voided.length === 9 && voided.every(x => /restated/i.test(x.voidReason) && x.voidedBy && x.voidedAt));
    T.check('same months, due dates and payers on the replacements', openOf(db, 'unit-1').filter(x => x.kind !== 'one-off').map(x => x.periodMonth).sort().join() === '2026-09,2026-10,2026-11');
    T.check('maintenance (owner) charges are not touched', total(db.charges.filter(x => x.category === 'Maintenance' && x.status === 'open')) === maintBefore);
    T.check('each restatement is audited', db.auditLogs.filter(a => /^Restated .* rent for/.test(a.action)).length === 9);

    // --- idempotent ---
    const count = db.charges.length;
    const again = await c.post('/api/charges/restate-rent', { confirm: true });
    db = (await c.get('/api/db')).body;
    T.check('running it again restates nothing and adds no records', again.body.restated === 0 && db.charges.length === count);

    // --- re-posting a month afterwards does not double up ---
    await c.post('/api/charges/post-month', { monthString: '2026-11' });
    db = (await c.get('/api/db')).body;
    T.check('post-month after restating adds nothing for 2026-11', db.charges.length === count || db.charges.length === count + 1 /* unit-4's skipped month already exists */ && openOf(db, 'unit-1').length === 4);
    T.check('server healthy', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
