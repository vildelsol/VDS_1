/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Restoring from a backup — the day the disk dies.
 *
 * The backup suite proves a copy is *written*. This one proves the copy is worth
 * having: db.json is destroyed, yesterday's file is put in its place, the server
 * is started on it, and the records have to come back — the ledger, the receipt
 * counter, the staff and their passwords.
 *
 * A backup nobody has ever restored is not yet a backup, and the failure mode is
 * silent: you find out on the one morning you cannot afford to.
 *
 * It also holds the line on what a backup must *not* carry. The file leaves the
 * machine on a USB stick or through a synced folder, and a session token is a
 * working credential for twelve hours. If one survived into the copy, anyone who
 * could read it could sign in as its owner.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Restoring from a backup';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-restore-'));
  const dbPath = path.join(dataDir, 'db.json');
  const backupDir = path.join(dataDir, 'db-backups');
  let srv = await startServer({ port, adminPassword: 'RestoreTest-1234!', projectRoot, dataDir });

  try {
    /* ---------------------------------------------------------------- *
     * A day's real work, then a backup of it
     * ---------------------------------------------------------------- */

    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'RestoreTest-1234!', 'RestoreAdmin-9876!');
    await makeLongTermUnit(admin);
    await admin.post('/api/users', { name: 'Fin Officer', username: 'finance', role: 'FINANCE_OFFICER', password: 'FinancePass-11!' });

    // A signed-in second person, so a live session exists at the moment of backup.
    const finance = makeClient(srv.baseUrl);
    await finance.post('/api/auth/login', { username: 'finance', password: 'FinancePass-11!' }, { captureCookie: true });
    await finance.post('/api/auth/change-password', { currentPassword: 'FinancePass-11!', newPassword: 'FinanceOwn-22!' });
    const financeCookie = finance.getCookie();
    T.check('the finance officer is signed in when the backup is taken', (await finance.get('/api/db')).status === 200);

    await admin.post('/api/charges/post-month', { monthString: '2026-07' });
    const paid = await recordAndConfirmPayment(admin, {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash'
    });
    const receiptNo = paid.body?.payment?.receiptNo;
    T.check('a receipt was issued before the backup', !!receiptNo, `receiptNo="${receiptNo}"`);

    const before = (await admin.get('/api/db')).body;
    const ran = await admin.post('/api/backup/run', {});
    T.check('a backup can be taken on demand', ran.status === 200);

    const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('db-') && f.endsWith('.json'));
    T.check('the backup file exists on disk', backups.length === 1, backups.join(','));
    T.check('no half-written .partial file is left beside it', !fs.readdirSync(backupDir).some(f => f.endsWith('.partial')));

    const backupFile = path.join(backupDir, backups[0]);
    const copy = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

    /* ---------------------------------------------------------------- *
     * What the copy may and may not carry
     * ---------------------------------------------------------------- */

    T.check('the backup carries no live session', Array.isArray(copy.sessions) && copy.sessions.length === 0);
    T.check(
      'and no session token is anywhere in the file',
      !fs.readFileSync(backupFile, 'utf8').includes(financeCookie.split('=')[1])
    );
    // Hashes are deliberately kept: without them a restore loses every password.
    T.check('password hashes are kept, or a restore would lock everyone out', copy.users.every(u => !!u.passwordHash));

    /* ---------------------------------------------------------------- *
     * The disk dies
     * ---------------------------------------------------------------- */

    await srv.stop();
    fs.rmSync(dbPath);
    T.check('db.json is gone', !fs.existsSync(dbPath));

    fs.copyFileSync(backupFile, dbPath);
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });

    /* ---------------------------------------------------------------- *
     * The records have to come back
     * ---------------------------------------------------------------- */

    const restored = makeClient(srv.baseUrl);
    const signIn = await restored.post('/api/auth/login', { username: 'admin', password: 'RestoreAdmin-9876!' }, { captureCookie: true });
    T.check('the administrator can sign in again with the password they chose', signIn.status === 200);
    T.check('and is not forced through a password change again', signIn.body?.user?.mustChangePassword === false);

    const after = (await restored.get('/api/db')).body;
    T.check('the villa register came back', after.units.length === before.units.length);
    T.check('the tenant and rent came back', after.units.find(u => u.id === 'unit-1')?.monthlyRent === 50000);
    T.check('the charges came back', after.charges.length === before.charges.length && after.charges.length > 0);
    T.check('the payments came back', after.payments.length === before.payments.length && after.payments.length > 0);
    T.check('the receipt number is intact', after.payments.some(p => p.receiptNo === receiptNo));
    T.check('the audit trail came back', after.auditLogs.length >= before.auditLogs.length);
    T.check('the staff list came back', after.users.length === before.users.length);
    T.check(
      'settings came back',
      JSON.stringify(after.settings.rolePermissions) === JSON.stringify(before.settings.rolePermissions)
    );

    // A restore must not resurrect a login. The token was valid when the backup
    // was taken; it must be worthless now.
    const replay = makeClient(srv.baseUrl);
    replay.setCookie(financeCookie);
    T.check('a session that was live at backup time does not survive the restore', (await replay.get('/api/db')).status === 401);
    T.check(
      'but the account itself still works — its password survived',
      (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'finance', password: 'FinanceOwn-22!' })).status === 200
    );

    /* ---------------------------------------------------------------- *
     * And the restored database is a working one, not a museum piece
     * ---------------------------------------------------------------- */

    const next = await recordAndConfirmPayment(restored, {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 10000,
      currency: 'JMD',
      payerName: 'Tenant',
      method: 'Cash'
    });
    T.check('a payment can be taken on the restored database', next.status === 200);
    T.check(
      'and the receipt counter carries on rather than reissuing a used number',
      !!next.body?.payment?.receiptNo && next.body.payment.receiptNo !== receiptNo,
      `${receiptNo} then ${next.body?.payment?.receiptNo}`
    );
    T.check(
      'posting the already-billed month raises nothing new',
      (await restored.post('/api/charges/post-month', { monthString: '2026-07' })).body?.created === 0
    );

    return T.done();
  } finally {
    await srv.stop();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
