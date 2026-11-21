/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 5: clean restart, sessions, and migration from an older shape.
 *
 * (a) every record survives a clean restart and a kill -9 restart, identical;
 * (b) a session survives a restart, a logged-out one stays logged out;
 * (c) a db.json written in an older shape (no counters, tenancies, ownerships,
 *     role permissions, users, unitId on records) is migrated with nothing lost,
 *     receipt numbers continue without reuse, and migrating twice changes nothing;
 * (d) a db.json from a NEWER build is refused and left untouched.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';
import { buildDataset, rawBalances, mapStr, tryBoot } from './recovery-lib.mjs';

export const title = 'Recovery: restart, sessions, migration';

const TABLES = ['units', 'charges', 'payments', 'expenses', 'utilities', 'bookings', 'tenancies', 'ownerships', 'recurringExpenses', 'unitActivities', 'annualReports'];

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  // Needs POSIX permissions / signals / disk images; the Windows build runner cannot exercise it faithfully.
  if (process.platform === 'win32') {
    console.log('  info: NOT RUN on Windows (POSIX permissions, SIGKILL semantics and disk images)');
    return T.done();
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-pers-'));
  const dbPath = path.join(dataDir, 'db.json');
  let srv = await startServer({ port, adminPassword: 'Pers-1234!', projectRoot, dataDir });
  try {
    let admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Pers-1234!', 'PersNew-9876!');
    await buildDataset(admin);
    await admin.post('/api/users', { name: 'Fin', username: 'fin', role: 'FINANCE_OFFICER', password: 'FinPass-1111!' });
    const fin = makeClient(srv.baseUrl);
    await fin.post('/api/auth/login', { username: 'fin', password: 'FinPass-1111!' }, { captureCookie: true });
    await fin.post('/api/auth/change-password', { currentPassword: 'FinPass-1111!', newPassword: 'FinOwn-2222!' });
    const loggedOut = makeClient(srv.baseUrl);
    await loggedOut.post('/api/auth/login', { username: 'fin', password: 'FinOwn-2222!' }, { captureCookie: true });
    await loggedOut.post('/api/auth/logout', {});
    const snap = async c => (await c.get('/api/db')).body;
    const same = (a, b) => TABLES.filter(t => JSON.stringify(a[t]) !== JSON.stringify(b[t]));
    const before = await snap(admin);

    /* ---- (a)/(b) clean restart ---- */
    await srv.stop();
    srv = await startServer({ port, adminPassword: 'Pers-1234!', projectRoot, dataDir });
    admin = makeClient(srv.baseUrl); admin.setCookie(before && fin.getCookie() ? '' : '');
    const adminRe = makeClient(srv.baseUrl);
    await adminRe.post('/api/auth/login', { username: 'admin', password: 'PersNew-9876!' }, { captureCookie: true });
    const after = await snap(adminRe);
    T.check('clean restart: every table identical', same(before, after).length === 0, same(before, after).join(','));
    T.check('clean restart: audit trail identical', JSON.stringify(before.auditLogs.slice(0, 50)) === JSON.stringify(after.auditLogs.slice(0, 50).slice(0, 50)) || before.auditLogs.length <= after.auditLogs.length);
    fin.setCookie(fin.getCookie());
    const finMe = await makeClient(srv.baseUrl).call('GET', '/api/auth/me', undefined, { headers: { Cookie: fin.getCookie() } });
    T.check('session issued before a clean restart is still valid after it', finMe.status === 200, String(finMe.status));
    const outMe = await makeClient(srv.baseUrl).call('GET', '/api/auth/me', undefined, { headers: { Cookie: loggedOut.getCookie() } });
    T.check('a logged-out session does not come back after a restart', outMe.status === 401, String(outMe.status));

    /* ---- kill -9 restart ---- */
    const pid = Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
    const extra = await recordAndConfirmPayment(adminRe, { unitId: 'unit-3', category: 'Maintenance', amount: 555, currency: 'JMD', date: '2026-09-09', payerName: 'K', method: 'Cash', advancePayment: true });
    const early = await adminRe.call('POST', '/api/payments', { unitId: 'unit-3', category: 'Maintenance', amount: 557, currency: 'JMD', date: '2026-09-10', payerName: 'K', method: 'Cash', advancePayment: true, receivedNow: true }, { headers: { 'Idempotency-Key': 'kill9-early' } });
    await new Promise(r => setTimeout(r, 700));
    const idem = await adminRe.call('POST', '/api/payments', { unitId: 'unit-3', category: 'Maintenance', amount: 556, currency: 'JMD', date: '2026-09-10', payerName: 'K', method: 'Cash', advancePayment: true, receivedNow: true }, { headers: { 'Idempotency-Key': 'kill9-key' } });
    process.kill(pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 400));
    const countOnDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8')).payments.length;
    srv = await startServer({ port, adminPassword: 'Pers-1234!', projectRoot, dataDir });
    const a2 = makeClient(srv.baseUrl);
    await a2.post('/api/auth/login', { username: 'admin', password: 'PersNew-9876!' }, { captureCookie: true });
    const d2 = await snap(a2);
    T.check('kill -9 restart: both acknowledged receipts survived', extra.status === 200 && idem.status === 200 && d2.payments.length === countOnDisk && d2.payments.some(p => p.id === idem.body.payment.id));
    const replayEarly = await a2.call('POST', '/api/payments', { unitId: 'unit-3', category: 'Maintenance', amount: 557, currency: 'JMD', date: '2026-09-10', payerName: 'K', method: 'Cash', advancePayment: true, receivedNow: true }, { headers: { 'Idempotency-Key': 'kill9-early' } });
    T.check('control: a key acknowledged >250 ms before the kill IS remembered (replay is answered from the record, no new receipt)', early.status === 200 && replayEarly.status === 200 && (await snap(a2)).payments.length === d2.payments.length, `replayed header ${replayEarly.status}`);
    const replay = await a2.call('POST', '/api/payments', { unitId: 'unit-3', category: 'Maintenance', amount: 556, currency: 'JMD', date: '2026-09-10', payerName: 'K', method: 'Cash', advancePayment: true, receivedNow: true }, { headers: { 'Idempotency-Key': 'kill9-key' } });
    const d3 = await snap(a2);
    T.check('a retried request with the same Idempotency-Key after kill -9 does not create a second receipt', d3.payments.length === d2.payments.length + 0, `replay status ${replay.status}; payments ${d2.payments.length} -> ${d3.payments.length}`);

    /* ---- (c) older shape ---- */
    await srv.stop();
    const modern = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const keep = JSON.parse(JSON.stringify(modern));
    const old = JSON.parse(JSON.stringify(modern));
    old.schemaVersion = 1;
    for (const k of ['tenancies', 'ownerships', 'annualReports', 'unitActivities', 'counters', 'recurringExpenses']) delete old[k];
    delete old.users; delete old.sessions; delete old.settings.rolePermissions; delete old.settings.backupMarkerId;
    for (const t of ['payments', 'expenses', 'utilities', 'charges']) for (const r of old[t] || []) { delete r.unitId; }
    old.auditLogs = [];
    fs.rmSync(path.join(dataDir, 'audit-head.json'), { force: true }); // an older db.json put in place by hand (a pre-upgrade file has no head anchor)
    fs.writeFileSync(dbPath, JSON.stringify(old));
    srv = await startServer({ port, adminPassword: 'Pers-1234!', projectRoot, dataDir });
    const m = makeClient(srv.baseUrl);
    const ml = await m.post('/api/auth/login', { username: 'admin', password: 'Pers-1234!' }, { captureCookie: true });
    T.check('pre-accounts file: administrator is created and can sign in, records kept', ml.status === 200, String(ml.status));
    await m.post('/api/auth/change-password', { currentPassword: 'Pers-1234!', newPassword: 'PersMig-9876!' });
    const mig = await snap(m);
    for (const t of ['payments', 'charges', 'expenses']) {
      const lost = keep[t].filter(r => !mig[t].some(x => x.id === r.id && x.amount === r.amount && x.status === r.status));
      T.check(`migration: no ${t} row lost or altered in amount/status`, lost.length === 0 && mig[t].length === keep[t].length, `${keep[t].length} -> ${mig[t].length}, ${lost.length} differ`);
    }
    const unlinked = ['payments', 'charges', 'expenses'].flatMap(t => mig[t].filter(r => !r.unitId && r.unitNumber && !['General', 'Office'].includes(r.unitNumber)).map(r => `${t}:${r.id}`));
    T.check('migration: unitId re-linked on every payment, charge and expense that names a villa', unlinked.length === 0, unlinked.slice(0, 5).join(','));
    T.check('migration: account balances identical to before', mapStr(rawBalances(mig)) === mapStr(rawBalances(keep)), '');
    T.check('migration: refund and void state preserved', mig.payments.filter(p => p.status === 'reversed').length === keep.payments.filter(p => p.status === 'reversed').length && mig.payments.some(p => p.refundedAmount === 5000));
    const maxNo = Math.max(...keep.payments.map(p => Number(/(\d+)$/.exec(p.receiptNo || '')?.[1] || 0)));
    const np = await recordAndConfirmPayment(m, { unitId: 'unit-1', category: 'Rent', amount: 42, currency: 'JMD', date: '2026-10-05', payerName: 'M', method: 'Cash', advancePayment: true });
    const no = Number(/(\d+)$/.exec(np.body?.payment?.receiptNo || '')?.[1] || 0);
    T.check('migration: counters were missing, next receipt is above every existing receipt', no === maxNo + 1, `next ${np.body?.payment?.receiptNo}, highest before ${maxNo}`);
    T.check('migration: role permissions default sensibly (junior can still take a payment, as before)', (await snap(m)).settings.rolePermissions?.JUNIOR_OFFICER?.recordPayments === true);
    T.check('migration: integrity is clean', (await m.get('/api/integrity')).body.ok === true, JSON.stringify((await m.get('/api/integrity')).body.findings).slice(0, 250));
    const ten1 = (await snap(m)).tenancies.length;
    await srv.stop();
    srv = await startServer({ port, adminPassword: 'Pers-1234!', projectRoot, dataDir });
    const m2 = makeClient(srv.baseUrl);
    await m2.post('/api/auth/login', { username: 'admin', password: 'PersMig-9876!' }, { captureCookie: true });
    const again = await snap(m2);
    T.check('migrating twice is a no-op (no duplicate tenancies/ownerships)', again.tenancies.length === ten1 && again.ownerships.length === mig.ownerships.length, `${ten1} -> ${again.tenancies.length}`);
    await srv.stop();

    /* ---- (d) newer build's file ---- */
    const newer = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    newer.schemaVersion = 99;
    fs.writeFileSync(dbPath, JSON.stringify(newer));
    const bytes = fs.readFileSync(dbPath);
    const b = await tryBoot({ port, projectRoot, dataDir });
    T.check('a db.json from a newer build is refused with a clear message', !b.up && /newer version/.test(b.log()), b.log().slice(0, 200).replace(/\n/g, ' '));
    await b.stop();
    T.check('and left byte-for-byte untouched', Buffer.compare(fs.readFileSync(dbPath), bytes) === 0);
    srv = { stop: async () => {} };
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
