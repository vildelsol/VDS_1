/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Maintenance receipts keyed separately on let villas (Ro, 2026-11-12).
 *
 * Before the tenant's rent was one figure, a let villa's J$100,000 was keyed as an
 * J$80,000 Rent receipt plus a J$20,000 Maintenance receipt. After Restate the
 * rent charge is J$100,000, so the rent account read short while the maintenance
 * account read paid. These receipts are moved into rent. The legacy state is built
 * the honest way: months posted, the server stopped, the split stripped from db.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

/** The real finance library, bundled, so the documents are built the way the app builds them. */
async function bundleFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fin-'));
  const out = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
  return pathToFileURL(out).href;
}

export const title = 'Moving separately keyed maintenance receipts into rent';

const cents = n => Math.round(n * 100);
const rentOwed = (db, id) => {
  const billed = db.charges.filter(x => x.unitId === id && x.category === 'Rent' && x.status === 'open').reduce((a, x) => a + cents(x.amount), 0);
  const got = db.payments.filter(p => p.unitId === id && p.category === 'Rent' && p.status === 'completed').reduce((a, p) => a + cents(p.amount), 0);
  return (billed - got) / 100;
};
const maintReceipts = (db, id) => db.payments.filter(p => p.unitId === id && p.category === 'Maintenance' && p.status === 'completed');

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-receipts-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'Receipts-1234!', projectRoot, dataDir });
  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Receipts-1234!', 'ReceiptsNew-9876!');
    const mk = (id, over) => makeLongTermUnit(c, id, { monthlyRent: 100000, monthlyMaintenance: 20000, tenantName: id, ...over });
    await mk('unit-1'); // B10: three months, paid 80,000 rent + 20,000 maintenance each
    await mk('unit-2'); // A5: two months paid the same way, November not yet paid
    await mk('unit-3'); // a 50,000 maintenance receipt that is not whole months of the levy
    await mk('unit-4'); // rent paid in full after Restate; a stray maintenance receipt would put it in credit
    await mk('unit-5'); // owes everything, no maintenance receipts at all
    await c.put('/api/units/unit-6', { number: '6', ownerName: 'Owner Six', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });

    // The previous release: charges at the old net rent, no split.
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const ch of raw.charges) {
      if (ch.category === 'Rent' && ch.kind !== 'one-off') {
        const u = raw.units.find(x => x.id === ch.unitId);
        ch.amount = u.monthlyRent - u.monthlyMaintenance;
        delete ch.rentPortion;
        delete ch.maintenancePortion;
      }
    }
    /*
     * These are long-standing tenants, as the real let villas are. The move-in
     * date is written straight into the file for the same reason the split is
     * stripped here: entering it through the unit form is a changeover, which
     * correctly raises first and last month's rent and would change every figure
     * this test is about. The receipt move needs the date, because it is what
     * tells the tenant's money from the owner's.
     */
    for (const t of raw.tenancies || []) if (t.status === 'active') t.startedOn = '2026-09-01';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'ReceiptsNew-9876!' }, { captureCookie: true });


    const pay = (unitId, category, amount, date) =>
      recordAndConfirmPayment(c, { unitId, category, amount, currency: 'JMD', payerName: unitId, method: 'Cash', date });
    for (const d of ['2026-09-07', '2026-10-07', '2026-11-05']) { await pay('unit-1', 'Rent', 80000, d); await pay('unit-1', 'Maintenance', 20000, d); }
    for (const d of ['2026-09-07', '2026-10-07']) { await pay('unit-2', 'Rent', 80000, d); await pay('unit-2', 'Maintenance', 20000, d); }
    await pay('unit-3', 'Maintenance', 50000, '2026-10-07');
    for (const d of ['2026-09-07', '2026-10-07', '2026-11-05']) await pay('unit-4', 'Rent', 80000, d);
    await pay('unit-4', 'Maintenance', 20000, '2026-11-06'); // whole months, but the rent is already clear: moving it would put the tenant in credit
    await pay('unit-6', 'Maintenance', 20000, '2026-11-02');

