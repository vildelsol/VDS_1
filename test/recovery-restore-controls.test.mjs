/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 1b: what an OLDER backup does to controls and to voided money.
 *
 * A restore replaces the records. The brief is that it never replaces accounts or
 * the backup settings. This asks whether the controls that protect the books
 * (a closed period, the role permission matrix, the two-person rule) survive going
 * back in time, and what the restore tells the administrator about money that
 * comes back to life (a voided receipt, a refund).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';
import { buildDataset, todayStamp } from './recovery-lib.mjs';

export const title = 'Recovery: older backup and controls';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-rec1b-'));
  const srv = await startServer({ port, adminPassword: 'Recov-1234!', projectRoot, dataDir });
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Recov-1234!', 'RecovNew-9876!');
    // An OLD backup: only units configured and one month charged.
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'O', tenantName: 'T', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    await admin.post('/api/charges/post-month', { monthString: '2026-05' });
    await admin.post('/api/backup/run', {});
    const f = `db-${todayStamp()}.json`;

    // Work after the old backup: the full dataset, then controls.
    const built = await buildDataset(admin);
    const closed = await admin.post('/api/periods/close', { through: '2026-09' });
    const perms = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: false, addBookings: true } }, requireCosign: true });
    T.check('setup: period closed through 2026-09, junior receipts withdrawn, two-person rule on', closed.status === 200 && perms.status === 200 && built.voidStatus === 200, `${closed.status} ${perms.status}`);
    const live = (await admin.get('/api/db')).body;
    T.check('setup: closedThrough set', live.settings.closedThrough === '2026-09', String(live.settings.closedThrough));

    // Safety: a restore dry-run must say what is about to be lost.
    const dry = await admin.post('/api/backup/restore', { source: 'backup', file: f, location: 'local', dryRun: true });
    T.check('dry run tells the administrator the present records are larger than the file (what would be lost)', dry.status === 200 && dry.body?.present?.payments > dry.body?.summary?.counts?.payments, JSON.stringify({ present: dry.body?.present, counts: dry.body?.summary?.counts }));
    T.check('dry run warns that a closed period / permissions will be rolled back', JSON.stringify(dry.body).match(/closed|permission/i) !== null, 'no such warning in the dry-run response');

    const res = await admin.post('/api/backup/restore', { source: 'backup', file: f, location: 'local', confirm: 'RESTORE' });
    T.check('older backup restores', res.status === 200, JSON.stringify(res.body).slice(0, 200));
    const now = (await admin.get('/api/db')).body;
    T.check('the books stay closed through 2026-09 after a restore (a closed month cannot be reopened by going back in time)', now.settings.closedThrough === '2026-09', `closedThrough=${now.settings.closedThrough}`);
    T.check('the role permission matrix is not rolled back by a records restore (staff permissions are account policy)', now.settings.rolePermissions?.JUNIOR_OFFICER?.recordPayments === false, `recordPayments=${now.settings.rolePermissions?.JUNIOR_OFFICER?.recordPayments}`);
    T.check('the two-person approval rule is not switched off by a restore', now.settings.requireCosign === true, `requireCosign=${now.settings.requireCosign}`);
    T.check('voided receipt from after the old backup is gone with the rest of that period (expected: records go back in time)', now.payments.length === 0, String(now.payments.length));
    T.check('restore response itself reports the closed-month contradiction it just created (positive control)', res.body?.integrity?.ok === false && res.body.integrity.findings.some(x => x.code === 'closed-period-changed'), JSON.stringify(res.body?.integrity).slice(0, 200));

    // Phase 2: a backup that records a SHORTER closed period than the live books.
    await admin.post('/api/backup/run', {});
    const closed2 = await admin.post('/api/periods/close', { through: '2026-10', confirmWithFaults: true });
    T.check('setup: closed further, through 2026-10', closed2.status === 200 && (await admin.get('/api/db')).body.settings.closedThrough === '2026-10', String(closed2.status));
    const res2 = await admin.post('/api/backup/restore', { source: 'backup', file: f, location: 'local', confirm: 'RESTORE' });
    const after2 = (await admin.get('/api/db')).body;
    T.check('restoring a backup that closed fewer months does not silently reopen 2026-10', res2.status !== 200 || after2.settings.closedThrough === '2026-10', `closedThrough=${after2.settings.closedThrough}`);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
