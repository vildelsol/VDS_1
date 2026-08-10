/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Staff accounts, session integrity and the records export.
 *
 * Three things that were reasoned about but never held to a test:
 *
 *  - **Who may manage staff.** Creating an account, changing a role and resetting
 *    a password are administrator-only. A Manager who could reset the
 *    administrator's password would own the machine, so the gate is checked from
 *    the outside rather than trusted from reading the matrix.
 *  - **Session tokens.** A cookie is the only thing standing between a stranger
 *    on the LAN and the whole ledger. A made-up token must not work, an expired
 *    one must not work, and a reset must revoke the ones already out there.
 *  - **The export.** The snapshot is the copy that deliberately leaves the
 *    machine. If password material ever leaked into it, every backup on every
 *    USB stick becomes a set of credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Staff accounts, sessions & export';

/** Sign a newly created account in and clear the password it was handed. */
async function activate(baseUrl, username, issued, chosen) {
  const c = makeClient(baseUrl);
  await c.post('/api/auth/login', { username, password: issued }, { captureCookie: true });
  await c.post('/api/auth/change-password', { currentPassword: issued, newPassword: chosen });
  return c;
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-staff-'));
  let srv = await startServer({ port, adminPassword: 'StaffTest-1234!', projectRoot, dataDir });

  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'StaffTest-1234!', 'StaffAdmin-9876!');

    await admin.post('/api/users', { name: 'Manny Manager', username: 'manager', role: 'MANAGER', password: 'ManagerPass-11!' });
    await admin.post('/api/users', { name: 'Fin Officer', username: 'finance', role: 'FINANCE_OFFICER', password: 'FinancePass-11!' });
    const manager = await activate(srv.baseUrl, 'manager', 'ManagerPass-11!', 'ManagerOwn-22!');
    const finance = await activate(srv.baseUrl, 'finance', 'FinancePass-11!', 'FinanceOwn-22!');

    const adminId = (await admin.get('/api/db')).body.users.find(u => u.username === 'admin').id;
    const managerId = (await admin.get('/api/db')).body.users.find(u => u.username === 'manager').id;

    /* ---------------------------------------------------------------- *
     * Managing staff is administrators only
     * ---------------------------------------------------------------- */

    T.check(
      'a manager cannot create a staff account',
      (await manager.post('/api/users', { name: 'X', username: 'x', role: 'JUNIOR_OFFICER', password: 'Sneaky-1111!' })).status === 403
    );
    T.check(
      'a finance officer cannot create a staff account',
      (await finance.post('/api/users', { name: 'Y', username: 'y', role: 'JUNIOR_OFFICER', password: 'Sneaky-1111!' })).status === 403
    );

    // The escalation that matters: promoting yourself, or seizing the admin account.
    T.check(
      'a manager cannot promote themselves to Administrator',
      (await manager.put(`/api/users/${managerId}`, { role: 'ADMINISTRATOR' })).status === 403
    );
    T.check(
      'a manager cannot reset the administrator password',
      (await manager.post(`/api/users/${adminId}/reset-password`, { password: 'Seized-1234!' })).status === 403
    );
    T.check(
      'a manager cannot deactivate the administrator',
      (await manager.put(`/api/users/${adminId}`, { active: false })).status === 403
    );
    T.check(
      'and none of it took effect — the administrator still holds the role',
      (await admin.get('/api/db')).body.users.find(u => u.id === adminId).role === 'ADMINISTRATOR'
    );
    T.check(
      'the manager is still a manager',
      (await admin.get('/api/db')).body.users.find(u => u.id === managerId).role === 'MANAGER'
    );

    /* ---------------------------------------------------------------- *
     * The last administrator cannot be removed
     * ---------------------------------------------------------------- */

    T.check(
      'the only administrator cannot be demoted',
      (await admin.put(`/api/users/${adminId}`, { role: 'MANAGER' })).status === 400
    );
    T.check(
      'the only administrator cannot be deactivated',
      (await admin.put(`/api/users/${adminId}`, { active: false })).status === 400
    );
    const afterLastAdmin = (await admin.get('/api/db')).body.users.find(u => u.id === adminId);
    T.check('a refused demotion left the role untouched', afterLastAdmin.role === 'ADMINISTRATOR');
    T.check('a refused deactivation left the account active', afterLastAdmin.active === true);
    T.check('and the administrator can still work', (await admin.get('/api/db')).status === 200);

    // With a second administrator, demoting the first is legitimate and allowed.
    await admin.post('/api/users', { name: 'Second Admin', username: 'admin2', role: 'ADMINISTRATOR', password: 'SecondAdmin-11!' });
    const admin2Id = (await admin.get('/api/db')).body.users.find(u => u.username === 'admin2').id;
    T.check(
      'a second administrator can be demoted once another one exists',
      (await admin.put(`/api/users/${admin2Id}`, { role: 'MANAGER' })).status === 200
    );
    await admin.put(`/api/users/${admin2Id}`, { role: 'ADMINISTRATOR' });

    /* ---------------------------------------------------------------- *
     * Account creation refuses what it should
     * ---------------------------------------------------------------- */

    T.check(
      'a weak password is refused when creating an account',
      (await admin.post('/api/users', { name: 'Weak', username: 'weak', role: 'JUNIOR_OFFICER', password: 'abc' })).status === 400
    );
    T.check(
      'a duplicate username is refused',
      (await admin.post('/api/users', { name: 'Clash', username: 'manager', role: 'JUNIOR_OFFICER', password: 'Clashing-11!' })).status === 400
    );
    T.check(
      'a duplicate username is refused regardless of case',
      (await admin.post('/api/users', { name: 'Clash', username: 'MANAGER', role: 'JUNIOR_OFFICER', password: 'Clashing-11!' })).status === 400
    );
    T.check(
      'a username with illegal characters is refused',
      (await admin.post('/api/users', { name: 'Odd', username: 'ad min;drop', role: 'JUNIOR_OFFICER', password: 'Odd-111111!' })).status === 400
    );
    T.check(
      'an unknown role is refused',
      (await admin.post('/api/users', { name: 'Ghost', username: 'ghost', role: 'SUPERUSER', password: 'Ghostly-11!' })).status === 400
    );

    // Mass assignment: fields the client is not entitled to set must be ignored.
    await admin.post('/api/users', {
      name: 'Smuggler',
      username: 'smuggler',
      role: 'JUNIOR_OFFICER',
      password: 'Smuggled-11!',
      id: 'user-forged',
      active: true,
      mustChangePassword: false,
      passwordHash: 'forged',
      passwordSalt: 'forged'
    });
    const smuggler = (await admin.get('/api/db')).body.users.find(u => u.username === 'smuggler');
    T.check('a client-supplied account id is ignored', !!smuggler && smuggler.id !== 'user-forged');
    T.check('a client cannot waive its own forced password change', smuggler.mustChangePassword === true);
    T.check(
      'a smuggled password hash does not become the password',
      (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'smuggler', password: 'forged' })).status === 401
    );

    /* ---------------------------------------------------------------- *
     * Session integrity
     * ---------------------------------------------------------------- */

    T.check('/api/auth/me is refused without a session', (await admin.get('/api/auth/me', { noCookie: true })).status === 401);

    const me = await admin.get('/api/auth/me');
    T.check('/api/auth/me identifies the signed-in user', me.status === 200 && me.body?.user?.username === 'admin');
    T.check('/api/auth/me carries no password material', !JSON.stringify(me.body).match(/passwordHash|passwordSalt/i));
    T.check('the staff list carries no password material', !JSON.stringify((await admin.get('/api/db')).body.users).match(/passwordHash|passwordSalt/i));

    const forged = makeClient(srv.baseUrl);
    forged.setCookie('vds_session=' + 'a'.repeat(64));
    T.check('a made-up session token is refused', (await forged.get('/api/db')).status === 401);
    T.check('a made-up session token cannot write either', (await forged.post('/api/payments', { unitId: 'unit-1', amount: 1 })).status === 401);

    // A reset must revoke sessions that are already out there.
    T.check('the finance officer has a live session', (await finance.get('/api/db')).status === 200);
    const reset = await admin.post(`/api/users/${(await admin.get('/api/db')).body.users.find(u => u.username === 'finance').id}/reset-password`, {
      password: 'Reissued-1234!'
    });
    T.check('an administrator can reset a staff password', reset.status === 200);
    T.check('the reset kills the live session immediately', (await finance.get('/api/db')).status === 401);
    T.check('the old password no longer works', (await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'finance', password: 'FinanceOwn-22!' })).status === 401);
    const reissued = makeClient(srv.baseUrl);
    const back = await reissued.post('/api/auth/login', { username: 'finance', password: 'Reissued-1234!' }, { captureCookie: true });
    T.check('the reissued password works', back.status === 200);
    T.check('and the account is forced to choose a new one', back.body?.user?.mustChangePassword === true);
    T.check(
      'a reset account cannot record anything until it chooses a password',
      (await reissued.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 100, currency: 'JMD', payerName: 'P', method: 'Cash' })).status === 403
    );
    T.check(
      'a weak reissued password is refused',
      (await admin.post(`/api/users/${managerId}/reset-password`, { password: 'short' })).status === 400
    );
    T.check(
      'resetting an account that does not exist is a 404, not a 500',
      (await admin.post('/api/users/user-nonexistent/reset-password', { password: 'Whatever-1234!' })).status === 404
    );
    T.check(
      'the reset is on the audit trail',
      (await admin.get('/api/db')).body.auditLogs.some(a => /Reset the password for "finance"/.test(a.action))
    );

    /* ---------------------------------------------------------------- *
     * The records export
     * ---------------------------------------------------------------- */

    // Managers are settings-holders by design, so the meaningful denial is a
    // junior officer: the whole ledger in one file is not a desk-clerk errand.
    const junior = await activate(srv.baseUrl, 'smuggler', 'Smuggled-11!', 'JuniorOwn-22!');
    T.check('a junior officer cannot download the records snapshot', (await junior.get('/api/backup/download')).status === 403);
    T.check('a junior officer cannot see the backup status either', (await junior.get('/api/backup/status')).status === 403);
    T.check('a manager may download it — settings are theirs by design', (await manager.get('/api/backup/download')).status === 200);

    const dump = await admin.get('/api/backup/download');
    T.check('an administrator can download the records snapshot', dump.status === 200);
    T.check('the snapshot is a parseable document', !!dump.body && Array.isArray(dump.body.units));
    T.check('no password hash reaches the exported file', !/passwordHash/i.test(dump.text));
    T.check('no password salt reaches the exported file', !/passwordSalt/i.test(dump.text));
    T.check('no live session token reaches the exported file', dump.body.sessions === undefined);
    T.check(
      'the exported staff list is limited to who they are, not how they sign in',
      dump.body.users.every(u => Object.keys(u).sort().join(',') === 'active,id,name,role,username')
    );
    T.check('the export is on the audit trail', (await admin.get('/api/db')).body.auditLogs.some(a => /Downloaded a records snapshot/.test(a.action)));

    /* ---------------------------------------------------------------- *
     * An expired session is refused after a restart
     * ---------------------------------------------------------------- */

    const expiring = makeClient(srv.baseUrl);
    await expiring.post('/api/auth/login', { username: 'manager', password: 'ManagerOwn-22!' }, { captureCookie: true });
    const expiredCookie = expiring.getCookie();
    T.check('the session works before it expires', (await expiring.get('/api/db')).status === 200);

    await srv.stop();

    // Age the session past its expiry on disk, exactly as twelve hours would.
    const dbPath = path.join(dataDir, 'db.json');
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const token = expiredCookie.split('=')[1];
    const stored = onDisk.sessions.find(s => s.token === token);
    T.check('the session was persisted to disk', !!stored);
    stored.expiresAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(onDisk, null, 2));

    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    const stale = makeClient(srv.baseUrl);
    stale.setCookie(expiredCookie);
    T.check('an expired session is refused', (await stale.get('/api/db')).status === 401);
    T.check('an expired session cannot write', (await stale.post('/api/charges/post-month', { monthString: '2026-07' })).status === 401);
    T.check(
      'signing in again issues a working session',
      (await (async () => {
        const fresh = makeClient(srv.baseUrl);
        await fresh.post('/api/auth/login', { username: 'manager', password: 'ManagerOwn-22!' }, { captureCookie: true });
        return fresh.get('/api/db');
      })()).status === 200
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
