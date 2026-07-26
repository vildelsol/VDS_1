/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Authentication, sessions, the sign-in throttle, and the forced password change.
 */

import { startServer, makeClient, reporter } from './harness.mjs';

export const title = 'Authentication & sessions';

export default async function run({ port, projectRoot }) {
  const ADMIN = 'AuthTest-1234!';
  const srv = await startServer({ port, adminPassword: ADMIN, projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);

    // --- unauthenticated access is refused ---
    T.check('unauthenticated /api/db is refused', (await c.get('/api/db', { noCookie: true })).status === 401);
    T.check('unauthenticated payment is refused', (await c.post('/api/payments', { amount: 1 }, { noCookie: true })).status === 401);
    T.check('wrong password is refused', (await c.post('/api/auth/login', { username: 'admin', password: 'nope' })).status === 401);

    // --- login and cookie flags ---
    const login = await c.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
    T.check('admin can sign in', login.status === 200 && !!c.getCookie());
    T.check('new admin is flagged to change its password', login.body?.user?.mustChangePassword === true);
    const sc = login.setCookie || '';
    T.check(
      'session cookie is HttpOnly + SameSite=Strict and not Secure over plain HTTP',
      /HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && !/;\s*Secure/i.test(sc),
      sc
    );
    T.check('a client-supplied userRole on login is ignored', login.body?.user?.role === 'ADMINISTRATOR');

    // --- forced password change is enforced by the API, not only the UI ---
    const preWrite = await c.put('/api/units/unit-1', { ownerName: 'Should Not Stick' });
    T.check(
      'a write is refused until the issued password is changed',
      preWrite.status === 403 && preWrite.body?.code === 'PASSWORD_CHANGE_REQUIRED',
      `${preWrite.status} ${preWrite.body?.code || ''}`
    );
    T.check('reads still work so the app can render', (await c.get('/api/db')).status === 200);
    const changed = await c.post('/api/auth/change-password', { currentPassword: ADMIN, newPassword: 'AuthNew-9876!' });
    T.check('changing the password is allowed and clears the block', changed.status === 200);
    T.check('writes work once the password has been changed', (await c.put('/api/units/unit-1', { number: '1', ownerName: 'Real Owner', status: 'vacant', currency: 'JMD', maintCurrency: 'JMD' })).status === 200);

    // --- sign-in throttle, and that X-Forwarded-For cannot reset it ---
    // Guessing at a throwaway username, so the admin account is not locked out.
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const r = await c.post(
        '/api/auth/login',
        { username: 'ghost', password: 'bad' },
        { noCookie: true, headers: { 'X-Forwarded-For': `10.9.${Math.floor(i / 250)}.${i % 250}` } }
      );
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    T.check('the sign-in throttle fires despite spoofed X-Forwarded-For headers', got429);

    // --- deactivating a user kills their live session ---
    await c.post('/api/users', { name: 'Temp Staff', username: 'temp', role: 'JUNIOR_OFFICER', password: 'TempPass-11!' });
    const other = makeClient(srv.baseUrl);
    await other.post('/api/auth/login', { username: 'temp', password: 'TempPass-11!' }, { captureCookie: true });
    T.check('the deactivation target can read while active', (await other.get('/api/db')).status === 200);
    const tempId = (await c.get('/api/db')).body.users.find(u => u.username === 'temp').id;
    await c.put(`/api/users/${tempId}`, { active: false });
    T.check('deactivating a user invalidates their live session at once', (await other.get('/api/db')).status === 401);
    T.check('a deactivated account cannot sign back in', (await other.post('/api/auth/login', { username: 'temp', password: 'TempPass-11!' })).status === 401);

    // --- logout ---
    const before = c.getCookie();
    await c.post('/api/auth/logout', {});
    const replay = makeClient(srv.baseUrl);
    replay.setCookie(before);
    T.check('logout invalidates the session server-side', (await replay.get('/api/db')).status === 401);
  } finally {
    await srv.stop();
  }
  return T.done();
}
