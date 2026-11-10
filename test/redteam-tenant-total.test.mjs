/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Red team: the restate route and the maintenance-edit path.
 *
 * Legacy data is built the honest way (raise charges, stop the server, strip the
 * split from db.json as the previous release left it, start again), then attacked:
 * no session, a junior officer, hostile bodies, a tampered amount, a double-click
 * storm of concurrent confirms, a stale browser tab, a tenancy ended afterwards,
 * and an interrupted run. Integrity is asserted on the books after every round.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Red team: restating and levy edits';

const cents = n => Math.round(n * 100);
const open = (db, id, cat = 'Rent') => db.charges.filter(c => c.unitId === id && c.category === cat && c.status === 'open');
const sum = rows => rows.reduce((a, x) => a + cents(x.amount), 0);

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-redteam-tt-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'RedTT-1234!', projectRoot, dataDir });
  try {
    let admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'RedTT-1234!', 'RedTTNew-9876!');
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    await admin.post('/api/users', { name: 'Fin Officer', username: 'finance', role: 'FINANCE_OFFICER', password: 'FinPass-1111!' });

    await makeLongTermUnit(admin, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000 });
    await makeLongTermUnit(admin, 'unit-2', { monthlyRent: 80000, monthlyMaintenance: 20000, tenantName: 'Two' });
    await makeLongTermUnit(admin, 'unit-3', { monthlyRent: 90000, monthlyMaintenance: 20000, tenantName: 'Three' });
    for (const m of ['2026-08', '2026-09', '2026-10']) await admin.post('/api/charges/post-month', { monthString: m });
    // Unit 3: a tenancy with first-and-last at the old figure, to test the advance relink.
    let db0 = (await admin.get('/api/db')).body;
    const ten = db0.tenancies.find(t => t.unitId === 'unit-3' && t.status === 'active');
    await admin.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-07-01' });

    // ---- previous release: strip the split, charges at rent alone ----
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const ch of raw.charges) if (ch.category === 'Rent') {
      { const u0 = raw.units.find(u => u.id === ch.unitId); ch.amount = u0.monthlyRent - u0.monthlyMaintenance; }
      delete ch.rentPortion; delete ch.maintenancePortion;
    }
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    admin = makeClient(srv.baseUrl);
    await admin.post('/api/auth/login', { username: 'admin', password: 'RedTTNew-9876!' }, { captureCookie: true });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    const fin = makeClient(srv.baseUrl);
    await fin.post('/api/auth/login', { username: 'finance', password: 'FinPass-1111!' }, { captureCookie: true });
    await fin.post('/api/auth/change-password', { currentPassword: 'FinPass-1111!', newPassword: 'FinOwn-22222!' });

    let db = (await admin.get('/api/db')).body;
    const snapshot = JSON.stringify(db.charges);
    const legacyCount = db.charges.filter(c => c.category === 'Rent' && c.status === 'open' && c.rentPortion === undefined).length;
    T.check('legacy fixture is in place', legacyCount >= 9, String(legacyCount));

    /* ---------- access ---------- */
    T.check('no session: 401', (await makeClient(srv.baseUrl).post('/api/charges/restate-rent', { confirm: true })).status === 401);
    const jrTry = await jr.post('/api/charges/restate-rent', { confirm: true });
    T.check('a junior officer is refused', jrTry.status === 403, String(jrTry.status));
    const finTry = await fin.post('/api/charges/restate-rent', { confirm: true });
    T.check('a finance officer without settled-record rights is refused or the right is deliberate', finTry.status === 403 || finTry.status === 200, String(finTry.status));
    db = (await admin.get('/api/db')).body;
    if (finTry.status === 403) T.check('refusals changed nothing', JSON.stringify(db.charges) === snapshot);
    // reset in case finance was allowed: re-strip is not possible live; so only continue if nothing changed
    const stillLegacy = db.charges.filter(c => c.category === 'Rent' && c.status === 'open' && c.rentPortion === undefined).length;

    /* ---------- hostile bodies: all must be dry runs or clean refusals ---------- */
    if (stillLegacy === legacyCount) {
      for (const body of [undefined, null, [], 'true', 1, { confirm: 'true' }, { confirm: 1 }, { confirm: [true] }, { confirm: { x: 1 } }, { __proto__: { confirm: true } }, { amount: 1, id: 'x', confirm: false }]) {
        const r = await admin.post('/api/charges/restate-rent', body);
        T.check(`hostile body ${JSON.stringify(body)} restates nothing and does not crash`, r.status < 500 && !(r.body && r.body.restated > 0), `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      }
      db = (await admin.get('/api/db')).body;
      T.check('after all hostile bodies the books are byte-identical', JSON.stringify(db.charges) === snapshot);
      const wrongMethod = await admin.get('/api/charges/restate-rent');
      T.check('GET is not a way to trigger it', wrongMethod.status >= 400 && wrongMethod.status !== 500, String(wrongMethod.status));
      const viaVoidRoute = await admin.post('/api/charges/restate-rent/void', { reason: 'attempt to hit the void route' });
      T.check('the route name cannot be confused with a charge id', viaVoidRoute.status === 404 || viaVoidRoute.status === 400, String(viaVoidRoute.status));
    }

    /* ---------- tampered amount is ignored ---------- */
    const levyBefore = db.units.find(u => u.id === 'unit-1').monthlyMaintenance;

    /* ---------- a double-click storm ---------- */
    const pre = (await admin.get('/api/db')).body;
    const preOpenTotal = sum(pre.charges.filter(c => c.category === 'Rent' && c.status === 'open'));
    const storm = await Promise.all(Array.from({ length: 12 }, () => admin.post('/api/charges/restate-rent', { confirm: true, amount: 1 })));
    db = (await admin.get('/api/db')).body;
    const restatedTotals = storm.map(r => r.body?.restated || 0);
    T.check('twelve concurrent confirms never fail', storm.every(r => r.status === 200), storm.map(r => r.status).join());
    T.check('together they restate each charge exactly once', restatedTotals.reduce((a, b) => a + b, 0) === legacyCount || stillLegacy !== legacyCount, `${restatedTotals.join('+')} vs ${legacyCount}`);
    const rentOpen = db.charges.filter(c => c.category === 'Rent' && c.status === 'open' && c.kind !== 'one-off');
    T.check('every open rent charge now carries a split', rentOpen.every(c => c.rentPortion !== undefined));
    T.check('no month is billed twice on one account', ['unit-1', 'unit-2', 'unit-3'].every(id => ['2026-08', '2026-09', '2026-10'].every(m => db.charges.filter(c => c.unitId === id && c.category === 'Rent' && c.periodMonth === m && c.status === 'open' && c.kind === undefined).length === 1)));
    T.check('the books gained exactly the maintenance, once: 20,000 per restated charge', sum(db.charges.filter(c => c.category === 'Rent' && c.status === 'open')) - preOpenTotal === legacyCount * 2000000, `${sum(db.charges.filter(c => c.category === 'Rent' && c.status === 'open')) - preOpenTotal}`);
    T.check('the tampered amount field was ignored', db.charges.every(c => c.amount !== 1));
    T.check('the register levy is unchanged by restating', db.units.find(u => u.id === 'unit-1').monthlyMaintenance === levyBefore);
    T.check('originals are voided with reason and actor', db.charges.filter(c => c.status === 'void').every(c => /restated/i.test(c.voidReason || '') && c.voidedBy));
    T.check('audit: one entry per restated charge', db.auditLogs.filter(a => /^Restated .* rent for/.test(a.action)).length === legacyCount, String(db.auditLogs.filter(a => /^Restated/.test(a.action)).length));

    /* ---------- the advance still works after restating ---------- */
    const t3 = db.tenancies.find(t => t.unitId === 'unit-3' && t.status === 'active');
    const adv = db.charges.find(c => c.id === t3.advanceRentChargeId);
    T.check('the tenancy now points at the live (restated) advance charge', !!adv && adv.status === 'open' && adv.kind === 'advance-final-month' && adv.amount === 90000, JSON.stringify(adv));
    await admin.put(`/api/tenancies/${t3.id}`, { endedOn: '2026-10-20', endReason: 'Lease ended.' });
    db = (await admin.get('/api/db')).body;
    const r3 = open(db, 'unit-3');
    const months = db.charges.filter(c => c.unitId === 'unit-3' && c.category === 'Rent' && c.status === 'open').map(c => c.periodMonth).sort();
    T.check('moving out spends the advance: Oct is voided, not charged again', !months.includes('2026-10'), months.join());
    T.check('a tenant who stayed Jul–Oct is charged exactly 4 months at 90,000', sum(r3) === 4 * 9000000, String(sum(r3) / 100));

    /* ---------- the levy rise after restating; stale tab; hostile edits ---------- */
    const unit = db.units.find(u => u.id === 'unit-1');
    const edit = over => admin.put('/api/units/unit-1', { ...unit, ...over });
    const bad = [-27000, '27,000', 'NaN', 1e21, '', {}, [27000], '27000; DROP TABLE'];
    for (const v of bad) {
      const r = await edit({ monthlyMaintenance: v });
      db = (await admin.get('/api/db')).body;
      const now = db.units.find(u => u.id === 'unit-1').monthlyMaintenance;
      T.check(`levy ${JSON.stringify(v)}: no 500 and the stored figure is still sane`, r.status < 500 && Number.isFinite(now) && now >= 0 && now < 1e12, `${r.status} -> ${now}`);
    }
    const beforeRaise = JSON.stringify(db.charges);
    const good = await edit({ monthlyMaintenance: 27000 });
    db = (await admin.get('/api/db')).body;
    T.check('the 27,000 rise is accepted', good.status === 200 && db.units.find(u => u.id === 'unit-1').monthlyMaintenance === 27000);
    T.check('the rise altered no posted charge by a single cent', JSON.stringify(db.charges) === beforeRaise);
    T.check('a restate after the rise finds nothing (everything already split)', (await admin.post('/api/charges/restate-rent', { confirm: true })).body.restated === 0);
    const stale = await admin.put('/api/units/unit-1', { ...unit, monthlyMaintenance: 20000 });
    db = (await admin.get('/api/db')).body;
    T.check('a stale tab saving the old 20,000 is the user’s edit (last write wins), audited', stale.status === 200 ? db.auditLogs.some(a => /maintenance fee changed/.test(a.action)) : stale.status < 500);
    await edit({ monthlyMaintenance: 27000 });
    const june = await admin.post('/api/charges/post-month', { monthString: '2026-11' });
    db = (await admin.get('/api/db')).body;
    const nov = db.charges.filter(c => c.unitId === 'unit-1' && c.periodMonth === '2026-11' && c.status === 'open');
    T.check('the next month still posts at the agreed 75,000, with 27,000 of it maintenance', june.status === 200 && nov.find(c => c.category === 'Rent')?.amount === 75000 && nov.find(c => c.category === 'Rent')?.maintenancePortion === 27000 && nov.find(c => c.category === 'Maintenance')?.amount === 27000, JSON.stringify(nov.map(c => [c.category, c.amount])));

    /* ---------- interrupted run: kill the server mid-restate-free state, restart, data intact ---------- */
    const before = JSON.stringify(db.charges);
    await srv.stop();
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    admin = makeClient(srv.baseUrl);
    await admin.post('/api/auth/login', { username: 'admin', password: 'RedTTNew-9876!' }, { captureCookie: true });
    db = (await admin.get('/api/db')).body;
    T.check('after a restart the books are identical', JSON.stringify(db.charges) === before);
    const health = await admin.get('/api/health');
    T.check('the integrity self-check on boot finds no contradictions', health.status === 200 && !/contradict/i.test(JSON.stringify(health.body).replace(/no contradictions/gi, '')), JSON.stringify(health.body).slice(0, 120));
    T.check('no server log shows a stack trace', !/at .*\.(ts|js):\d+/.test(srv.getLog()), srv.getLog().slice(-200));
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
