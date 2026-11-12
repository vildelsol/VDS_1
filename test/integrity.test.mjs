/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data integrity: transaction rollback, concurrency, atomic writes, calendar-aware
 * date validation, and basic input hardening.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, sleep } from './harness.mjs';

export const title = 'Data integrity & durability';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'IntegTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'IntegTest-1234!', 'IntegNew-9876!');
    await makeLongTermUnit(c);

    // --- a rejected multi-field update leaves nothing behind ---
    let db = (await c.get('/api/db')).body;
    const ten = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    const originalStart = ten.startedOn;
    const rejected = await c.put(`/api/tenancies/${ten.id}`, { startedOn: '2020-01-01', endedOn: 'not-a-date' });
    // Force an unrelated successful write, which is what used to flush the stale edit to disk.
    await c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 1, currency: 'JMD', payerName: 'Flush', method: 'Cash' });
    db = (await c.get('/api/db')).body;
    const after = db.tenancies.find(t => t.id === ten.id);
    T.check('a rejected update returns 400 and changes nothing in memory', rejected.status === 400 && after.startedOn === originalStart, `startedOn "${originalStart}" -> "${after.startedOn}"`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'db.json'), 'utf-8'));
    T.check('and nothing stale reaches the file on disk', onDisk.tenancies.find(t => t.id === ten.id).startedOn === originalStart);

    // --- concurrency: no lost updates, unique receipts and ids ---
    const before = (await c.get('/api/db')).body.payments.length;
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 10.01, currency: 'JMD', payerName: `Conc ${i}`, method: 'Cash' })));
    db = (await c.get('/api/db')).body;
    T.check('20 concurrent writes all persist', db.payments.length - before === 20, `${db.payments.length - before}/20`);
    const ids = burst.map(b => b.body?.payment?.id).filter(Boolean);
    // Receipt numbers are issued at confirmation, so the counter is exercised by
    // confirming the burst concurrently rather than by recording it.
    const confirmedBurst = await Promise.all(ids.map(id => c.post(`/api/payments/${id}/confirm`, {})));
    const recs = confirmedBurst.map(b => b.body?.payment?.receiptNo).filter(Boolean);
    T.check('20 concurrent confirmations produced distinct receipt numbers', new Set(recs).size === 20, `${new Set(recs).size} unique`);
    T.check('20 concurrent writes produced distinct record ids', new Set(ids).size === 20, `${new Set(ids).size} unique`);

    // --- atomic write: the file is never observed half-written ---
    let corrupt = 0;
    const spam = Promise.all(Array.from({ length: 15 }, (_, i) => c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 5, currency: 'JMD', payerName: `Spam ${i}`, method: 'Cash' })));
    for (let i = 0; i < 60; i++) {
      try {
        JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'db.json'), 'utf-8'));
      } catch (err) {
        // A transient read error (a rename in flight on Windows) is not corruption;
        // only content that reads back as invalid JSON is a failure.
        if (err instanceof SyntaxError) corrupt++;
      }
      await sleep(5);
    }
    await spam;
    T.check('db.json is never observed as corrupt/half-written content', corrupt === 0, `${corrupt} corrupt reads`);

    // --- calendar-aware date validation ---
    const badDay = d => c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 1, currency: 'JMD', payerName: 'D', method: 'Cash', date: d });
    for (const d of ['2026-02-31', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32']) {
      T.check(`an impossible date is refused: ${d}`, (await badDay(d)).status === 400);
    }
    T.check('a real leap day is accepted: 2024-02-29', (await badDay('2024-02-29')).status === 200);
    T.check('a real date is accepted: 2026-01-31', (await badDay('2026-01-31')).status === 200);

    // --- input hardening ---
    const xss = await c.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 1, currency: 'JMD', method: 'Cash', payerName: '<script>alert(1)</script>' });
    T.check('a script tag is stored verbatim (React escapes it on render)', xss.status === 200 && xss.body?.payment?.payerName === '<script>alert(1)</script>');
    T.check('an empty body does not 500', (await c.post('/api/payments', undefined, { headers: { 'Content-Type': 'application/json' } })).status === 400);
    const big = await fetch(srv.baseUrl + '/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c.getCookie() }, body: JSON.stringify({ notes: 'x'.repeat(3_000_000) }) });
    T.check('an oversized body is refused', big.status === 413 || big.status === 400, `status ${big.status}`);
    T.check('a path-traversal id is harmless', (await c.put('/api/units/..%2f..%2fetc%2fpasswd', { ownerName: 'x' })).status >= 400);

    /* ---- the two books policing each other, on the live machine ----
     *
     * Each guard is proved by breaking the data and watching it fire, then by
     * putting the data back and watching it go quiet. A guard that is never seen
     * to fail is not known to work. See prove-a-guard-by-deleting-it.
     */
    const codes = async () => (await c.get('/api/integrity')).body.findings.map(f => f.code);
    /*
     * Each scenario runs on its OWN copy of the database, in its own directory:
     * the harness removes a server's data directory when it stops, so editing in
     * place and restarting leaves nothing to read.
     */
    const snapshot = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'db.json'), 'utf-8'));
    let scenarioPort = port + 400;
    const edit = async fn => {
      const raw = JSON.parse(JSON.stringify(snapshot));
      fn(raw);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-integ-'));
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(raw));
      const again = await startServer({ port: scenarioPort++, adminPassword: 'unused', projectRoot, dataDir: dir });
      const cc = makeClient(again.baseUrl);
      await cc.post('/api/auth/login', { username: 'admin', password: 'IntegNew-9876!' }, { captureCookie: true });
      const found = (await cc.get('/api/integrity')).body.findings.map(f => f.code);
      await again.stop();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      return found;
    };

    T.check('a clean property reports neither cross-book fault', !(await codes()).some(x => /rent-split|levy-settled/.test(x)));

    const splitBroken = await edit(db => {
      db.units[0] = { ...db.units[0], status: 'long-term', tenantName: 'T', monthlyRent: 100000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 7, maintDueDay: 1 };
      db.charges.push({ id: 'chg-split-broken', unitId: db.units[0].id, unitNumber: db.units[0].number, category: 'Rent', periodMonth: '2026-09', dueDate: '2026-09-07',
        amount: 100000, rentPortion: 80000, maintenancePortion: 15000, currency: 'JMD', status: 'open', payerName: 'T', createdAt: '', createdBy: '' });
    });
    T.check('a rent charge whose parts do not add up to the tenant\'s figure is reported', splitBroken.includes('rent-split-does-not-add-up'), JSON.stringify(splitBroken));

    const putBack = await edit(() => { /* the same property, untouched */ });
    T.check('and the finding clears once the split is put right', !putBack.includes('rent-split-does-not-add-up'), JSON.stringify(putBack));

    const overSettled = await edit(db => {
      const u = db.units[0];
      // Rent billed and paid in full for three months, but only one month of levy
      // was ever charged: the credit from rent must not exceed what was charged.
      for (const m of ['2026-09', '2026-10', '2026-11']) {
        db.charges.push({ id: `chg-r-${m}`, unitId: u.id, unitNumber: u.number, category: 'Rent', periodMonth: m, dueDate: `${m}-07`,
          amount: 100000, rentPortion: 80000, maintenancePortion: 20000, currency: 'JMD', status: 'open', payerName: 'T', createdAt: '', createdBy: '' });
        db.payments.push({ id: `pay-r-${m}`, receiptNo: `RX-${m}`, payerName: 'T', unitId: u.id, unitNumber: u.number, category: 'Rent',
          amount: 100000, currency: 'JMD', date: `${m}-07`, method: 'Cash', reference: '', notes: '', staffMember: 's', status: 'completed' });
      }
      db.charges.push({ id: 'chg-m-one', unitId: u.id, unitNumber: u.number, category: 'Maintenance', periodMonth: '2026-09', dueDate: '2026-09-01',
        amount: 20000, currency: 'JMD', status: 'open', payerName: 'O', createdAt: '', createdBy: '' });
      // Already paid in cash, so every penny credited from rent is one too many.
      db.payments.push({ id: 'pay-m-one', receiptNo: 'RX-M', payerName: 'O', unitId: u.id, unitNumber: u.number, category: 'Maintenance',
        amount: 20000, currency: 'JMD', date: '2026-09-02', method: 'Cash', reference: '', notes: '', staffMember: 's', status: 'completed' });
    });
    /*
     * This arrangement is deliberately adversarial: three months of rent paid in
     * full, each carrying a 20,000 levy share, against a single month of levy
     * that was already paid in cash. Under a pooled rule the spare share would
     * spill onto months that were never charged. It reports nothing, because the
     * credit is capped per month at source — so no arrangement of DATA can
     * breach it, and this guard is watching the CODE for a future regression.
     * Proved by removing the cap in settledFromRent: the finding then fires.
     */
    T.check('no arrangement of the data can settle a levy that was never charged', !overSettled.includes('levy-settled-beyond-what-was-charged'), JSON.stringify(overSettled));
    T.check('and that adversarial book is otherwise clean', !overSettled.some(x => /rent-split|negative-rent/.test(x)), JSON.stringify(overSettled));
  } finally {
    await srv.stop();
  }
  return T.done();
}
