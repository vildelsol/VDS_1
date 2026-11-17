/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 1: the restored system must be consistent and reconcilable.
 *
 * Builds a realistic property through the API, takes a backup, keeps working
 * (more receipts, a void, new settings, a password change, a new member of staff,
 * an Idempotency-Key request), restores the OLDER backup, then recomputes every
 * account balance from raw rows and compares with the application's own rules.
 * Also asks: do receipt numbers issued after the backup get reused, is the audit
 * trail of the lost days kept, do accounts/passwords/backup settings survive, and
 * does a replayed request report success for a payment that no longer exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';
import { buildDataset, bundleFinance, rawBalances, mapStr } from './recovery-lib.mjs';

export const title = 'Recovery: restore consistency';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rec1-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rec1w-'));
  let srv = await startServer({ port, adminPassword: 'Recov-1234!', projectRoot, dataDir });
  try {
    const fin = await bundleFinance(projectRoot, work);
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Recov-1234!', 'RecovNew-9876!');
    const built = await buildDataset(admin);
    T.check('dataset built: void, refund and expenses all accepted', built.voidStatus === 200 && built.refundStatus === 200 && built.expenseStatus.every(s => s === 200), JSON.stringify(built));
    await admin.post('/api/users', { name: 'Fin', username: 'fin', role: 'FINANCE_OFFICER', password: 'FinPass-1111!' });
    const before = (await admin.get('/api/db')).body;
    const rawBefore = rawBalances(before);

    const run1 = await admin.post('/api/backup/run', {});
    const backupFile = `db-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}.json`;
    T.check('a manual backup is written', run1.status === 200 && fs.existsSync(path.join(dataDir, 'db-backups', backupFile)), String(run1.status));
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'db-backups', backupFile), 'utf8'));

    /* ---- keep working after the backup ---- */
    const lateReceipts = [];
    for (let i = 0; i < 3; i++) {
      const r = await recordAndConfirmPayment(admin, { unitId: 'unit-3', category: 'Maintenance', amount: 1000 + i, currency: 'JMD', date: '2026-09-0' + (i + 1), payerName: 'Late', method: 'Cash', advancePayment: true });
      if (r.body?.payment?.receiptNo) lateReceipts.push(r.body.payment.receiptNo);
    }
    T.check('three receipts issued after the backup', lateReceipts.length === 3, JSON.stringify(lateReceipts));
    await admin.post('/api/charges/post-month', { monthString: '2026-10' });
    const idemBody = { unitId: 'unit-1', category: 'Rent', amount: 777, currency: 'JMD', date: '2026-10-02', payerName: 'Idem', method: 'Cash', advancePayment: true };
    const idem1 = await admin.call('POST', '/api/payments', idemBody, { headers: { 'Idempotency-Key': 'key-after-backup-1' } });
    const idemId = idem1.body?.payment?.id;
    T.check('an Idempotency-Key payment is accepted after the backup', idem1.status === 200 && !!idemId, String(idem1.status));
    await admin.post('/api/settings', { trn: 'TRN-AFTER-BACKUP', fxRateJmdPerUsd: 199 });
    await admin.post('/api/users', { name: 'Late Joiner', username: 'late', role: 'FINANCE_OFFICER', password: 'LatePass-1111!' });
    const finUser = (await admin.get('/api/db')).body.users.find(u => u.username === 'fin');
    await admin.post(`/api/users/${finUser.id}/reset-password`, { password: 'FinReset-2222!' });
    const after = (await admin.get('/api/db')).body;
    T.check('post-backup password reset accepted', (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'fin', password: 'FinReset-2222!' })).status === 200);
    const maxReceiptEver = Math.max(...after.payments.map(p => Number(/(\d+)$/.exec(p.receiptNo || '')?.[1] || 0)));

    /* ---- restore the older backup ---- */
    const dry = await admin.post('/api/backup/restore', { source: 'backup', file: backupFile, location: 'local', dryRun: true });
    T.check('dry run reports the file without changing anything', dry.status === 200 && dry.body?.dryRun === true && (await admin.get('/api/db')).body.payments.length === after.payments.length);
    const res = await admin.post('/api/backup/restore', { source: 'backup', file: backupFile, location: 'local', confirm: 'RESTORE' });
    T.check('restore succeeds', res.status === 200 && res.body?.success === true, JSON.stringify(res.body).slice(0, 300));
    T.check('restore reports the integrity of what it restored as clean', res.body?.integrity?.ok === true, JSON.stringify(res.body?.integrity));
    const now = (await admin.get('/api/db')).body;

    for (const t of ['units', 'charges', 'payments', 'expenses', 'tenancies', 'ownerships', 'bookings', 'utilities', 'recurringExpenses', 'unitActivities']) {
      T.check(`restored ${t} equal the backup's rows exactly`, JSON.stringify(now[t]) === JSON.stringify(file[t] ?? []), `${now[t].length} vs ${(file[t] || []).length}`);
    }
    // 1. independent recompute versus raw backup rows
    T.check('independent balances from raw rows equal those before the post-backup work', mapStr(rawBalances(now)) === mapStr(rawBefore), mapStr(rawBalances(now)) + ' vs ' + mapStr(rawBefore));
    // 2. the application's own rule (the one every statement uses) agrees with the raw recompute
    const diffs = [];
    const raw = rawBalances(now);
    for (const u of now.units) for (const cat of ['Rent', 'Maintenance']) {
      const b = fin.accountBalance(u, cat, now.charges, now.payments, undefined, now.units);
      const key = `${u.id}|${cat}|${fin.chargeCurrency(u, cat)}`;
      const mine = (raw.get(key) || 0) / 100;
      if (Math.abs(b.balance - mine) > 0.005) diffs.push(`${u.number}/${cat}: app ${b.balance} raw ${mine}`);
    }
    T.check('every account balance the application shows reconciles to the raw rows', diffs.length === 0, diffs.join('; '));
    const integ = (await admin.get('/api/integrity')).body;
    T.check('integrity endpoint is clean after restore', integ.ok === true, JSON.stringify(integ.findings).slice(0, 300));
    const ptot = now.payments.filter(p => p.status === 'completed').reduce((t, p) => t + (p.currency === 'JMD' ? p.amount - (p.refundedAmount || 0) : 0), 0);
    const ctot = now.payments.filter(p => p.status === 'completed').length;
    T.check('the voided receipt is still void and the refund still recorded (backup was taken after both)', now.payments.filter(p => p.status === 'reversed').length === 1 && now.payments.some(p => p.refundedAmount === 5000), `${ptot} ${ctot}`);

    // 3. receipt numbers
    const next = await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Rent', amount: 123, currency: 'JMD', date: '2026-10-05', payerName: 'Post', method: 'Cash', advancePayment: true });
    const nextNo = next.body?.payment?.receiptNo;
    T.check('first receipt after restore is issued', next.status === 200 && !!nextNo, String(next.status));
    T.check(`receipt number after restore (${nextNo}) does not reuse a number already given out before it (${lateReceipts.join(',')})`, !lateReceipts.includes(nextNo), `max ever issued was ${maxReceiptEver}`);
    const dupNos = (await admin.get('/api/db')).body.payments.map(p => p.receiptNo).filter(Boolean);
    T.check('no two receipts in the restored system share a number', new Set(dupNos).size === dupNos.length);

    // 4. accounts survive
    const users = now.users.map(u => u.username).sort().join(',');
    T.check('staff added after the backup are still there (accounts never replaced)', users.includes('late') && users.includes('fin'), users);
    const finLoginOld = await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'fin', password: 'FinPass-1111!' });
    const finLoginNew = await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'fin', password: 'FinReset-2222!' });
    T.check('post-backup password still works and the backed-up one does not', finLoginNew.status === 200 && finLoginOld.status !== 200, `${finLoginNew.status}/${finLoginOld.status}`);
    T.check('the signed-in administrator stays signed in', (await admin.get('/api/auth/me')).status === 200);
    // settings: records are restored, settings other than backup location are replaced by the backup's
    T.check('settings changed after the backup (TRN, FX rate) are not silently reverted by a records restore', now.settings.trn === 'TRN-AFTER-BACKUP' && now.settings.fxRateJmdPerUsd === 199, `trn="${now.settings.trn}" fx=${now.settings.fxRateJmdPerUsd}`);
    T.check('backup location settings are kept', now.settings.backupDir === (before.settings.backupDir ?? '') || now.settings.backupDir === undefined);

    // 5. audit trail
    const restoredAudit = now.auditLogs.some(a => a.action === 'Restored the records from a backup');
    // 2026-11-16: the trail is history and is never rolled back. Every entry that existed before the restore is still there.
    const auditBefore = after.auditLogs.map(a => a.id);
    const kept = auditBefore.every(id => now.auditLogs.some(a => a.id === id));
    T.check('restore itself is audited', restoredAudit);
    T.check('audit entries for the days that were rolled back are not erased from the live audit trail', kept, 'audit trail was replaced by the backup\'s; only the db-before-restore copy has the rolled-back history');
    const safety = fs.readdirSync(path.join(dataDir, 'db-before-restore'));
    const safe = JSON.parse(fs.readFileSync(path.join(dataDir, 'db-before-restore', safety[0]), 'utf8'));
    T.check('the pre-restore safety copy holds every post-backup receipt', lateReceipts.every(n => safe.payments.some(p => p.receiptNo === n)));

    // 6. idempotency replay after restore: a success for a record that is gone
    // The remembered answer was dropped with the restore, so the retry is a fresh request: it must either be
    // refused or create a payment that REALLY exists. It must never be answered from memory with a payment that is gone.
    const replay = await admin.call('POST', '/api/payments', idemBody, { headers: { 'Idempotency-Key': 'key-after-backup-1' } });
    const dbAfterReplay = (await admin.get('/api/db')).body;
    const replayedId = replay.body?.payment?.id;
    const replayedExists = !!replayedId && dbAfterReplay.payments.some(p => p.id === replayedId);
    T.check('replaying a pre-restore Idempotency-Key never reports success for a payment that does not exist', replay.status !== 200 || replayedExists, `replay=${replay.status} id=${replayedId} exists=${replayedExists}`);
    T.check('and the old answer was not replayed from memory', replayedId !== idemId, `id ${replayedId}`);

    // 7. everything is on disk: clean restart
    await srv.stop();
    srv = await startServer({ port, adminPassword: 'Recov-1234!', projectRoot, dataDir });
    const re = makeClient(srv.baseUrl);
    await re.post('/api/auth/login', { username: 'admin', password: 'RecovNew-9876!' }, { captureCookie: true });
    const reDb = (await re.get('/api/db')).body;
    T.check('restored state survives a clean restart', reDb.payments.length === dbAfterReplay.payments.length && mapStr(rawBalances(reDb)) !== '', `${reDb.payments.length}`);
    T.check('integrity still clean after restart', (await re.get('/api/integrity')).body.ok === true);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
  return T.done();
}
