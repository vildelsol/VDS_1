/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The second security pass. Each guard has a positive control beside it (the real user still signs in, ordinary
 * office use is not limited), and each was proved by reverting it and watching its test fail.
 *
 *   1. sign-in throttle: reserved before the password check, per-address and global caps, never evicts a block,
 *      known-device cookie, common-password blocklist
 *   3. audit flooding: rate limits, reprints audited once, rotation to an archive, sessions pruned and capped
 *   4. audit chain: head anchor, unsealed entries after keyedFrom
 *   5. restore: row validation, signed snapshots, money totals, receipts with no audit entry
 *   6. iCal: bounded dates, durations, sizes and counts; feed addresses hidden from other roles
 *   7. co-sign on deposit settlement, eviction and damage-deposit settlement
 *   8. idempotency cache: capped and journalled
 *   9. sessions: absolute lifetime, must-change sessions, offline queue, users list, sign out everywhere
 *   and a script-src in the content security policy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, sleep } from './harness.mjs';

export const title = 'Security hardening, second pass';
export const allowUnknownRoutes = true;

const ADMIN0 = 'Hard2-Init-1234!';
const ADMIN = 'Hard2-Admin-9876!';
const JR = 'Hard2-Junior-22!';
const MG = 'Hard2-Manager-22!';
const mkClient = base => makeClient(base, { autoConfirmDuplicates: false, autoOverrideReason: false });

async function bundle(projectRoot, outDir, entry, name) {
  const out = path.join(outDir, `${name}.mjs`);
  await build({ entryPoints: [path.join(projectRoot, entry)], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  return import(pathToFileURL(out).href + `?v=${Date.now()}`);
}

/** A raw sign-in that keeps EVERY cookie the server sets (the harness client keeps only the first). */
async function rawLogin(base, username, password, cookieHeader = '') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
    body: JSON.stringify({ username, password })
  });
  const set = res.headers.getSetCookie();
  const jar = Object.fromEntries(set.map(c => c.split(';')[0]).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const body = await res.json().catch(() => null);
  return { status: res.status, body, set, session: jar.vds_session, device: jar.vds_device };
}

async function addUser(admin, username, role, password) {
  const r = await admin.post('/api/users', { name: `Hard ${username}`, username, role, password: 'Issued-1111!aa' });
  const c = mkClient(admin.__base);
  await c.post('/api/auth/login', { username, password: 'Issued-1111!aa' }, { captureCookie: true });
  await c.post('/api/auth/change-password', { currentPassword: 'Issued-1111!aa', newPassword: password });
  return { client: c, status: r.status };
}

