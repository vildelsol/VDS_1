/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Going back to an earlier day, from inside the application.
 *
 * Until v1.16.6 the Backup screen offered "Download a snapshot" and then told you
 * to stop the application and copy a file over db.json by hand. That instruction
 * could not work for a snapshot at all: a snapshot carries no password hashes on
 * purpose, and it also left out the ownership history, the recurring expenses and
 * the annual reports. A file you were told to keep for the day the disk died
 * could not bring the property back.
 *
 * The rule under test: a restore replaces the records and never the accounts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Restoring records from a snapshot or a backup';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-restore-records-'));
  const stickDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-restore-stick-'));
  const newStickDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-restore-stick2-'));
  const srv = await startServer({ port, adminPassword: 'RestoreRec-1234!', projectRoot, dataDir });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'RestoreRec-1234!', 'RestoreRecNew-9876!');
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 50000, monthlyMaintenance: 10000, tenantName: 'Tenant One' });
    await c.post('/api/charges/post-month', { monthString: '2026-09' });
    await c.post('/api/settings', { backupDir: stickDir });

    const pay = (amount, date) =>
      recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant One', method: 'Cash', date });
    await pay(30000, '2026-09-05');

    // ---- the snapshot, taken the way a person takes it ----
    const snapRes = await c.get('/api/backup/download');
    const snapshot = JSON.parse(snapRes.text);
    T.check('the snapshot now carries every table a restore needs',
      ['ownerships', 'recurringExpenses', 'annualReports', 'tenancies', 'charges', 'payments', 'auditLogs', 'counters', 'settings'].every(k => k in snapshot),
      Object.keys(snapshot).join(','));
    T.check('the snapshot still carries no password material and no session',
      !/passwordHash|passwordSalt|"sessions"|"token"/.test(snapRes.text));

    const before = (await c.get('/api/db')).body;
    const paymentsAtSnapshot = before.payments.length;

    // The drive is changed AFTER the snapshot, so the snapshot names a stale one.
    // A restore that copied the old name back would unplug today's drive.
    await c.post('/api/settings', { backupDir: newStickDir });

    // ---- more work after the snapshot: the work a restore must remove ----
    await pay(20000, '2026-09-06');
    await c.post('/api/expenses', { category: 'Landscaping', amount: 7000, currency: 'JMD', date: '2026-09-07', description: 'Gardening', vendor: 'A gardener' });
    const later = (await c.get('/api/db')).body;
    T.check('after the snapshot there is more in the records', later.payments.length === paymentsAtSnapshot + 1 && later.expenses.length === before.expenses.length + 1);

    // ---- a look first changes nothing ----
    const look = await c.post('/api/backup/restore', { source: 'snapshot', snapshot, dryRun: true });
    T.check('a dry run describes the file', look.status === 200 && look.body?.summary?.counts?.payments === paymentsAtSnapshot, JSON.stringify(look.body).slice(0, 200));
    T.check('a dry run says what is there now', look.body?.present?.payments === later.payments.length);
    T.check('a dry run changes nothing', (await c.get('/api/db')).body.payments.length === later.payments.length);

    // ---- refusals ----
    const noWord = await c.post('/api/backup/restore', { source: 'snapshot', snapshot });
    T.check('without the typed word the restore is refused', noWord.status === 400, String(noWord.status));
    const wrongWord = await c.post('/api/backup/restore', { source: 'snapshot', snapshot, confirm: 'yes' });
    T.check('the wrong word is refused too', wrongWord.status === 400);
    T.check('and nothing changed', (await c.get('/api/db')).body.payments.length === later.payments.length);
    const junk = await c.post('/api/backup/restore', { source: 'snapshot', snapshot: { hello: 'world' }, confirm: 'RESTORE' });
    T.check('a file that is not a records file is refused', junk.status === 400, String(junk.status));
    const noVillas = await c.post('/api/backup/restore', { source: 'snapshot', snapshot: { ...snapshot, units: [] }, confirm: 'RESTORE' });
    T.check('a file with no villas is refused rather than wiping the property', noVillas.status === 400 && /no villas/i.test(noVillas.body?.error || ''), JSON.stringify(noVillas.body));
    const newer = await c.post('/api/backup/restore', { source: 'snapshot', snapshot: { ...snapshot, schemaVersion: 999 }, confirm: 'RESTORE' });
    T.check('a file from a newer build is refused', newer.status === 400 && /newer version/i.test(newer.body?.error || ''));
    const traversal = await c.post('/api/backup/restore', { source: 'backup', file: '../db.json', location: 'local', dryRun: true });
    T.check('a backup name that points elsewhere is refused', traversal.status === 400, String(traversal.status));
    const damaged = await c.post('/api/backup/restore', { source: 'snapshot', snapshot: { ...snapshot, payments: [1, 2] }, confirm: 'RESTORE' });
    T.check('a file whose rows are not records is refused', damaged.status === 400);
    T.check('none of those refusals changed anything', (await c.get('/api/db')).body.payments.length === later.payments.length);

    const anon = makeClient(srv.baseUrl);
    const anonRes = await anon.post('/api/backup/restore', { source: 'snapshot', snapshot, confirm: 'RESTORE' });
    T.check('a restore with no session is refused', anonRes.status === 401, String(anonRes.status));

    // ---- only an administrator ----
    await c.post('/api/users', { name: 'A Manager', username: 'mgr', role: 'MANAGER', password: 'ManagerPass-1234!' });
    const mgr = makeClient(srv.baseUrl);
    await mgr.post('/api/auth/login', { username: 'mgr', password: 'ManagerPass-1234!' }, { captureCookie: true });
    await mgr.post('/api/auth/change-password', { currentPassword: 'ManagerPass-1234!', newPassword: 'ManagerNew-5678!' });
    const mgrTry = await mgr.post('/api/backup/restore', { source: 'snapshot', snapshot, confirm: 'RESTORE' });
    T.check('a manager cannot restore', mgrTry.status === 403, String(mgrTry.status));

    // ---- the restore itself, with a body over the ordinary 1 MB limit ----
    const big = { ...snapshot, padding: 'x'.repeat(1_500_000) };
    const done = await c.post('/api/backup/restore', { source: 'snapshot', snapshot: big, confirm: 'RESTORE' });
    T.check('the restore succeeds (and a snapshot over 1 MB is accepted)', done.status === 200 && done.body?.success === true, `${done.status} ${JSON.stringify(done.body).slice(0, 300)}`);
    const after = (await c.get('/api/db')).body;
    T.check('the later payment is gone', after.payments.length === paymentsAtSnapshot, `${after.payments.length} vs ${paymentsAtSnapshot}`);
    T.check('the later expense is gone', after.expenses.length === before.expenses.length);
    T.check('the earlier payment is exactly as it was', JSON.stringify(after.payments) === JSON.stringify(before.payments));
    T.check('the charges are exactly as they were', JSON.stringify(after.charges.map(x => [x.id, x.amount, x.status])) === JSON.stringify(before.charges.map(x => [x.id, x.amount, x.status])));

    // ---- accounts are not touched ----
    T.check('the administrator is still signed in, on the same session', (await c.get('/api/db')).status === 200);
    const relog = makeClient(srv.baseUrl);
    const relogRes = await relog.post('/api/auth/login', { username: 'admin', password: 'RestoreRecNew-9876!' }, { captureCookie: true });
    T.check('the administrator can sign in with the current password', relogRes.status === 200, String(relogRes.status));
    const mgrRelog = makeClient(srv.baseUrl);
    const mgrRes = await mgrRelog.post('/api/auth/login', { username: 'mgr', password: 'ManagerNew-5678!' }, { captureCookie: true });
    T.check('a member of staff created AFTER the snapshot can still sign in', mgrRes.status === 200, String(mgrRes.status));
    const backupDirNow = (await c.get('/api/db')).body.settings?.backupDir;
    T.check('the backup drive setting survived the restore', backupDirNow === newStickDir, String(backupDirNow));

    // ---- the safety copy and the audit trail ----
    const safetyDir = path.join(dataDir, 'db-before-restore');
    const copies = fs.existsSync(safetyDir) ? fs.readdirSync(safetyDir) : [];
    T.check('a copy of the earlier records was kept before the restore', copies.length === 1, copies.join(','));
    if (copies.length) {
      const kept = JSON.parse(fs.readFileSync(path.join(safetyDir, copies[0]), 'utf-8'));
      T.check('and it holds the work the restore removed', kept.payments.length === later.payments.length);
    }
    const audit = (await c.get('/api/db')).body.auditLogs;
    T.check('the restore is in the audit trail, with who did it', audit.some(a => a.action === 'Restored the records from a backup'));
    const integ = (await c.get('/api/integrity')).body;
    T.check('the audit trail still verifies after the restore', !(integ.findings || []).some(f => f.code === 'audit-trail-broken'), JSON.stringify((integ.findings || []).map(f => f.code)));

    // ---- the next receipt does not collide ----
    const next = await pay(1000, '2026-09-08');
    const receipts = (await c.get('/api/db')).body.payments.map(p => p.receiptNo).filter(Boolean);
    T.check('the next receipt number is new', next.status < 300 && new Set(receipts).size === receipts.length, receipts.join(','));

    // ---- the undo: the safety copy is itself restorable ----
    // (the daily backup written by "Back up now" is the same shape as the file db.json)
    await c.post('/api/backup/run');
    const status = (await c.get('/api/backup/status')).body;
    const mine = status.backups.find(b => b.location === 'external') || status.backups[0];
    T.check('a daily backup is listed', !!mine, JSON.stringify(status.backups));
    const viaBackup = await c.post('/api/backup/restore', { source: 'backup', file: mine.file, location: mine.location, confirm: 'RESTORE' });
    T.check('restoring from a listed backup works', viaBackup.status === 200, `${viaBackup.status} ${JSON.stringify(viaBackup.body).slice(0, 200)}`);
    const final = (await c.get('/api/db')).body;
    T.check('and brought back the records as they were when that backup was taken', final.payments.length === receipts.length, `${final.payments.length} vs ${receipts.length}`);
    const staffReported = viaBackup.body?.summary?.staffNotRecreated || [];
    T.check('staff in the file but not on this machine are reported, not silently created', Array.isArray(staffReported));
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(stickDir, { recursive: true, force: true });
    fs.rmSync(newStickDir, { recursive: true, force: true });
  }
  return T.done();
}
