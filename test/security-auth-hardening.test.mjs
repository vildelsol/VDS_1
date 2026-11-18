/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three security fixes, each pinned to its exact refusal with a positive control:
 *  1. sign-in throttling per (username, address) instead of a per-account lockout;
 *  2. the audit chain keyed with an HMAC whose key lives outside db.json;
 *  3. money-guard overrides restricted, reasoned and audit-logged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Security: sign-in throttle, keyed audit chain, money-guard overrides';

const ADMIN0 = 'Harden-Init-1234!';
const ADMIN = 'Harden-Admin-9876!';
const plainSeal = e => crypto.createHash('sha256').update(JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || ''])).digest('hex');
/** What somebody who can edit db.json but not read the key can do: re-seal the whole chain the old way. */
const rechainPlain = logs => {
  for (let i = logs.length - 1; i >= 0; i--) {
    delete logs[i].sealKind;
    logs[i].prevSeal = logs[i + 1]?.seal || '';
    logs[i].seal = plainSeal(logs[i]);
  }
};

async function loadThrottleModule(projectRoot, outDir) {
  const out = path.join(outDir, 'loginThrottle.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'server/loginThrottle.ts')], outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-harden-'));
  let srv;
  try {
    /* ---------------- 1a. the throttle itself, on a clock the test controls ---------------- */
    const { LoginThrottle, FREE_FAILURES, BASE_DELAY_MS, MAX_DELAY_MS } = await loadThrottleModule(projectRoot, dir);
    let now = 1_000_000;
    const th = new LoginThrottle(() => now);
    for (let i = 1; i < FREE_FAILURES; i++) th.fail('10.0.0.5', 'victim');
    T.check('control: mistyping a few times is not throttled', th.check('10.0.0.5', 'victim').allowed === true);
    const firstBlock = th.fail('10.0.0.5', 'victim');
    const blocked = th.check('10.0.0.5', 'victim');
    T.check('the next failure blocks that address for the base delay', firstBlock === BASE_DELAY_MS && blocked.allowed === false && blocked.retryAfterMs === BASE_DELAY_MS, JSON.stringify(blocked));
    T.check('the SAME username from another address is not blocked (no account lockout)', th.check('10.0.0.9', 'victim').allowed === true);
    now += BASE_DELAY_MS;
    T.check('the block ends when its time is up', th.check('10.0.0.5', 'victim').allowed === true);
    const second = th.fail('10.0.0.5', 'victim');
    T.check('the next block is twice as long (exponential backoff)', second === BASE_DELAY_MS * 2, `${second}`);
    let last = 0;
    for (let i = 0; i < 30; i++) {
      now += MAX_DELAY_MS + 1;
      last = th.fail('10.0.0.5', 'victim');
    }
    T.check('the backoff is capped', last === MAX_DELAY_MS, `${last}`);
    th.fail('10.0.0.9', 'victim');
    th.succeed('10.0.0.9', 'victim');
    T.check('a correct password resets that address', th.failuresFor('10.0.0.9', 'victim') === 0);
    T.check('...and only that address', th.failuresFor('10.0.0.5', 'victim') > 0);
    th.fail('10.0.0.9', 'victim');
    T.check('an Administrator clear removes the username at every address', th.clearUser('victim') === 2 && th.check('10.0.0.5', 'victim').allowed === true);

    /* ---------------- 1b. through the server ---------------- */
    srv = await startServer({ port, adminPassword: ADMIN0, projectRoot, dataDir: dir });
    const admin = makeClient(srv.baseUrl, { autoConfirmDuplicates: false, autoOverrideReason: false });
    await activateAdmin(admin, ADMIN0, ADMIN);
    await makeLongTermUnit(admin);
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoConfirmDuplicates: false, autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    const anon = makeClient(srv.baseUrl);
    const tryLogin = pw => anon.post('/api/auth/login', { username: 'junior', password: pw }, { noCookie: true });
    for (let i = 0; i < FREE_FAILURES - 1; i++) await tryLogin('wrong-' + i);
    T.check('control: the right password still works after a few failures', (await tryLogin('JuniorOwn-22!')).status === 200);
    for (let i = 0; i < FREE_FAILURES - 1; i++) await tryLogin('wrong-again-' + i);
    T.check('...and that success reset the count (four more failures do not block)', (await tryLogin('JuniorOwn-22!')).status === 200);
    for (let i = 0; i < FREE_FAILURES; i++) await tryLogin('guess-' + i);
    const refused = await tryLogin('JuniorOwn-22!');
    T.check('after repeated failures this address is refused with exactly 429 sign-in-throttled', refused.status === 429 && refused.body?.code === 'sign-in-throttled', `${refused.status} ${refused.body?.code}`);
    const logs1 = (await admin.get('/api/db')).body.auditLogs;
    T.check('the throttle is audit-logged', logs1.some(a => /Sign-in blocked after too many failed attempts for "junior"/.test(a.action)));
    const list = await admin.get('/api/auth/throttles');
    T.check('an Administrator can see the throttle', list.status === 200 && list.body.throttles.some(t => t.username === 'junior' && t.blockedForSeconds > 0), JSON.stringify(list.body));
    const jrClear = await jr.post('/api/auth/throttles/clear', { username: 'junior' });
    T.check('a non-administrator cannot clear it (exactly 403)', jrClear.status === 403, `${jrClear.status}`);
    const clear = await admin.post('/api/auth/throttles/clear', { username: 'junior' });
    T.check('an Administrator clears it', clear.status === 200 && clear.body.cleared === 1, JSON.stringify(clear.body));
    T.check('and the user can sign in at once', (await tryLogin('JuniorOwn-22!')).status === 200);
    T.check('the clear is audit-logged', (await admin.get('/api/db')).body.auditLogs.some(a => /Cleared the sign-in throttle for "junior"/.test(a.action)));

    /* ---------------- 3. money-guard overrides ---------------- */
    await admin.post('/api/charges/post-month', { monthString: '2026-07' });
    const base = { unitId: 'unit-1', category: 'Other', currency: 'JMD', payerName: 'Desk', method: 'Cash' };
    T.check('setup: admin records a receipt', (await admin.post('/api/payments', { ...base, amount: 4321 })).status === 200);
    const dupNoFlag = await jr.post('/api/payments', { ...base, amount: 4321 });
    T.check('control: the duplicate guard fires for the junior', dupNoFlag.status === 400 && dupNoFlag.body?.code === 'possible-duplicate-payment', `${dupNoFlag.status} ${dupNoFlag.body?.code}`);
    const dupJr = await jr.post('/api/payments', { ...base, amount: 4321, confirmDuplicate: true, overrideReason: 'they paid twice, really' });
    T.check('a junior cannot override the duplicate guard: exactly 403 override-not-permitted', dupJr.status === 403 && dupJr.body?.code === 'override-not-permitted', `${dupJr.status} ${dupJr.body?.code}`);
    const settledJr = await jr.post('/api/payments', { ...base, category: 'Rent', amount: 999999, confirmAlreadySettled: true, overrideReason: 'trust me', receivedNow: true });
    T.check('a junior cannot push past the already-settled guard: exactly 403 override-not-permitted', settledJr.status === 403 && settledJr.body?.code === 'override-not-permitted', `${settledJr.status} ${settledJr.body?.code}`);
    const mismJr = await jr.post('/api/payments', { ...base, category: 'Rent', currency: 'USD', amount: 5, confirmCurrencyMismatch: true, overrideReason: 'dollars' });
    T.check('a junior cannot override the currency guard: exactly 403 override-not-permitted', mismJr.status === 403 && mismJr.body?.code === 'override-not-permitted', `${mismJr.status} ${mismJr.body?.code}`);
    T.check('control: a junior still takes an ordinary payment (flag sent, nothing to override)', (await jr.post('/api/payments', { ...base, amount: 777, confirmDuplicate: true })).status === 200);
    const dupAdminNoReason = await admin.post('/api/payments', { ...base, amount: 4321, confirmDuplicate: true });
    T.check('an Administrator override without a reason: exactly 400 override-reason-required', dupAdminNoReason.status === 400 && dupAdminNoReason.body?.code === 'override-reason-required', `${dupAdminNoReason.status} ${dupAdminNoReason.body?.code}`);
    const dupAdmin = await admin.post('/api/payments', { ...base, amount: 4321, confirmDuplicate: true, overrideReason: 'two separate envelopes' });
    T.check('an Administrator override with a reason is accepted', dupAdmin.status === 200, `${dupAdmin.status} ${JSON.stringify(dupAdmin.body)}`);
    T.check('and is audit-logged with the reason', (await admin.get('/api/db')).body.auditLogs.some(a => /Overrode a money check: a possible duplicate/.test(a.action) && /two separate envelopes/.test(a.action) && a.role === 'ADMINISTRATOR'));
    await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { recordPayments: true, addBookings: true, overrideMoneyGuards: true } } });
    const granted = await jr.post('/api/payments', { ...base, amount: 4321, confirmDuplicate: true, overrideReason: 'granted in settings' });
    T.check('the dedicated permission, once granted in Settings, lets that role override', granted.status === 200, `${granted.status} ${granted.body?.code}`);

    /* ---------------- 2. the keyed audit chain ---------------- */
    const keyFile = path.join(dir, 'audit-key.json');
    const dbFile = path.join(dir, 'db.json');
    T.check('the audit key is created in the data folder', fs.existsSync(keyFile));
    if (process.platform !== 'win32') T.check('readable by the owner only', fs.existsSync(keyFile) && (fs.statSync(keyFile).mode & 0o777) === 0o600);
    const keyHex = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).key : 'no-key-file';
    await new Promise(r => setTimeout(r, 300));
    const dbText = fs.readFileSync(dbFile, 'utf8');
    T.check('the key is not inside db.json', !dbText.includes(keyHex));
    const logs = JSON.parse(dbText).auditLogs;
    T.check('new entries are keyed', logs.length > 5 && logs.every(e => e.sealKind === 'hmac-sha256'));
    const integ = async c => ((await c.get('/api/integrity')).body.findings || []).map(f => f.code);
    T.check('control: the untouched keyed chain verifies', !(await integ(admin)).includes('audit-trail-broken'));

    const snapshot = await admin.get('/api/backup/download');
    const restore = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: JSON.parse(snapshot.text), confirm: 'RESTORE' });
    T.check('a snapshot restore still works with the key in place', restore.status === 200 && !(await integ(admin)).includes('audit-trail-broken'), `${restore.status}`);
    await srv.stop();

    const restart = async () => {
      srv = await startServer({ port, adminPassword: ADMIN0, projectRoot, dataDir: dir });
      const c = makeClient(srv.baseUrl);
      await c.post('/api/auth/login', { username: 'admin', password: ADMIN }, { captureCookie: true });
      return c;
    };
    const pristine = fs.readFileSync(dbFile, 'utf8');
    const tamper = async mutate => {
      const j = JSON.parse(pristine);
      mutate(j);
      fs.writeFileSync(dbFile, JSON.stringify(j, null, 2));
      const c = await restart();
      const codes = await integ(c);
      await srv.stop();
      return codes;
    };
    let codes = await tamper(j => {
      j.auditLogs[3].action = 'rewritten history';
      rechainPlain(j.auditLogs);
    });
    T.check('rewriting an entry and re-sealing the whole chain without the key is detected', codes.includes('audit-trail-broken'), codes.join(','));
    codes = await tamper(j => {
      j.auditLogs[3].action = 'rewritten history';
      const wrong = crypto.randomBytes(32);
      for (let i = j.auditLogs.length - 1; i >= 0; i--) {
        const e = j.auditLogs[i];
        e.prevSeal = j.auditLogs[i + 1]?.seal || '';
        e.seal = crypto.createHmac('sha256', wrong).update('hmac-sha256\u0000' + JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || ''])).digest('hex');
      }
    });
    T.check('re-sealing with a guessed key is detected', codes.includes('audit-trail-broken'), codes.join(','));

    // Upgrade from an unkeyed chain: no key file, every entry sealed the old way, all dated in the past.
    if (fs.existsSync(keyFile)) fs.renameSync(keyFile, keyFile + '.held');
    codes = await tamper(j => {
      for (const e of j.auditLogs) e.dateTime = '2026-01-01T00:00:00.000Z';
      rechainPlain(j.auditLogs);
    });
    T.check('an existing unkeyed chain still verifies after the upgrade', !codes.includes('audit-trail-broken') && !codes.includes('audit-key-missing'), codes.join(','));
    const upgraded = JSON.parse(fs.readFileSync(dbFile, 'utf8')).auditLogs;
    T.check('...a fresh key was made for it, and the new entries are keyed on top of the old ones', fs.existsSync(keyFile) && upgraded[0].sealKind === 'hmac-sha256' && upgraded[upgraded.length - 1].sealKind === undefined);
    fs.rmSync(keyFile);
    fs.renameSync(keyFile + '.held', keyFile);

    // The key goes missing while the chain is keyed.
    fs.writeFileSync(dbFile, pristine);
    fs.renameSync(keyFile, keyFile + '.held');
    let c = await restart();
    codes = await integ(c);
    T.check('a missing key with a keyed chain is reported as audit-key-missing', codes.includes('audit-key-missing'), codes.join(','));
    T.check('...and a new key was NOT generated over it', !fs.existsSync(keyFile));
    await srv.stop();
    fs.renameSync(keyFile + '.held', keyFile);
    fs.writeFileSync(dbFile, pristine);
    c = await restart();
    codes = await integ(c);
    T.check('control: with the key put back the finding is gone', !codes.includes('audit-key-missing') && !codes.includes('audit-trail-broken'), codes.join(','));
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
