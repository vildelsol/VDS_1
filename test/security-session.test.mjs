/**
 * Sessions, cookies, brute-force throttling, password storage and credential leakage.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { reporter } from './harness.mjs';
import { boot, makeClient, ROLE_PW, ADMIN_PW } from './security-kit.mjs';

export const title = 'Security: sessions, cookies, throttling, credential leakage';

const rawLogin = (baseUrl, username, password, headers = {}) =>
  fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });

/** A risk the owner has been told about and has not yet decided on: reported, never failing the suite. */
const KNOWN = [];
function known(desc, cond, detail) {
  KNOWN.push(desc);
  console.log(`  known-risk (awaiting a decision): ${desc} — ${cond ? 'holds' : 'does NOT hold'}${detail ? ` (${detail})` : ''}`);
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  const { admin, manager, junior, srv } = env;
  const base = srv.baseUrl;
  try {
    /* ---- unauthenticated write amplification: failed-login audit entries ---- */
    const before = JSON.stringify((await admin.get('/api/db')).body.auditLogs).length;
    for (let i = 0; i < 3; i++) await rawLogin(base, 'A'.repeat(400000) + i, 'Wrong-pass-1!A');
    const dbAfter = (await admin.get('/api/db')).body.auditLogs;
    const biggest = Math.max(...dbAfter.map(e => (e.user || '').length));
    T.check('an unauthenticated caller cannot write an arbitrarily long username into the audit log (400KB username x3)', biggest < 1000, `largest audit "user" field is ${biggest} characters; audit payload grew ${JSON.stringify(dbAfter).length - before} bytes from 3 anonymous requests`);

    /* ---- cookie flags ---- */
    const res = await rawLogin(base, 'junior', ROLE_PW.JUNIOR_OFFICER);
    const setCookie = res.headers.get('set-cookie') || '';
    T.check('session cookie is HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
    T.check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(setCookie), setCookie);
    T.check('session cookie has Path=/ and a Max-Age', /Path=\//.test(setCookie) && /Max-Age=\d+/.test(setCookie), setCookie);
    T.check('(info) cookie is not Secure over plain http by default (LAN deployment)', !/Secure/i.test(setCookie), setCookie);
    const token = /vds_session=([0-9a-f]+)/.exec(setCookie)?.[1] || '';
    T.check('token is 256 bits of hex', token.length === 64, `${token.length} chars`);
    const body = await res.json();
    T.check('login response carries no hash, salt or token', !/passwordHash|passwordSalt|token|scrypt/i.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 200));

    /* ---- credential leakage across every GET ---- */
    const leaky = [];
    for (const p of ['/api/db', '/api/auth/me', '/api/integrity', '/api/backup/status', '/api/backup/drives', '/api/backup/download']) {
      for (const [who, c] of [['admin', admin], ['manager', manager]]) {
        const r = await c.get(p);
        if (/passwordHash|passwordSalt|"sessions"|vds_session|"token"/i.test(r.text)) leaky.push(`${who} ${p}`);
        for (const u of (await admin.get('/api/db')).body.users) {
          // a stored salt/hash is 128/32 hex chars; never present in any response
        }
      }
    }
    T.check('no API response contains password hash/salt or session fields', leaky.length === 0, leaky.join('; '));
    const dbJson = fs.readFileSync(path.join(env.dir, 'db.json'), 'utf8');
    const stored = JSON.parse(dbJson);
    const adminRec = stored.users.find(u => u.username === 'admin');
    const hashes = stored.users.map(u => u.passwordHash);
    const salts = stored.users.map(u => u.passwordSalt);
    T.check('stored passwords are scrypt hashes (128 hex) with a 16-byte random salt each', hashes.every(h => /^[0-9a-f]{128}$/.test(h)) && salts.every(s => /^[0-9a-f]{32}$/.test(s)) && new Set(salts).size === salts.length);
    T.check('no plaintext password appears anywhere in db.json', ![ADMIN_PW, ...Object.values(ROLE_PW), 'Issued-1111!aa', 'SecBoot-1234!'].some(pw => dbJson.includes(pw)));
    const all = [];
    for (const f of fs.readdirSync(env.dir, { recursive: true })) all.push(f);
    const mode = fs.statSync(path.join(env.dir, 'db.json')).mode & 0o777;
    T.check('db.json (holds password hashes and live session tokens) is not group/world readable', process.platform === 'win32' || (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
    // 2026-11-17: the server stores a SHA-256 of each session token. A copy of db.json or a backup is then not a login.
    const issued = [admin.getCookie(), manager.getCookie()].map(c => /vds_session=([0-9a-f]+)/.exec(c || '')?.[1]).filter(Boolean);
    const hashOf = tok => crypto.createHash('sha256').update(tok).digest('hex');
    T.check('session tokens are not stored in the clear in db.json: no issued cookie token appears in the file', issued.length > 0 && !issued.some(tok => dbJson.includes(tok)), `${issued.length} live tokens checked`);
    T.check('and the stored value is the hash of the token the browser holds', issued.every(tok => stored.sessions.some(x => x.token === hashOf(tok))));

    /* ---- logout kills the token ---- */
    const stolen = makeClient(base);
    stolen.setCookie(`vds_session=${token}`);
    T.check('control: the captured token works before logout', (await stolen.get('/api/auth/me')).status === 200);
    await stolen.post('/api/auth/logout', {});
    T.check('token is dead after logout (replay refused)', (await stolen.get('/api/db')).status === 401);

    /* ---- session fixation ---- */
    const fixed = 'a'.repeat(64);
    const fx = await rawLogin(base, 'junior', ROLE_PW.JUNIOR_OFFICER, { Cookie: `vds_session=${fixed}` });
    const fxCookie = fx.headers.get('set-cookie') || '';
    T.check('login issues a fresh token even when the browser presents one (no fixation)', /vds_session=([0-9a-f]{64})/.test(fxCookie) && !fxCookie.includes(fixed));
    const attacker = makeClient(base);
    attacker.setCookie(`vds_session=${fixed}`);
    T.check('the pre-set token never becomes authenticated', (await attacker.get('/api/auth/me')).status === 401);
    // Token in places other than the cookie
    const viaHeader = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${(/vds_session=([0-9a-f]{64})/.exec(fxCookie) || [])[1]}`, 'X-Session': 'x' } });
    const viaQuery = await fetch(base + `/api/auth/me?vds_session=${(/vds_session=([0-9a-f]{64})/.exec(fxCookie) || [])[1]}`);
    T.check('a token is honoured only from the cookie (not Authorization header or query string)', viaHeader.status === 401 && viaQuery.status === 401, `${viaHeader.status}/${viaQuery.status}`);
    T.check('a malformed cookie percent-escape does not crash the server', (await fetch(base + '/api/auth/me', { headers: { Cookie: 'vds_session=%E0%A4%A' } })).status < 500);

    /* ---- password change: other sessions ---- */
    const s1 = makeClient(base); const s2 = makeClient(base);
    await s1.post('/api/auth/login', { username: 'finance', password: ROLE_PW.FINANCE_OFFICER }, { captureCookie: true });
    await s2.post('/api/auth/login', { username: 'finance', password: ROLE_PW.FINANCE_OFFICER }, { captureCookie: true });
    const ch = await s1.post('/api/auth/change-password', { currentPassword: ROLE_PW.FINANCE_OFFICER, newPassword: 'FinanceNew-33!y' });
    T.check('password change succeeds', ch.status === 200);
    T.check('after a password change every OTHER session for that account is revoked', (await s2.get('/api/auth/me')).status === 401, 'the session opened before the change (e.g. a stolen cookie) still works');
    T.check('old password refused, new accepted', (await rawLogin(base, 'finance', ROLE_PW.FINANCE_OFFICER)).status === 401 && (await rawLogin(base, 'finance', 'FinanceNew-33!y')).status === 200);
    // change-password current-password guessing on a hijacked session: throttled?
    const guesses = [];
    for (let i = 0; i < 25; i++) guesses.push((await junior.post('/api/auth/change-password', { currentPassword: `Wrong-guess-${i}!Aa`, newPassword: 'JuniorNew-44!z' })).status);
    T.check('a signed-in session cannot brute-force the account password through change-password (a 429 should appear)', guesses.includes(429), `statuses ${[...new Set(guesses)].join(',')} over 25 guesses`);

    /* ---- deactivation, role change, reset ---- */
    const jr = makeClient(base);
    await jr.post('/api/auth/login', { username: 'junior', password: ROLE_PW.JUNIOR_OFFICER }, { captureCookie: true });
    const juniorId = env.users.find(u => u.username === 'junior').id;
    await admin.put(`/api/users/${juniorId}`, { active: false });
    T.check('deactivating an account kills its live sessions', (await jr.get('/api/db')).status === 401);
    await admin.put(`/api/users/${juniorId}`, { active: true });
    T.check('re-activating does not resurrect the old token', (await jr.get('/api/db')).status === 401);
    T.check('a deactivated account cannot sign in', (await (async () => { await admin.put(`/api/users/${juniorId}`, { active: false }); return rawLogin(base, 'junior', ROLE_PW.JUNIOR_OFFICER); })()).status === 401);
    await admin.put(`/api/users/${juniorId}`, { active: true });
    const mgr2 = makeClient(base);
    await mgr2.post('/api/auth/login', { username: 'manager', password: ROLE_PW.MANAGER }, { captureCookie: true });
    const mgrId = env.users.find(u => u.username === 'manager').id;
    await admin.put(`/api/users/${mgrId}`, { role: 'JUNIOR_OFFICER' });
    T.check('a demotion takes effect on the live session at once', (await mgr2.post('/api/settings', { trn: '1' })).status === 403);
    await admin.put(`/api/users/${mgrId}`, { role: 'MANAGER' });
    await admin.post(`/api/users/${mgrId}/reset-password`, { password: 'MgrReset-55!q' });
    T.check('an administrator password reset revokes the live sessions', (await mgr2.get('/api/db')).status === 401);
    T.check('mustChangePassword is forced after reset', (await admin.get('/api/db')).body.users.find(u => u.id === mgrId).mustChangePassword === true);
    T.check('the last active administrator cannot be deactivated', (await admin.put(`/api/users/${env.users.find(u => u.username === 'admin').id}`, { active: false })).status === 400);
    T.check('the last active administrator cannot be demoted', (await admin.put(`/api/users/${env.users.find(u => u.username === 'admin').id}`, { role: 'MANAGER' })).status === 400);
    const w = await admin.post('/api/users', { name: 'W', username: 'weak', role: 'MANAGER', password: 'short1A' });
    const w2 = await admin.post('/api/users', { name: 'W', username: 'weak', role: 'MANAGER', password: 'alllowercase11' });
    T.check('weak passwords are refused at account creation', w.status === 400 && w2.status === 400, `${w.status}/${w2.status}`);
    const w3 = await admin.post('/api/users', { name: 'W', username: 'Weak User', role: 'MANAGER', password: 'Strong-Pass-1!' });
    const w4 = await admin.post('/api/users', { name: 'W', username: '__proto__', role: 'MANAGER', password: 'Strong-Pass-1!' });
    T.check('odd usernames are refused (space) ; __proto__ username does not poison lookups', w3.status === 400 && w4.status < 500, `${w3.status}/${w4.status}`);
    T.check('the server still answers after the __proto__ username attempt', (await admin.get('/api/db')).status === 200);

    /* ---- brute force ---- */
    const spoof = [];
    for (let i = 0; i < 14; i++) spoof.push((await rawLogin(base, 'nobody-x', 'Wrong-pass-1!A', { 'X-Forwarded-For': `10.9.${i}.1`, 'X-Real-IP': `10.8.${i}.1` })).status);
    T.check('X-Forwarded-For spoofing does not reset the sign-in throttle', spoof.includes(429), spoof.join(','));
    const target = [];
    for (let i = 0; i < 40; i++) target.push((await rawLogin(base, 'finance', `Wrong-guess-${i}!Aa`)).status);
    T.check('repeated wrong passwords for one account lock the account out (429)', target.includes(429), target.join(','));
    const legit = await rawLogin(base, 'finance', 'FinanceNew-33!y');
    known('(finding probe) the legitimate owner is not locked out by an attacker\'s failed guesses', legit.status === 200, `legit login during attack: ${legit.status}`);
    const sprayCodes = [];
    for (let i = 0; i < 30; i++) sprayCodes.push((await rawLogin(base, `spray${i}`, 'Winter2026!!')).status);
    // Flipped in the second security pass: unknown devices now share a per-address cap (30 failed attempts per 15 minutes) across usernames.
    T.check('password spraying across distinct usernames from one IP is throttled per IP', sprayCodes.includes(429), `statuses ${[...new Set(sprayCodes)].join(',')}`);
    const unameTiming = [];
    for (const u of ['admin', 'no-such-user-zz']) { const t = Date.now(); await rawLogin(base, u, 'Wrong-pass-1!A'); unameTiming.push(Date.now() - t); }
    console.log('  info login timing ms (existing admin vs missing user):', unameTiming.join(' vs '));
    const msgA = await (await rawLogin(base, 'admin', 'Wrong-pass-1!A')).json();
    const msgB = await (await rawLogin(base, 'ghost-user-q', 'Wrong-pass-1!A')).json();
    T.check('login error text is identical for a real and a missing account', msgA.error === msgB.error, `${msgA.error} | ${msgB.error}`);

    /* ---- login body type confusion ---- */
    for (const [u, p] of [[{ $ne: '' }, { $ne: '' }], [['admin'], ['x']], [null, null], [123, 456], ['admin', { toString: 1 }]]) {
      const r = await rawLogin(base, u, p);
      T.check(`login with ${JSON.stringify([u, p]).slice(0, 40)} is a clean 4xx`, r.status >= 400 && r.status < 500, `${r.status}`);
    }
  } finally {
    await env.stop();
  }
  return T.done();
}