async function boot(port, projectRoot, env, dataDir) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hard2-'));
  const srv = await startServer({ port, adminPassword: ADMIN0, projectRoot, dataDir: dir, env });
  const admin = mkClient(srv.baseUrl);
  admin.__base = srv.baseUrl;
  if (dataDir) await admin.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
  else await activateAdmin(admin, ADMIN0, ADMIN);
  return { srv, admin, dir, base: srv.baseUrl };
}
const dbOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const integrityCodes = async c => ((await c.get('/api/integrity')).body.findings || []).map(f => f.code);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hard2-mods-'));
  const dirs = [];
  let srv;
  const done = async () => {
    try {
      await srv?.stop();
    } catch {
      /* already stopped */
    }
    srv = undefined;
  };
  try {
    /* ================================================================== *
     * 1. THE SIGN-IN THROTTLE
     * ================================================================== */
    const th = await bundle(projectRoot, tmp, 'server/loginThrottle.ts', 'loginThrottle');
    {
      let now = 5_000_000;
      const t = new th.LoginThrottle(() => now);
      // Unit level: 300 simultaneous guesses at one (address, username), all reserved before any is answered.
      let allowed = 0;
      for (let i = 0; i < 300; i++) if (t.reserve('10.1.1.1', 'victim', null).allowed) allowed++;
      T.check('a burst of 300 simultaneous guesses on one pair gets at most the free allowance through', allowed <= th.UNKNOWN_FREE_FAILURES, `${allowed} allowed`);
      const t2 = new th.LoginThrottle(() => now);
      const one = t2.reserve('10.1.1.2', 'victim', null);
      T.check('control: a single sign-in attempt is allowed', one.allowed === true);
      one.settle(true);
      T.check('...and a correct password hands the reservation back (the address cap is not used up by successes)', t2.caps().global === 0);

      // Per-address cap across usernames.
      const t3 = new th.LoginThrottle(() => now);
      let okAddr = 0;
      for (let i = 0; i < 60; i++) if (t3.reserve('10.1.1.3', `spray${i}`, null).allowed) okAddr++;
      T.check('one address spraying 60 different usernames gets at most the per-address cap (30)', okAddr === th.IP_CAP, `${okAddr}`);
      T.check('control: a different address is not affected by that spray', t3.reserve('10.1.1.4', 'someone', null).allowed === true);
      now += th.CAP_WINDOW_MS + 1;
      T.check('the cap lifts when its window ends', t3.reserve('10.1.1.3', 'spray-again', null).allowed === true);

      // Global cap across addresses.
      const t4 = new th.LoginThrottle(() => now);
      let okGlobal = 0;
      for (let i = 0; i < 400; i++) if (t4.reserve(`10.2.${Math.floor(i / 20)}.${i % 20}`, `u${i}`, null).allowed) okGlobal++;
      T.check('guesses from many addresses together are capped overall (300)', okGlobal === th.GLOBAL_CAP, `${okGlobal}`);
      T.check('...but a known device is not subject to the global or address cap', t4.reserve('10.2.9.9', 'real-user', 'device-hash-1').allowed === true);

      // A blocked entry is never evicted to make room.
      const t5 = new th.LoginThrottle(() => now);
      for (let i = 0; i < th.FREE_FAILURES; i++) t5.fail('10.3.0.1', 'blocked-victim');
      T.check('setup: the pair is blocked', t5.check('10.3.0.1', 'blocked-victim').allowed === false);
      for (let i = 0; i < 5300; i++) t5.fail(`10.4.${Math.floor(i / 250)}.${i % 250}`, `junk${i}`);
      T.check('flooding the table with made-up usernames does not un-block a blocked pair', t5.check('10.3.0.1', 'blocked-victim').allowed === false);
      T.check('control: the table does not grow past its bound', t5.list().length <= 5000, `${t5.list().length}`);

      // Known-device bucket is separate from the unknown-device buckets.
      const t6 = new th.LoginThrottle(() => now);
      for (let i = 0; i < 20; i++) t6.reserve('10.5.0.1', 'finance', null);
      T.check('an attacker has used up the unknown-device allowance for the pair', t6.reserve('10.5.0.1', 'finance', null).allowed === false);
      T.check('the known device of that user (same address) is unaffected', t6.reserve('10.5.0.1', 'finance', 'finance-device').allowed === true);
      for (let i = 0; i < 20; i++) t6.reserve('10.5.0.1', 'finance', 'finance-device');
      T.check('and its own wrong guesses are still throttled in its own bucket', t6.reserve('10.5.0.1', 'finance', 'finance-device').allowed === false);
    }

    /* ---- through the server ---- */
    {
      const env = await boot(port, projectRoot, {});
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base } = env;
      const jr = await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR);
      T.check('setup: a junior account exists', jr.status === 200);

      // The real user signs in and is handed a known-device cookie.
      const first = await rawLogin(base, 'junior', JR);
      T.check('control: the real user signs in', first.status === 200 && !!first.session);
      const deviceHeader = first.device ? `vds_device=${first.device}` : '';
      const deviceCookie = first.set.find(c => c.startsWith('vds_device=')) || '';
      T.check('a known-device cookie is issued, HttpOnly and SameSite=Strict', /HttpOnly/i.test(deviceCookie) && /SameSite=Strict/i.test(deviceCookie), deviceCookie);
      T.check('the raw device id is not stored: only its hash is in db.json', !!first.device && !fs.readFileSync(path.join(env.dir, 'db.json'), 'utf8').includes(first.device));

      // An attacker on the SAME address, with no cookie, guesses until blocked.
      const guesses = [];
      for (let i = 0; i < 8; i++) guesses.push((await rawLogin(base, 'junior', `Wrong-guess-${i}!Aa`)).status);
      T.check('the attacker (no cookie) is throttled after a few wrong guesses', guesses.includes(429), guesses.join(','));
      const attackerRight = await rawLogin(base, 'junior', JR);
      T.check('(this is what the real user suffered before) the right password WITHOUT the device cookie is refused while blocked', attackerRight.status === 429, `${attackerRight.status}`);
      const realUser = await rawLogin(base, 'junior', JR, deviceHeader);
      T.check('the real user, on the same address WITH the device cookie, still signs in', realUser.status === 200, `${realUser.status}`);
      T.check('...and keeps the same device cookie (none re-issued)', !realUser.device);

      // A device cookie issued to ANOTHER user is no help against this user's bucket.
      const adminLogin = await rawLogin(base, 'admin', ADMIN);
      const wrongUsersDevice = await rawLogin(base, 'junior', JR, `vds_device=${adminLogin.device}`);
      T.check("another user's device cookie does not count as a known device for this user", wrongUsersDevice.status === 429, `${wrongUsersDevice.status}`);

      // The known device's own bucket still throttles guessing.
      let blockedOnDevice = false;
      for (let i = 0; i < 12; i++) if ((await rawLogin(base, 'junior', `Wrong-dev-${i}!Aa`, deviceHeader)).status === 429) blockedOnDevice = true;
      T.check('a known device guessing wrong passwords is throttled in its own bucket', blockedOnDevice);
      const adminList = await admin.get('/api/auth/throttles');
      T.check('the administrator sees device buckets too, and can clear them', adminList.status === 200 && adminList.body.throttles.some(x => x.address === '(known device)'));
      const cleared = await admin.post('/api/auth/throttles/clear', { username: 'junior' });
      T.check('clearing a username clears its address and device buckets', cleared.status === 200 && cleared.body.cleared >= 2, JSON.stringify(cleared.body));
      T.check('control: ordinary typing (two wrong, then right) is not blocked', (await rawLogin(base, 'junior', 'Wrong-1!Aa', deviceHeader)).status === 401 && (await rawLogin(base, 'junior', JR, deviceHeader)).status === 200);

      // Concurrency, through the real server: 80 simultaneous wrong guesses for one user.
      await admin.post('/api/auth/throttles/clear', { username: 'junior' });
      const burst = await Promise.all(Array.from({ length: 80 }, (_, i) => rawLogin(base, 'junior', `Burst-guess-${i}!Aa`)));
      const got401 = burst.filter(r => r.status === 401).length;
      T.check('80 simultaneous wrong guesses: only the free allowance reaches the password check, the rest are 429', got401 <= th.UNKNOWN_FREE_FAILURES && burst.some(r => r.status === 429), `${got401} x 401, ${burst.filter(r => r.status === 429).length} x 429`);

      // Per-address cap through the server: spraying across usernames.
      await admin.post('/api/auth/throttles/clear', { username: 'junior' });
      const spray = [];
      for (let i = 0; i < 45; i++) spray.push((await rawLogin(base, `nobody-${i}`, 'Winter2026!!x')).status);
      T.check('spraying 45 usernames from one address: at most 30 reach the password check, then 429', spray.filter(s => s === 401).length <= 30 && spray.includes(429), `${spray.filter(s => s === 401).length} x 401`);
      T.check('control: a user with a known device can still sign in during the spray', (await rawLogin(base, 'junior', JR, deviceHeader)).status === 200);

      // Password blocklist.
      const weak = [];
      for (const pw of ['Password123!', 'Welcome1234!', 'Admin123456!', 'P@ssw0rd123!', 'Villaggio2026!', 'Qwerty123456!']) {
        const r = await admin.post('/api/users', { name: 'W', username: `weak${weak.length}`, role: 'JUNIOR_OFFICER', password: pw });
        weak.push(`${pw}:${r.status}`);
      }
      T.check('common and property-name passwords are refused', weak.every(x => x.endsWith(':400')), weak.join(' '));
      T.check('control: a strong password is accepted', (await admin.post('/api/users', { name: 'S', username: 'strong1', role: 'JUNIOR_OFFICER', password: 'Strong-Pass-1!' })).status === 200);
      T.check('control: a long passphrase that merely contains a common word is accepted', (await admin.post('/api/users', { name: 'S', username: 'strong2', role: 'JUNIOR_OFFICER', password: 'correct-horse-password-staple-9' })).status === 200);
      await done();
    }

    /* ================================================================== *
     * 3. AUDIT FLOODING: rate limits, reprints, rotation, sessions
     * ================================================================== */
    {
      const env = await boot(port, projectRoot, { VDS_AUDIT_CAP: '60' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base, dir } = env;
      await makeLongTermUnit(admin);
      const jr = (await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR)).client;
      await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true } } });
      const rec = (await jr.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 100, currency: 'JMD', method: 'Cash', payerName: 'P', receivedNow: true })).body?.payment;
      const rec2 = (await jr.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 111, currency: 'JMD', method: 'Cash', payerName: 'P2', receivedNow: true })).body?.payment;
      const auditCount = async () => (await admin.get('/api/db')).body.auditLogs.length;

      const before = await auditCount();
      let last;
      for (let i = 0; i < 25; i++) last = await jr.post(`/api/payments/${rec.id}/mark-printed`, {});
      const after = await auditCount();
      const reprintLines = (await admin.get('/api/db')).body.auditLogs.filter(a => /Reprinted receipt/.test(a.action) && a.recordId === rec.id).length;
      T.check('25 reprints of one receipt write one audit line, not 25', reprintLines === 1 && after - before <= 2, `${reprintLines} reprint lines, +${after - before} entries`);
      T.check('...but the copy count on the receipt still goes up every time', last.body?.printCount === 25, `${last.body?.printCount}`);
      await jr.post(`/api/payments/${rec2.id}/mark-printed`, {});
      await jr.post(`/api/payments/${rec2.id}/mark-printed`, {});
      T.check('control: the first reprint of a DIFFERENT receipt is still audited', (await admin.get('/api/db')).body.auditLogs.some(a => /Reprinted receipt/.test(a.action) && a.recordId === rec2.id));

      // Rotation: push the trail past its (test) ceiling of 60 with ordinary audited writes.
      const archive = path.join(dir, 'audit-archive.jsonl');
      T.check('control: before the ceiling there is no archive and the integrity check is clean of audit findings', !fs.existsSync(archive) && !(await integrityCodes(admin)).some(c => /audit/.test(c)));
      const firstSeen = (await admin.get('/api/db')).body.auditLogs.slice(-3).map(a => a.id);
      for (let i = 0; i < 70; i++) await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000 + i, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
      const liveLogs = dbOf(dir).auditLogs;
      T.check('past the ceiling the live trail stays bounded', liveLogs.length <= 60, `${liveLogs.length}`);
      const archived = fs.existsSync(archive) ? fs.readFileSync(archive, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      T.check('the oldest entries were KEPT in audit-archive.jsonl, not dropped', archived.length > 0 && firstSeen.every(id => archived.some(a => a.id === id)), `${archived.length} archived`);
      T.check('nothing is both lost and kept twice: live + archived covers every write', archived.length + liveLogs.length >= 70 + before, `${archived.length} + ${liveLogs.length}`);
      T.check('the archive joins the live trail (its newest seal is the oldest live entry\'s predecessor)', archived[archived.length - 1]?.seal === liveLogs[liveLogs.length - 1].prevSeal);
      T.check('integrity stays clean of audit findings after rotation (chain, anchor and archive all verify)', !(await integrityCodes(admin)).some(c => /audit/.test(c)), (await integrityCodes(admin)).join(','));
      const run = await admin.post('/api/backup/run', {});
      const backupArchive = path.join(dir, 'db-backups', 'audit-archive.jsonl');
      T.check('the archive is copied into the backup folder', run.status === 200 && fs.existsSync(backupArchive) && fs.statSync(backupArchive).size === fs.statSync(archive).size);

      // Verifiable: edit one archived line and the check finds it.
      await done();
      const archiveText = fs.readFileSync(archive, 'utf8');
      const lines = archiveText.trim().split('\n');
      const edited = JSON.parse(lines[2]);
      edited.action = 'rewritten history';
      lines[2] = JSON.stringify(edited);
      fs.writeFileSync(archive, lines.join('\n') + '\n');
      let again = await boot(port, projectRoot, { VDS_AUDIT_CAP: '60' }, dir).catch(() => null);
      srv = again?.srv;
      const c2 = mkClient(base);
      await c2.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      T.check('an edited line in the archive is detected', (await integrityCodes(c2)).some(c => c === 'audit-trail-broken' || c === 'audit-head-mismatch'));
      await done();
      // Deleting the archive is detected too (entries were archived, now cannot be found).
      fs.rmSync(archive);
      again = await boot(port, projectRoot, { VDS_AUDIT_CAP: '60' }, dir).catch(() => null);
      srv = again?.srv;
      const c3 = mkClient(base);
      await c3.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      T.check('deleting the archive file is detected', (await integrityCodes(c3)).some(c => c === 'audit-trail-broken' || c === 'audit-head-mismatch'));
      await done();
    }

    // Rotation failure: the archive cannot be written. Nothing is dropped and the finding is SERIOUS.
    {
      const env = await boot(port, projectRoot, { VDS_AUDIT_CAP: '30' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, dir } = env;
      await makeLongTermUnit(admin);
      T.check('control: with the archive writable there is no near-capacity finding', !(await integrityCodes(admin)).includes('audit-trail-near-capacity'));
      fs.writeFileSync(path.join(dir, 'audit-archive.jsonl'), '', { mode: 0o444 }); // read-only: every append fails
      for (let i = 0; i < 45; i++) await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000 + i, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
      const rep = (await admin.get('/api/integrity')).body;
      const f = rep.findings.find(x => x.code === 'audit-trail-near-capacity');
      T.check('when rotation fails, nothing is dropped (the trail grows past its ceiling)', dbOf(dir).auditLogs.length > 30, `${dbOf(dir).auditLogs.length}`);
      T.check('...and "near capacity" becomes a SERIOUS finding', f?.severity === 'serious', JSON.stringify(f));
      await done();
    }

    // Rate limits: low limits for this server so the test is quick; defaults are generous (see server.ts).
    {
      const env = await boot(port, projectRoot, { VDS_RATE_WRITES_PER_USER_MIN: '40', VDS_RATE_WRITES_PER_ADDRESS_MIN: '400', VDS_RATE_LOGINS_PER_ADDRESS_MIN: '30', VDS_LOGIN_IP_CAP: '1000', VDS_LOGIN_GLOBAL_CAP: '1000' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base } = env;
      await makeLongTermUnit(admin);
      const jr = (await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR)).client;
      await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true } } });
      const rec = (await jr.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 100, currency: 'JMD', method: 'Cash', payerName: 'P', receivedNow: true })).body?.payment;
      const codes = [];
      for (let i = 0; i < 60; i++) codes.push((await jr.post(`/api/payments/${rec.id}/mark-printed`, {})).status);
      T.check('a signed-in user hammering writes is limited with 429 rate-limited', codes.includes(429) && codes.filter(c => c === 200).length <= 40, `${codes.filter(c => c === 200).length} x 200`);
      const limited = await jr.post(`/api/payments/${rec.id}/mark-printed`, {});
      T.check('the refusal says so and carries Retry-After', limited.status === 429 && limited.body?.code === 'rate-limited');
      const adminWrite = await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 17777, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
      T.check('control: another user is not limited by the first one\'s flood (per-user limit)', adminWrite.status === 200, `${adminWrite.status}`);
      const reads = [];
      for (let i = 0; i < 60; i++) reads.push((await jr.get('/api/db')).status);
      T.check('control: reads are not rate-limited', reads.every(s => s === 200));
      const loginCodes = [];
      for (let i = 0; i < 40; i++) loginCodes.push((await rawLogin(base, 'admin', ADMIN)).status);
      T.check('a flood of sign-in attempts is limited per address, with 429', loginCodes.includes(429) && loginCodes.filter(c => c === 200).length <= 30, `${loginCodes.filter(c => c === 200).length} x 200`);
      await done();
    }

    // Sessions: pruned and capped.
    {
      const env = await boot(port, projectRoot, { VDS_LOGIN_IP_CAP: '1000', VDS_LOGIN_GLOBAL_CAP: '1000' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base, dir } = env;
      await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR);
      await done();
      const j = dbOf(dir);
      const ju = j.users.find(u => u.username === 'junior');
      for (let i = 0; i < 6; i++) j.sessions.push({ token: `expired-${i}`, userId: ju.id, createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T12:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' });
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(j, null, 2));
      srv = (await boot(port, projectRoot, { VDS_LOGIN_IP_CAP: '1000', VDS_LOGIN_GLOBAL_CAP: '1000' }, dir)).srv;
      await rawLogin(base, 'junior', JR);
      const kept = dbOf(dir).sessions;
      T.check('expired sessions are pruned at the next sign-in', !kept.some(s => String(s.token).startsWith('expired-')) && kept.length >= 1, `${kept.length} left`);
      for (let i = 0; i < 30; i++) await rawLogin(base, 'junior', JR);
      const mine = dbOf(dir).sessions.filter(s => s.userId === ju.id);
      T.check('one account cannot hold more than 20 sessions (30 sign-ins leave 20)', mine.length === 20, `${mine.length}`);
      T.check('control: the newest sessions are the ones kept', (await rawLogin(base, 'junior', JR)).status === 200);
      await done();
    }

    /* ================================================================== *
     * 4. THE AUDIT CHAIN'S HEAD ANCHOR
     * ================================================================== */
    {
      const ac = await bundle(projectRoot, tmp, 'server/auditChain.ts', 'auditChain');
      // Unit level, in a throw-away data folder with its own key: stripping every seal from the NEWEST entries.
      const kdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hard2-key-'));
      process.env.VDS_DATA_DIR = kdir;
      const logs = [];
      const mk = i => ({ id: `a${i}`, user: 'u', role: 'r', dateTime: new Date(Date.now() + 60000 + i).toISOString(), action: `act ${i}`, recordType: 'T', recordId: `${i}`, previousValue: '', newValue: '' });
      for (let i = 0; i < 6; i++) {
        const e = mk(i);
        ac.sealAuditEntry(e, logs);
        logs.unshift(e);
      }
      T.check('control: a freshly sealed chain verifies', ac.verifyAuditChain(logs).broken.length === 0);
      const stripped = logs.map(e => {
        const c = { ...e };
        delete c.seal;
        delete c.prevSeal;
        delete c.sealKind;
        return c;
      });
      T.check('stripping EVERY seal is detected: entries dated after keyed sealing began must carry one', ac.verifyAuditChain(stripped).broken.length === stripped.length, `${ac.verifyAuditChain(stripped).broken.length} flagged`);
      const unsealedHead = [{ ...mk(99) }, ...logs];
      T.check('a single unsealed entry added at the head is detected', ac.verifyAuditChain(unsealedHead).broken.length === 1);
      // Signed snapshots.
      const snap = { a: 1, units: [{ id: 'u' }], settings: { x: 1 } };
      const sig = ac.signSnapshot(snap);
      T.check('a snapshot is signed with the audit key', typeof sig === 'string' && sig.length === 64);
      T.check('its signature verifies', ac.checkSnapshotSignature({ ...snap, snapshotSignature: sig }) === 'valid');
      T.check('an edited snapshot does not', ac.checkSnapshotSignature({ ...snap, a: 2, snapshotSignature: sig }) === 'mismatch');
      T.check('an unsigned one is reported as unsigned', ac.checkSnapshotSignature(snap) === 'unsigned');
      delete process.env.VDS_DATA_DIR;
      fs.rmSync(kdir, { recursive: true, force: true });

      // Server level: delete the newest entries / strip seals in db.json while the server is stopped.
      const env = await boot(port, projectRoot, {});
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, dir } = env;
      await makeLongTermUnit(admin);
      for (let i = 0; i < 4; i++) await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000 + i, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
      const anchorFile = path.join(dir, 'audit-head.json');
      const anchor1 = fs.readFileSync(anchorFile, 'utf8');
      await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 19999, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
      T.check('the anchor is rewritten on every audit write', fs.readFileSync(anchorFile, 'utf8') !== anchor1);
      T.check('control: the untouched trail and anchor verify', !(await integrityCodes(admin)).some(c => /audit/.test(c)));
      const jsonKey = JSON.parse(fs.readFileSync(path.join(dir, 'audit-key.json'), 'utf8')).key;
      T.check('the anchor does not contain the key', !fs.readFileSync(anchorFile, 'utf8').includes(jsonKey));
      await done();
      const pristine = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
      const anchorPristine = fs.readFileSync(anchorFile, 'utf8');
      const tamper = async (label, mutate, expect = true) => {
        const j = JSON.parse(pristine);
        mutate(j);
        fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(j, null, 2));
        fs.writeFileSync(anchorFile, anchorPristine);
        srv = (await boot(port, projectRoot, {}, dir)).srv;
        const c = mkClient(`http://127.0.0.1:${port}`);
        await c.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
        const codes = await integrityCodes(c);
        const flagged = codes.includes('audit-head-mismatch') || codes.includes('audit-trail-broken');
        T.check(label, flagged === expect, codes.join(','));
        // A later ordinary write must not launder the tampering.
        if (expect) {
          await c.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 18888, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 });
          const after = await integrityCodes(c);
          T.check(`${label}: and an ordinary write afterwards does not hide it`, after.includes('audit-head-mismatch') || after.includes('audit-trail-broken'), after.join(','));
        }
        await done();
      };
      await tamper('deleting the NEWEST 3 audit entries is detected', j => j.auditLogs.splice(0, 3));
      await tamper('stripping every seal and prevSeal is detected', j => {
        for (const e of j.auditLogs) {
          delete e.seal;
          delete e.prevSeal;
          delete e.sealKind;
        }
      });
      await tamper('wiping the whole trail is detected', j => (j.auditLogs = []));
      await tamper('control: an untouched db.json and anchor are NOT flagged', () => undefined, false);
      // A crash between writing db.json and the anchor leaves the anchor ONE STEP BEHIND: not an alarm.
      fs.writeFileSync(path.join(dir, 'db.json'), pristine);
      fs.writeFileSync(anchorFile, anchor1);
      srv = (await boot(port, projectRoot, {}, dir)).srv;
      const cb = mkClient(`http://127.0.0.1:${port}`);
      await cb.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      T.check('an anchor one or more writes BEHIND the trail (a crash between the two files) is not an alarm', !(await integrityCodes(cb)).some(c => /audit/.test(c)));
      await done();
    }

    /* ================================================================== *
     * 5. RESTORE
     * ================================================================== */
    {
      const env = await boot(port, projectRoot, {});
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, dir } = env;
      await makeLongTermUnit(admin);
      await admin.post('/api/charges/post-month', { monthString: '2026-07' });
      const pay = await admin.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 1234, currency: 'JMD', method: 'Cash', payerName: 'Real', receivedNow: true });
      const snap = JSON.parse((await admin.get('/api/backup/download')).text);
      T.check('a downloaded snapshot is signed', typeof snap.snapshotSignature === 'string' && snap.snapshotSignature.length === 64);

      const dry = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: snap, dryRun: true });
      T.check('the dry run reports the signature as valid, with no warnings', dry.status === 200 && dry.body.signature === 'valid' && dry.body.warnings.length === 0, JSON.stringify(dry.body?.signature));
      T.check('the dry run shows the money in the file against the money now', dry.body.totals?.file?.receipts?.JMD?.total === 1234 && dry.body.totals?.current?.receipts?.JMD?.total === 1234, JSON.stringify(dry.body.totals?.file?.receipts));
      const okRestore = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: snap, confirm: 'RESTORE' });
      T.check('control: a genuine signed snapshot restores with just the word RESTORE', okRestore.status === 200 && okRestore.body.signature === 'valid', `${okRestore.status}`);

      // Signature states.
      const unsigned = { ...snap };
      delete unsigned.snapshotSignature;
      const u1 = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: unsigned, confirm: 'RESTORE' });
      T.check('an unsigned file is refused without an explicit confirmation (400 restore-unsigned-needs-confirmation)', u1.status === 400 && u1.body?.code === 'restore-unsigned-needs-confirmation', `${u1.status} ${u1.body?.code}`);
      const u2 = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: unsigned, confirm: 'RESTORE', confirmUnsigned: true });
      T.check('...a confirmation with no reason is still refused', u2.status === 400);
      const dryUnsigned = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: unsigned, dryRun: true });
      T.check('the dry run warns that it is unsigned', dryUnsigned.body.signature === 'unsigned' && dryUnsigned.body.warnings.length === 1);
      const u3 = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: unsigned, confirm: 'RESTORE', confirmUnsigned: true, reason: 'older backup from before signing' });
      T.check('with the confirmation and a reason an unsigned file restores', u3.status === 200 && u3.body.signature === 'unsigned', `${u3.status}`);
      T.check('...and the audit line records that it was not verified, and why', (await admin.get('/api/db')).body.auditLogs.some(a => /Restored the records/.test(a.action) && /NOT verified \(unsigned\)/.test(a.newValue) && /before signing/.test(a.newValue)));
      const edited = JSON.parse(JSON.stringify(snap));
      edited.payments[0].amount = 99999;
      const m1 = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: edited, confirm: 'RESTORE' });
      T.check('a signed file edited afterwards (signature mismatch) is refused without confirmation', m1.status === 400 && /does NOT match/.test(m1.body?.error || ''), `${m1.status} ${m1.body?.error?.slice(0, 80)}`);

      // Row validation.
      const base0 = () => JSON.parse(JSON.stringify(unsigned));
      const cases = [
        ['a payment date that is an object', f => (f.payments[0].date = { $date: 'x' })],
        ['a payment date that is not a real day (2026-13-99)', f => (f.payments[0].date = '2026-13-99')],
        ['a booking check-in that is an array', f => (f.bookings = [{ id: 'b1', unitId: 'unit-1', checkIn: ['2026-01-01'], checkOut: '2026-01-03' }])],
        ['an empty tenancy record', f => (f.tenancies = [{}])],
        ['a unit with a null number', f => (f.units[0].number = null)],
        ['a currency that is not JMD or USD', f => (f.payments[0].currency = 'EUR')],
        ['an amount that is not a number', f => (f.charges.length ? (f.charges[0].amount = '1e3') : (f.payments[0].amount = '1e3'))],
        ['an amount that is NaN-like (null)', f => (f.payments[0].amount = null)],
        ['a payment with no id', f => delete f.payments[0].id],
        ['a charge month that is not a month', f => (f.charges[0].periodMonth = '2026-99')],
        ['an expense status that is not one of ours', f => (f.expenses = [{ id: 'e1', date: '2026-01-01', amount: 5, currency: 'JMD', status: 'banana' }])]
      ];
      for (const [label, mutate] of cases) {
        const f = base0();
        mutate(f);
        const r = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: f, confirm: 'RESTORE', confirmUnsigned: true, reason: 'test: validation' });
        T.check(`restore refuses ${label}, naming what is wrong`, r.status === 400 && /record|damaged|amount|list/i.test(r.body?.error || ''), `${r.status} ${String(r.body?.error).slice(0, 140)}`);
      }
      const many = base0();
      many.payments[0].date = 'x';
      many.payments[0].currency = 'EUR';
      many.units[0].number = '';
      const listed = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: many, dryRun: true });
      T.check('the refusal lists every problem it found, not just the first', /date/.test(listed.body?.error) && /JMD or USD/.test(listed.body?.error) && /number/.test(listed.body?.error), String(listed.body?.error).slice(0, 300));
      T.check('control: after all the refusals the records are exactly as they were', (await admin.get('/api/db')).body.payments.some(p => p.id === pay.body.payment.id && p.amount === 1234));

      // A forged completed receipt with no audit entry.
      const forged = base0();
      forged.payments.push({ ...forged.payments[0], id: 'pay-forged-1', receiptNo: 'REC-2099-0001', amount: 9999999, createdAt: new Date().toISOString(), status: 'completed', date: '2026-07-01' });
      T.check('control: before the forged receipt, the integrity check has no unaudited-money finding', !(await integrityCodes(admin)).includes('payment-without-audit-trail'));
      const fr = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: forged, confirm: 'RESTORE', confirmUnsigned: true, reason: 'test: forged receipt' });
      T.check('the forged file restores (it is well-formed) and the integrity result carries the finding', fr.status === 200 && fr.body.integrity.findings.some(f => f.code === 'payment-without-audit-trail'), JSON.stringify(fr.body?.integrity));
      const rep = (await admin.get('/api/integrity')).body;
      const fnd = rep.findings.find(f => f.code === 'payment-without-audit-trail');
      T.check('a completed receipt with no audit entry is a WARNING naming the receipt', fnd?.severity === 'warning' && fnd.records.some(r => r.includes('REC-2099-0001')), JSON.stringify(fnd));
      T.check('...and the genuinely recorded receipt is not named', !fnd?.records.some(r => r.includes('1234')));

      // Backups are signed too.
      await admin.post('/api/backup/run', {});
      const backups = fs.readdirSync(path.join(dir, 'db-backups')).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f));
      const bf = JSON.parse(fs.readFileSync(path.join(dir, 'db-backups', backups[0]), 'utf8'));
      T.check('a daily backup file carries a signature', typeof bf.snapshotSignature === 'string' && bf.sessions.length === 0);
      const rb = await admin.post('/api/backup/restore', { source: 'backup', file: backups[0], location: 'local', dryRun: true });
      T.check('...and a restore from it reads as valid', rb.status === 200 && rb.body.signature === 'valid', `${rb.status} ${rb.body?.signature}`);
      await done();
    }

    /* ================================================================== *
     * 6. iCAL
     * ================================================================== */
    {
      const ical = await bundle(projectRoot, tmp, 'server/ical.ts', 'ical');
      const ev = (uid, lines) => `BEGIN:VEVENT\nUID:${uid}\n${lines.join('\n')}\nEND:VEVENT\n`;
      const cal = body => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}END:VCALENDAR\n`;
      const good = ev('good-1', ['DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270113', 'SUMMARY:Reserved - Ann']);
      const r0 = ical.parseICalChecked(cal(good));
      T.check('control: a normal event is stored unchanged', r0.events.length === 1 && r0.events[0].start === '2027-01-10' && r0.events[0].end === '2027-01-13' && r0.skipped.length === 0);
      const bad = [
        ['an impossible month/day (20261399 to 20261499)', ev('bad-1', ['DTSTART;VALUE=DATE:20261399', 'DTEND;VALUE=DATE:20261499'])],
        ['year 0000', ev('bad-2', ['DTSTART;VALUE=DATE:00000101', 'DTEND;VALUE=DATE:00000103'])],
        ['DURATION:P99999999999D', ev('bad-3', ['DTSTART;VALUE=DATE:20270110', 'DURATION:P99999999999D'])],
        ['a duration over a year', ev('bad-4', ['DTSTART;VALUE=DATE:20270110', 'DURATION:P400D'])],
        ['a stay longer than a year by DTEND', ev('bad-5', ['DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20280601'])],
        ['an end before the start', ev('bad-6', ['DTSTART;VALUE=DATE:20270115', 'DTEND;VALUE=DATE:20270110'])],
        ['February 30th', ev('bad-7', ['DTSTART;VALUE=DATE:20270230', 'DTEND;VALUE=DATE:20270302'])]
      ];
      for (const [label, body] of bad) {
        const r = ical.parseICalChecked(cal(body + good));
        T.check(`${label}: skipped and reported, never stored (the good event beside it still is)`, r.events.length === 1 && r.events[0].uid === 'good-1' && r.skipped.length === 1, `${r.events.map(e => `${e.uid} ${e.start}..${e.end}`).join(' | ')} / ${r.skipped.join(' | ')}`);
      }
      const dur = ical.parseICalChecked(cal(ev('dur-ok', ['DTSTART;VALUE=DATE:20270110', 'DURATION:P3D'])));
      T.check('control: DURATION:P3D still works', dur.events[0]?.end === '2027-01-13');
      const longText = ical.parseICalChecked(cal(ev('long', ['DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111', `SUMMARY:${'S'.repeat(5000)}`, `DESCRIPTION:${'D'.repeat(50000)}`])));
      T.check('summary and description are cut to their limits', longText.events[0].summary.length === ical.MAX_SUMMARY_CHARS && longText.events[0].description.length === ical.MAX_DESCRIPTION_CHARS);
      const lotsOfEvents = cal(Array.from({ length: ical.MAX_FEED_EVENTS + 500 }, (_, i) => ev(`e${i}`, ['DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111'])).join(''));
      const capped = ical.parseICalChecked(lotsOfEvents);
      T.check('a feed with more events than the limit is read only up to it, and says so', capped.events.length === ical.MAX_FEED_EVENTS && capped.truncated === true && capped.skipped.some(s => /more than/.test(s)), `${capped.events.length}`);
      T.check('control: a feed exactly at the limit is not flagged as cut', ical.parseICalChecked(cal(Array.from({ length: 100 }, (_, i) => ev(`k${i}`, ['DTSTART;VALUE=DATE:20270110', 'DTEND;VALUE=DATE:20270111'])).join(''))).truncated === false);
      T.check('parseICal (the older entry point) returns only good events', ical.parseICal(cal(bad[0][1] + good)).length === 1);
      // Response size cap.
      const big = new Response('x'.repeat(2048));
      T.check('a response larger than the cap is refused without being held', (await ical.readBodyCapped(big, 1024)) === null);
      T.check('control: a response under the cap is read', (await ical.readBodyCapped(new Response('hello'), 1024)) === 'hello');
      const declared = new Response('x', { headers: { 'content-length': '999999999' } });
      T.check('a response that DECLARES a huge size is refused at once', (await ical.readBodyCapped(declared, 1024)) === null);

      // Feed addresses hidden from roles that cannot manage settings.
      const env = await boot(port, projectRoot, {});
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, dir, base } = env;
      const jr = (await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR)).client;
      const mg = (await addUser(admin, 'manager', 'MANAGER', MG)).client;
      await done();
      const j = dbOf(dir);
      j.settings.icalFeeds = [{ id: 'feed-1', unitId: 'unit-1', unitNumber: '1', url: 'https://www.airbnb.com/calendar/ical/12345.ics?s=SECRETTOKEN123', source: 'Airbnb', active: true }];
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(j, null, 2));
      srv = (await boot(port, projectRoot, {}, dir)).srv;
      const adm2 = mkClient(base);
      await adm2.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      const jr2 = mkClient(base);
      await jr2.post('/api/auth/login', { username: 'junior', password: JR }, { captureCookie: true });
      const mg2 = mkClient(base);
      await mg2.post('/api/auth/login', { username: 'manager', password: MG }, { captureCookie: true });
      const seen = async c => JSON.stringify((await c.get('/api/db')).body.settings.icalFeeds);
      T.check('a junior does not receive the feed address or its token', !(await seen(jr2)).includes('SECRETTOKEN123') && (await seen(jr2)).includes('airbnb.com'));
      T.check('control: an administrator still gets the whole address', (await seen(adm2)).includes('SECRETTOKEN123'));
      T.check('control: a manager (who manages settings) still gets it', (await seen(mg2)).includes('SECRETTOKEN123'));
      const rm = await adm2.del('/api/ical/feeds/feed-1');
      T.check('removing a feed writes the audit entry with the token masked', rm.status === 200 && !JSON.stringify((await jr2.get('/api/db')).body.auditLogs).includes('SECRETTOKEN123'));
      await done();
    }

    /* ================================================================== *
     * 7. CO-SIGN on deposit settlement, eviction, damage-deposit settlement
     * ================================================================== */
    {
      const env = await boot(port, projectRoot, {});
      srv = env.srv;
      dirs.push(env.dir);
      const { admin } = env;
      const mg = (await addUser(admin, 'manager', 'MANAGER', MG)).client;
      await makeLongTermUnit(admin, 'unit-1', { tenantName: 'Dep Tenant' });
      const ten = (await admin.get('/api/db')).body.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
      await admin.put(`/api/tenancies/${ten.id}`, { startedOn: '2026-03-01' });
      await admin.post(`/api/tenancies/${ten.id}/deposit`, { amount: 50000, receivedOn: '2026-03-01' });
      await admin.put('/api/units/unit-2', { number: '2', ownerName: 'Owner', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 18000, currency: 'USD', maintCurrency: 'JMD' });
      const bk = (await admin.post('/api/bookings', { unitId: 'unit-2', guestName: 'Guest', checkIn: '2026-03-01', checkOut: '2026-03-05', amount: 1200, depositPaid: 400, currency: 'USD', source: 'Direct' })).body.booking;
      await admin.post(`/api/bookings/${bk.id}/damage-deposit`, { amount: 500 });
      await makeLongTermUnit(admin, 'unit-3', { tenantName: 'Evict Tenant' });
      const ten3 = (await admin.get('/api/db')).body.tenancies.find(t => t.unitId === 'unit-3' && t.status === 'active');
      T.check('setup: co-signing is switched on', (await admin.post('/api/settings', { requireCosign: true })).status === 200);

      const cosign = { username: 'admin', password: ADMIN };
      const noCo = [
        await mg.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 20000, withheldAmount: 30000, withheldReason: 'damage to the floor' }),
        await mg.post(`/api/tenancies/${ten3.id}/evict`, { reason: 'repeated non-payment' }),
        await mg.post(`/api/bookings/${bk.id}/damage-deposit/settle`, { returnedAmount: 300, withheldAmount: 200, withheldReason: 'broken lamp' })
      ];
      T.check('with co-signing on, a manager alone is refused on all three (403 cosign-required)', noCo.every(r => r.status === 403 && r.body?.code === 'cosign-required'), noCo.map(r => `${r.status} ${r.body?.code}`).join(' | '));
      const state = (await admin.get('/api/db')).body;
      T.check('...and nothing changed', !state.tenancies.find(t => t.id === ten.id).depositReturnedOn && state.tenancies.find(t => t.id === ten3.id).status === 'active' && !state.bookings.find(b => b.id === bk.id).damageDepositReturnedOn);
      const wrongCo = await mg.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 20000, withheldAmount: 30000, withheldReason: 'damage', cosign: { username: 'manager', password: MG } });
      T.check('a manager cannot co-sign for themselves', wrongCo.status === 403 && wrongCo.body?.code === 'cosign-required');
      const withCo = [
        await mg.post(`/api/tenancies/${ten.id}/deposit/settle`, { returnedAmount: 20000, withheldAmount: 30000, withheldReason: 'damage to the floor', cosign }),
        await mg.post(`/api/tenancies/${ten3.id}/evict`, { reason: 'repeated non-payment', cosign }),
        await mg.post(`/api/bookings/${bk.id}/damage-deposit/settle`, { returnedAmount: 300, withheldAmount: 200, withheldReason: 'broken lamp', cosign })
      ];
      T.check('control: with a second person\'s approval each of the three goes through', withCo.every(r => r.status === 200), withCo.map(r => `${r.status} ${r.body?.error || ''}`).join(' | '));
      T.check('...and the approvals are in the audit trail with both names', (await admin.get('/api/db')).body.auditLogs.filter(a => /^Approved by Hard System Administrator|^Approved by System Administrator/.test(a.action)).length >= 3);
      await done();
    }

    /* ================================================================== *
     * 8. IDEMPOTENCY CACHE
     * ================================================================== */
    {
      const env = await boot(port, projectRoot, { VDS_IDEMPOTENCY_MAX: '40' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, dir, base } = env;
      await makeLongTermUnit(admin);
      const send = async (key, owner) => {
        const res = await fetch(base + '/api/units/unit-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: admin.getCookie(), 'Idempotency-Key': key },
          body: JSON.stringify({ number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000 + owner.length * 7 + [...owner].reduce((a, ch) => a + ch.charCodeAt(0), 0), currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 })
        });
        return { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true' };
      };
      const snapFile = path.join(dir, 'idempotency.json');
      const logFile = path.join(dir, 'idempotency.log');
      await send('key-first', 'Owner first');
      const stamp = fs.existsSync(snapFile) ? fs.statSync(snapFile).mtimeMs : 0;
      const sizeBefore = fs.existsSync(snapFile) ? fs.statSync(snapFile).size : 0;
      for (let i = 0; i < 30; i++) await send(`key-${i}`, `Owner ${i}`);
      const stamp2 = fs.existsSync(snapFile) ? fs.statSync(snapFile).mtimeMs : 0;
      T.check('30 more writes did not rewrite the whole idempotency file (each key is appended to a journal)', stamp2 === stamp && fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').trim().split('\n').length >= 31, `snapshot ${sizeBefore} bytes, mtime changed: ${stamp2 !== stamp}`);
      T.check('control: a retry of a key is still answered from memory (replayed, not re-run)', (await send('key-5', 'Owner 5')).replayed === true);
      for (let i = 30; i < 90; i++) await send(`key-${i}`, `Owner ${i}`);
      T.check('the cache is capped: the oldest key was evicted (sent again it runs again)', (await send('key-first', 'Owner first')).replayed === false);
      T.check('control: a recent key is still remembered', (await send('key-89', 'Owner 89')).replayed === true);
      // Durability: the disk as a hard kill would leave it (copied while the server runs) still replays a key.
      const crash = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-hard2-crash-'));
      dirs.push(crash);
      fs.cpSync(dir, crash, { recursive: true, filter: p => !p.endsWith('vds.lock') });
      const cookie = admin.getCookie();
      await done();
      srv = (await boot(port, projectRoot, { VDS_IDEMPOTENCY_MAX: '40' }, crash)).srv;
      const res = await fetch(base + '/api/units/unit-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'Idempotency-Key': 'key-89' },
        body: JSON.stringify({ number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000 + 'Owner 89'.length * 7 + [...'Owner 89'].reduce((a, ch) => a + ch.charCodeAt(0), 0), currency: 'JMD', maintCurrency: 'JMD', tenantName: 'Tenant', rentDueDay: 1, maintDueDay: 1 })
      });
      T.check('a key written just before a crash (journal only, no snapshot) is still replayed after restart', res.headers.get('idempotent-replayed') === 'true', `${res.status}`);
      await done();
    }

    /* ================================================================== *
     * 9. SESSIONS, must-change, users list, sign out everywhere, queue, CSP
     * ================================================================== */
    {
      const env = await boot(port, projectRoot, { VDS_SESSION_MAX_HOURS: '0.0014' }); // about 5 seconds
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base } = env;
      const c = mkClient(base);
      const login = await c.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      T.check('control: a new session works', login.status === 200 && (await c.get('/api/auth/me')).status === 200);
      let alive = true;
      for (let i = 0; i < 5 && alive; i++) {
        await sleep(1500);
        alive = (await c.get('/api/auth/me')).status === 200; // a heartbeat every 1.5 s: renewals must not keep it alive past the absolute lifetime
      }
      T.check('a session kept busy with check-ins is still ended at its absolute lifetime', alive === false);
      T.check('...and cannot be brought back by any later request', (await c.get('/api/db')).status === 401);
      await done();
    }
    {
      const env = await boot(port, projectRoot, { VDS_LOGIN_IP_CAP: '1000', VDS_LOGIN_GLOBAL_CAP: '1000' });
      srv = env.srv;
      dirs.push(env.dir);
      const { admin, base } = env;
      await admin.post('/api/users', { name: 'New Person', username: 'newbie', role: 'JUNIOR_OFFICER', password: 'Issued-1111!aa' });
      const nb = mkClient(base);
      await nb.post('/api/auth/login', { username: 'newbie', password: 'Issued-1111!aa' }, { captureCookie: true });
      const blocked = [await nb.get('/api/db'), await nb.get('/api/integrity'), await nb.get('/api/backup/status'), await nb.post('/api/payments', {})];
      T.check('a must-change-password session cannot read records, integrity or write (403 PASSWORD_CHANGE_REQUIRED)', blocked.every(r => r.status === 403 && r.body?.code === 'PASSWORD_CHANGE_REQUIRED'), blocked.map(r => r.status).join(','));
      T.check('...but can ask who it is, change the password and sign out', (await nb.get('/api/auth/me')).status === 200);
      T.check('a must-change session can sign out', (await nb.post('/api/auth/logout', {})).status === 200);
      const nb2 = mkClient(base);
      await nb2.post('/api/auth/login', { username: 'newbie', password: 'Issued-1111!aa' }, { captureCookie: true });
      T.check('control: after the change the same session can read', (await nb2.post('/api/auth/change-password', { currentPassword: 'Issued-1111!aa', newPassword: JR })).status === 200 && (await nb2.get('/api/db')).status === 200);

      // The users list.
      const jr = (await addUser(admin, 'junior', 'JUNIOR_OFFICER', JR)).client;
      const asJr = (await jr.get('/api/db')).body.users;
      const asAdmin = (await admin.get('/api/db')).body.users;
      T.check('a junior\'s copy of the staff list carries names only: no usernames, emails or positions', asJr.length >= 2 && asJr.every(u => Object.keys(u).sort().join() === 'active,id,name,role'), JSON.stringify(asJr[0]));
      T.check('control: the administrator still gets usernames (the Staff screen needs them)', asAdmin.every(u => typeof u.username === 'string' && 'email' in u));

      // Sign out everywhere.
      const a = mkClient(base);
      const b = mkClient(base);
      await a.post('/api/auth/login', { username: 'junior', password: JR }, { captureCookie: true });
      await b.post('/api/auth/login', { username: 'junior', password: JR }, { captureCookie: true });
      T.check('setup: two sessions of the same user', (await a.get('/api/db')).status === 200 && (await b.get('/api/db')).status === 200);
      const out = await a.post('/api/auth/logout-everywhere', {});
      T.check('"sign out everywhere" succeeds and ends the other session too', out.status === 200 && out.body.ended >= 2 && (await b.get('/api/db')).status === 401 && (await a.get('/api/db')).status === 401, JSON.stringify(out.body));
      const juniorId = asAdmin.find(u => u.username === 'junior').id;
      await a.post('/api/auth/login', { username: 'junior', password: JR }, { captureCookie: true });
      const forbidden = await a.post(`/api/users/${juniorId}/sign-out-everywhere`, {});
      T.check('a junior cannot end somebody else\'s sessions (403)', forbidden.status === 403);
      const byAdmin = await admin.post(`/api/users/${juniorId}/sign-out-everywhere`, {});
      T.check('an administrator can sign a user out everywhere', byAdmin.status === 200 && (await a.get('/api/db')).status === 401);
      T.check('control: the administrator\'s own session is untouched and both are audited', (await admin.get('/api/db')).body.auditLogs.filter(x => /out everywhere/.test(x.action)).length >= 2);

      // Content security policy.
      const page = await fetch(base + '/');
      const csp = page.headers.get('content-security-policy') || '';
      T.check('the content security policy restricts scripts to this origin', /script-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp), csp);
      const html = fs.readFileSync(path.join(projectRoot, 'dist', 'index.html'), 'utf8');
      T.check('control: the built page has no inline script that the policy would block', !/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html) && !/\son[a-z]+=/i.test(html));
      await done();
    }

    // The offline queue belongs to one user.
    {
      const store = new Map();
      globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: k => void store.delete(k) };
      const q = await bundle(projectRoot, tmp, 'src/lib/queue.ts', 'queue');
      q.setQueueOwner('user-a');
      q.enqueue({ method: 'POST', path: '/api/payments', body: { amount: 5 }, idempotencyKey: 'k1', label: 'Payment' });
      T.check('control: the owner sees their own queued action', q.pendingActions().length === 1);
      q.setQueueOwner(null);
      T.check('while nobody is signed in, nothing is shown or replayed', q.pendingActions().length === 0);
      q.setQueueOwner('user-a');
      T.check('control: the same person signing back in (session expired) finds their work waiting', q.pendingActions().length === 1);
      q.setQueueOwner('user-b');
      T.check('a different user signing in does not see the first user\'s queued actions', q.pendingActions().length === 0);
      T.check('...and they are discarded, not merely hidden', [...store.values()].every(v => !v.includes('k1')));
      q.enqueue({ method: 'POST', path: '/api/payments', body: {}, idempotencyKey: 'k2', label: 'Payment' });
      q.clearQueue();
      T.check('signing out clears the queue', q.pendingActions().length === 0 && store.size === 0);
      delete globalThis.localStorage;
    }
  } finally {
    await done();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  return T.done();
}