let db = (await c.get('/api/db')).body;

    // Before Restate, receipts are not touched: the rent charges carry no split yet.
    const early = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    db = (await c.get('/api/db')).body;
    T.check('before Restate nothing is moved', early.status === 200 && early.body.moved === 0 && maintReceipts(db, 'unit-1').length === 3);

    await c.post('/api/charges/restate-rent', { confirm: true });
    await pay('unit-4', 'Rent', 60000, '2026-11-06'); // the 100,000 rent is now paid in full
    db = (await c.get('/api/db')).body;
    T.check('after Restate, B10 reads short by exactly its 3 x 20,000', rentOwed(db, 'unit-1') === 60000, String(rentOwed(db, 'unit-1')));
    T.check('and A5 reads 140,000 owing, as Ro saw', rentOwed(db, 'unit-2') === 140000, String(rentOwed(db, 'unit-2')));

    // --- dry run ---
    const dry = await c.post('/api/payments/restate-maintenance-receipts', {});
    T.check('dry run lists the 5 receipts (3 + 2)', dry.status === 200 && dry.body.confirmed === false && dry.body.count === 5, JSON.stringify(dry.body).slice(0, 200));
    T.check('dry run moves nothing', dry.body.moved === 0);
    db = (await c.get('/api/db')).body;
    T.check('dry run changed no record', maintReceipts(db, 'unit-1').length === 3 && rentOwed(db, 'unit-1') === 60000);
    T.check('50,000 on unit 3 is skipped: not whole months of 20,000', dry.body.skipped.some(s => s.unit === '3' && /whole number/.test(s.reason)));
    T.check('unit 4 stray receipt is skipped: it would put the tenant in credit', dry.body.skipped.some(s => s.unit === '4' && /credit/.test(s.reason)));
    T.check('owner-occupied villa 6 is not offered at all', !dry.body.plan.some(p => p.unit === '6') && !dry.body.skipped.some(s => s.unit === '6'));
    T.check('unit 5 has nothing to move', !dry.body.plan.some(p => p.unit === '5'));

    // --- permission ---
    const anon = makeClient(srv.baseUrl);
    T.check('without a session it is refused', (await anon.post('/api/payments/restate-maintenance-receipts', { confirm: true })).status === 401);

    // --- confirm ---
    const dbBefore = JSON.parse(JSON.stringify(db));
    const before = Object.fromEntries(db.payments.map(p => [p.id, { ...p }]));
    const done = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    db = (await c.get('/api/db')).body;
    T.check('confirmed run moves 5 receipts', done.status === 200 && done.body.moved === 5, JSON.stringify(done.body).slice(0, 200));
    T.check('B10 now owes nothing', rentOwed(db, 'unit-1') === 0, String(rentOwed(db, 'unit-1')));
    T.check('A5 owes exactly November, 100,000, and not 140,000', rentOwed(db, 'unit-2') === 100000, String(rentOwed(db, 'unit-2')));
    T.check('unit 3 is unchanged (still owes 300,000 rent, keeps its maintenance receipt)', rentOwed(db, 'unit-3') === 300000 && maintReceipts(db, 'unit-3').length === 1);
    T.check('unit 4 is unchanged and not in credit', rentOwed(db, 'unit-4') === 0 && maintReceipts(db, 'unit-4').length === 1);
    T.check('unit 5 is unchanged', rentOwed(db, 'unit-5') === 300000);
    T.check('owner villa 6 keeps its maintenance receipt', maintReceipts(db, 'unit-6').length === 1);
    const movedIds = done.body.plan.map(p => p.id);
    T.check('each moved receipt kept its number, date, amount, currency and payer',
      movedIds.every(id => { const a = before[id]; const b = db.payments.find(p => p.id === id); return b.receiptNo === a.receiptNo && b.date === a.date && b.amount === a.amount && b.currency === a.currency && b.payerName === a.payerName && b.category === 'Rent' && b.movedFrom === 'Maintenance' && b.notes === a.notes; }));
    T.check('nothing a tenant could read is added: no receipt text mentions maintenance after the move',
      movedIds.every(id => { const b = db.payments.find(p => p.id === id); return !/maintenance/i.test(`${b.notes} ${b.reference} ${b.payerName}`); }));
    T.check('no other field of any other receipt changed',
      db.payments.filter(p => !movedIds.includes(p.id)).every(p => JSON.stringify(p) === JSON.stringify(before[p.id])));
    T.check('total money received is unchanged to the cent',
      db.payments.reduce((a, p) => a + cents(p.amount), 0) === Object.values(before).reduce((a, p) => a + cents(p.amount), 0));
    T.check('each move is audited', db.auditLogs.filter(a => /^Moved receipt .* from Maintenance to Rent/.test(a.action)).length === 5);

    // --- idempotent ---
    const again = await c.post('/api/payments/restate-maintenance-receipts', { confirm: true });
    const db2 = (await c.get('/api/db')).body;
    T.check('running it again moves nothing', again.body.moved === 0 && JSON.stringify(db2.payments) === JSON.stringify(db.payments));
    /* ===== the rest of the ecosystem, after the move (Ro, 2026-11-12) =====
     *
     * Moving a receipt from Maintenance to Rent moves income between the two
     * books: ISPO's rent goes up, the corporation's cash levy goes down, and the
     * levy is made good by a derived credit that exists only in the browser. The
     * balances were checked above; these are the documents built on top of them.
     */
    const F = await import(await bundleFinance(projectRoot));
    const settled = p => [...p, ...F.settledFromRent(dbBefore.charges, p)];
    const cashOf = list => list.filter(x => x.status === 'completed' && !x.derived).reduce((a, x) => a + cents(x.amount), 0);

    T.check('the property holds exactly the same cash as before the move',
      cashOf(db.payments) === cashOf(dbBefore.payments), `${cashOf(db.payments)} vs ${cashOf(dbBefore.payments)}`);

    const UNIT = db.units.find(u => u.id === 'unit-1');
    const snapBefore = { charges: dbBefore.charges, payments: settled(dbBefore.payments) };
    const after = { charges: db.charges, payments: [...db.payments, ...F.settledFromRent(db.charges, db.payments)] };

    /*
     * 1. The combined view, per villa. It deliberately drops a let villa's
     * Maintenance receipts, because those are ISPO handing the corporation the
     * levy out of rent it has already counted — a transfer, not money from
     * anybody. That is why this is checked per villa against what the TENANT
     * actually handed over, not against the property's whole cash position.
     *
     * Before the move, a tenant who paid 100,000 as 80,000 rent + 20,000 levy had
     * the levy half dropped as a transfer, so the combined view reported only
     * 80,000 of their money. Moving the receipt is what makes it read 100,000.
     */
    const combinedFor = (snap, unitId) => {
      const comb = F.consolidateEverything(snap.charges, snap.payments);
      return comb.payments.filter(p => p.unitId === unitId && p.status === 'completed' && p.currency === 'JMD')
        .reduce((a, p) => a + cents(p.amount) - cents(p.refundedAmount || 0), 0);
    };
    const handedOver = (snap, unitId) =>
      snap.payments.filter(p => p.unitId === unitId && p.status === 'completed' && !p.derived && p.currency === 'JMD')
        .reduce((a, p) => a + cents(p.amount) - cents(p.refundedAmount || 0), 0);

    for (const id of ['unit-1', 'unit-2']) {
      T.check(`${id}: before the move the combined view under-reported the tenant, counting only the rent half`,
        combinedFor(snapBefore, id) < handedOver(snapBefore, id), `${combinedFor(snapBefore, id)} vs ${handedOver(snapBefore, id)}`);
      T.check(`${id}: after the move it reports every penny that tenant actually handed over, once`,
        combinedFor(after, id) === handedOver(after, id), `${combinedFor(after, id)} vs ${handedOver(after, id)}`);
    }

    /*
     * Ro's ruling, 2026-11-12: every let villa and every short stay is ISPO's,
     * and ISPO passes the corporation the levy on each. So a Maintenance receipt
     * on one of them is money moving between the two books, whatever its amount
     * — including a leftover the move will not take. The combined view is right
     * to drop it, and this records that the question is settled rather than open.
     */
    T.check("a leftover maintenance receipt on an ISPO-let villa is money between the books, so the combined view leaves it out",
      combinedFor(after, 'unit-3') === 0 && handedOver(after, 'unit-3') === cents(50000),
      `${combinedFor(after, 'unit-3')} vs ${handedOver(after, 'unit-3')}`);

    T.check('server healthy', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
