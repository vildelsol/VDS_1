/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Taking a backup is a permission of its own (Ro, 2026-11-13).
 *
 * A junior officer could not save a backup because every backup route was gated
 * as "change system settings". `takeBackups` now covers taking a copy, reading
 * the backup status and downloading a snapshot, and can be given to any role.
 * It does NOT cover choosing the backup folder (settings managers) or restoring
 * (administrator only). Every denial below is paired with a positive control so
 * a test that merely sees "403" for the wrong reason cannot pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Backup permission: taking a backup is its own grantable right';

async function signedIn(baseUrl, admin, username, role) {
  const pw = `Pw-${username}-1234!`;
  await admin.post('/api/users', { name: username, username, role, password: pw });
  const c = makeClient(baseUrl);
  await c.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
  await c.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
  return c;
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Bk-1234!', projectRoot });
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Bk-1234!', 'BkNew-9876!');
    const mgr = await signedIn(srv.baseUrl, admin, 'mgr', 'MANAGER');
    const fin = await signedIn(srv.baseUrl, admin, 'fin', 'FINANCE_OFFICER');
    const jr = await signedIn(srv.baseUrl, admin, 'jr', 'JUNIOR_OFFICER');
    const users = (await admin.get('/api/db')).body.users;
    const jrId = users.find(u => u.username === 'jr').id;
    const adminId = users.find(u => u.username === 'admin').id;

    const backupCalls = c => [c.get('/api/backup/status'), c.post('/api/backup/run', {}), c.get('/api/backup/download')];

    /* ---- defaults ---- */
    T.check('control: the administrator can take, read and download backups', (await Promise.all(backupCalls(admin))).every(r => r.status === 200));
    T.check('a manager can by default (as before the permission existed)', (await Promise.all(backupCalls(mgr))).every(r => r.status === 200));
    for (const [name, c] of [['junior', jr], ['finance officer', fin]]) {
      const rs = await Promise.all(backupCalls(c));
      T.check(`a ${name} is refused status, run and download by default`, rs.every(r => r.status === 403), rs.map(r => r.status).join(','));
    }
    T.check('the junior\'s session reports takeBackups false', (await jr.get('/api/db')).body?.currentUser?.permissions?.takeBackups === false);

    /* ---- grant ---- */
    const grant = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true, addBookings: true, takeBackups: true } } });
    T.check('the administrator can grant it to the junior role', grant.body?.settings?.rolePermissions?.JUNIOR_OFFICER?.takeBackups === true, JSON.stringify(grant.body)?.slice(0, 120));
    T.check('it reaches the junior with no re-login', (await jr.get('/api/db')).body?.currentUser?.permissions?.takeBackups === true);
    const status = await jr.get('/api/backup/status');
    const runRes = await jr.post('/api/backup/run', {});
    const dl = await jr.get('/api/backup/download');
    T.check('the granted junior can read status, take a backup and download a snapshot', [status, runRes, dl].every(r => r.status === 200), [status, runRes, dl].map(r => r.status).join(','));
    T.check('the finance officer is still refused (grant was for the junior role only)', (await fin.get('/api/backup/status')).status === 403);
    T.check('the download is a snapshot with no password material', dl.status === 200 && !/passwordHash|"salt"|scrypt|\$2[aby]\$|"password"\s*:/i.test(dl.text) && /"payments"/.test(dl.text));

    /* ---- what the grant must NOT open ---- */
    const denied = [
      ['drives', () => jr.get('/api/backup/drives'), () => admin.get('/api/backup/drives')],
      ['check-folder', () => jr.post('/api/backup/check-folder', { dir: '/tmp' }), () => admin.post('/api/backup/check-folder', { dir: '/tmp' })],
      ['restore', () => jr.post('/api/backup/restore', { source: 'snapshot', snapshot: {}, dryRun: true }), () => admin.post('/api/backup/restore', { source: 'snapshot', snapshot: {}, dryRun: true })],
      ['settings', () => jr.post('/api/settings', { requireCosign: true }), () => admin.post('/api/settings', { requireCosign: false })],
      ['create user', () => jr.post('/api/users', { name: 'z', username: 'zz', role: 'JUNIOR_OFFICER', password: 'Sneaky-1111!' }), () => admin.post('/api/users', { name: 'z', username: 'zz', role: 'JUNIOR_OFFICER', password: 'Sneaky-1111!' })]
    ];
    for (const [name, attack, control] of denied) {
      const a = await attack();
      const c = await control();
      T.check(`a backup-granted junior is still refused ${name}`, a.status === 403, `status ${a.status}`);
      T.check(`  control: the administrator is not refused ${name}`, c.status !== 403 && c.status !== 401, `status ${c.status}`);
    }

    /* ---- hostile: self-service escalation ---- */
    const selfGrant = await jr.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { takeBackups: true, reversePayments: true, hasVetoPower: true } } });
    T.check('a junior cannot grant itself more rights', selfGrant.status === 403, `status ${selfGrant.status}`);
    const esc = await jr.put(`/api/users/${jrId}`, { role: 'ADMINISTRATOR' });
    T.check('a junior cannot promote itself to administrator', esc.status === 403, `status ${esc.status}`);
    const seize = await jr.post(`/api/users/${adminId}/reset-password`, { password: 'Seized-1234!' });
    T.check('a junior cannot reset the administrator password', seize.status === 403, `status ${seize.status}`);
    const after = (await admin.get('/api/db')).body;
    T.check('none of it took effect', after.users.find(u => u.id === jrId).role === 'JUNIOR_OFFICER' && after.settings.rolePermissions.JUNIOR_OFFICER.reversePayments !== true && !after.settings.rolePermissions.JUNIOR_OFFICER.hasVetoPower);
    T.check('control: the junior is a junior and the grant is intact', (await jr.get('/api/backup/status')).status === 200);

    /* ---- withdraw ---- */
    await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true, addBookings: true, takeBackups: false } } });
    const rs = await Promise.all(backupCalls(jr));
    T.check('withdrawing it re-denies the junior at once, no re-login', rs.every(r => r.status === 403), rs.map(r => r.status).join(','));
    await admin.post('/api/settings', { rolePermissions: { MANAGER: { recordPayments: true, takeBackups: false } } });
    T.check('a manager with it withdrawn is refused', (await mgr.get('/api/backup/status')).status === 403);
    T.check('control: the administrator is never gated', (await admin.get('/api/backup/status')).status === 200);

    /* ---- upgrade from a database written before the permission existed ---- */
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bk-upgrade-'));
    let upgraded = null;
    try {
      const seed = await startServer({ port: port + 4000, adminPassword: 'Old-1234!', projectRoot, dataDir: oldDir });
      const sc = makeClient(seed.baseUrl);
      await activateAdmin(sc, 'Old-1234!', 'OldNew-9876!');
      await seed.stop();
      const dbPath = path.join(oldDir, 'db.json');
      const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      for (const role of Object.keys(raw.settings.rolePermissions)) delete raw.settings.rolePermissions[role].takeBackups;
      raw.settings.rolePermissions.FINANCE_OFFICER.hasVetoPower = true;
      fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));
      T.check('fixture: an old-shape database carries no takeBackups', raw.settings.rolePermissions.MANAGER.takeBackups === undefined && raw.settings.rolePermissions.JUNIOR_OFFICER.takeBackups === undefined);

      upgraded = await startServer({ port: port + 4001, adminPassword: 'Old-1234!', projectRoot, dataDir: oldDir });
      const ac = makeClient(upgraded.baseUrl);
      await ac.post('/api/auth/login', { username: 'admin', password: 'OldNew-9876!' }, { captureCookie: true });
      const rp = (await ac.get('/api/db')).body?.settings?.rolePermissions;
      T.check('upgrade keeps backups with Managers', rp?.MANAGER?.takeBackups === true, JSON.stringify(rp?.MANAGER));
      T.check('upgrade keeps backups with anyone holding veto power', rp?.FINANCE_OFFICER?.takeBackups === true, JSON.stringify(rp?.FINANCE_OFFICER));
      T.check('control: upgrade does not grant it to the junior role', rp?.JUNIOR_OFFICER?.takeBackups === false, JSON.stringify(rp?.JUNIOR_OFFICER));
    } finally {
      if (upgraded) await upgraded.stop();
      fs.rmSync(oldDir, { recursive: true, force: true });
    }
    // A stale browser tab (a bundle from before takeBackups existed) saves the
    // matrix without the key. It must keep what is stored, not withdraw it.
    {
      await admin.post('/api/settings', { rolePermissions: { MANAGER: { recordPayments: true, takeBackups: true }, JUNIOR_OFFICER: { recordPayments: true, takeBackups: true } } });
      const stale = await admin.post('/api/settings', { rolePermissions: { MANAGER: { recordPayments: true, addBookings: true }, JUNIOR_OFFICER: { recordPayments: true } } });
      const rp = stale.body?.settings?.rolePermissions || (await admin.get('/api/settings')).body?.rolePermissions || {};
      T.check('a save that omits takeBackups keeps it for the Manager', rp.MANAGER?.takeBackups === true, JSON.stringify(rp.MANAGER));
      T.check('...and for the Junior it was granted to', rp.JUNIOR_OFFICER?.takeBackups === true, JSON.stringify(rp.JUNIOR_OFFICER));
      const explicit = await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true, takeBackups: false } } });
      const rp2 = explicit.body?.settings?.rolePermissions || {};
      T.check('control: an explicit false still withdraws it', rp2.JUNIOR_OFFICER?.takeBackups === false, JSON.stringify(rp2.JUNIOR_OFFICER));
    }
    return T.done();
  } finally {
    await srv.stop();
  }
}
