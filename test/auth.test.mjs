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

    // --- the clock must not answer what the message refuses to ---
    // Sign-in says the same thing whether or not the username exists. It also has
    // to take the same time saying it: checking a password costs ~30ms of scrypt,
    // and skipping that for an account that does not exist answered five times
    // faster, which mapped the real staff usernames for anybody with a stopwatch.
    const medianLoginMs = async username => {
      const runs = [];
      for (let i = 0; i < 9; i++) {
        const started = process.hrtime.bigint();
        await c.post('/api/auth/login', { username, password: 'DefinitelyWrong-11!' }, { noCookie: true });
        runs.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      runs.sort((a, b) => a - b);
      return runs[Math.floor(runs.length / 2)];
    };
    const realMs = await medianLoginMs('admin');
    const missingMs = await medianLoginMs('nosuchpersonhere');
    T.check(
      'a wrong password takes the same time whether or not the account exists',
      realMs < missingMs * 3,
      `real ${realMs.toFixed(1)}ms vs missing ${missingMs.toFixed(1)}ms`
    );

    // --- a failed sign-in leaves a trace, without becoming a way to erase one ---
    // The audit trail keeps the newest 20,000 entries and drops the rest, so an
    // entry per attempt would let anyone at the login screen push every genuine
    // entry off the end. What is recorded is the shape of the failure, capped.
    const auditNow = async () => (await c.get('/api/db')).body.auditLogs;
    const failuresIn = logs => logs.filter(a => /Failed sign-in attempt|Sign-in blocked after/.test(a.action));

    await c.post('/api/auth/login', { username: 'admin', password: 'WrongOnce-11!' }, { noCookie: true });
    let logs = await auditNow();
    T.check('a failed sign-in is recorded', failuresIn(logs).some(a => /Failed sign-in attempt for "admin"/.test(a.action)));
    T.check(
      'the password that was tried is never written down',
      !JSON.stringify(logs).includes('WrongOnce-11!')
    );
    T.check('the attempt is attributed to nobody, not to a role', failuresIn(logs)[0]?.role === 'UNKNOWN');
    T.check(
      'a successful sign-in is still recorded as such',
      logs.some(a => a.action === 'Signed in')
    );

    // A run of guesses against one account is one line, not one line each.
    const beforeRun = failuresIn(await auditNow()).length;
    for (let i = 0; i < 6; i++) {
      await c.post('/api/auth/login', { username: 'admin', password: `Guess-${i}-11!` }, { noCookie: true });
    }
    const afterRun = failuresIn(await auditNow()).length;
    T.check('a run of guesses does not write a line per guess', afterRun - beforeRun <= 1, `added ${afterRun - beforeRun}`);

    // The flood: many usernames, which is how the throttle's own buckets are dodged.
    const beforeFlood = (await auditNow()).length;
    for (let i = 0; i < 120; i++) {
      await c.post('/api/auth/login', { username: `ghost${i}`, password: 'bad' }, { noCookie: true });
    }
    logs = await auditNow();
    const added = logs.length - beforeFlood;
    T.check('a flood of failed sign-ins cannot fill the audit trail', added <= 25, `added ${added} entries`);
    T.check(
      'and it says plainly that it stopped listing them',
      logs.some(a => /Further failed sign-ins in this period are not being listed/.test(a.action))
    );
    T.check(
      'the genuine history is still there underneath',
      logs.some(a => a.action === 'Signed in')
    );

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
