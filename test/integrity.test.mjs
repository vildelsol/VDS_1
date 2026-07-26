/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Data integrity: transaction rollback, concurrency, atomic writes, calendar-aware
 * date validation, and basic input hardening.
 */

import fs from 'node:fs';
import path from 'node:path';
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
    const recs = burst.map(b => b.body?.payment?.receiptNo).filter(Boolean);
    const ids = burst.map(b => b.body?.payment?.id).filter(Boolean);
    T.check('20 concurrent writes produced distinct receipt numbers', new Set(recs).size === 20, `${new Set(recs).size} unique`);
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
  } finally {
    await srv.stop();
  }
  return T.done();
}
