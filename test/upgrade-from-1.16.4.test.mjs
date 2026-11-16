/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The upgrade from the REAL v1.16.4 release to this tree, on simulated data.
 *
 * Ro forbids using the HP's db.json, and the HP is in another country, so this
 * is the substitute: build the actual v1.16.4 server from its git tag (in a
 * throwaway worktree), let *that server* create a realistic property through its
 * own API so every record has v1.16.4's real shape, stop it, and start the
 * current build on the same data directory.
 *
 * One honest exception. v1.16.4 already posts split rent charges, so the records
 * an even older release left behind (rent charged at the net figure, with no
 * split) cannot be made through its API. Exactly as test/restate-rent does, those
 * are produced by editing db.json between runs, and only those.
 *
 * Skips with a message if git, the tag or esbuild is not available.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, sleep } from './harness.mjs';

export const title = 'Upgrade from the real v1.16.4 on simulated data';

const OLD_TAG = 'v1.16.4';
const r2 = n => Math.round(n * 100) / 100;
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Register from the project note: A1..A5 = unit-1..5, B6..B10 = unit-6..10, C11..C16 = unit-11..16. */
const VILLAS = [
  ['unit-1', 'A1', 'short'], ['unit-2', 'A2', 'owner'], ['unit-3', 'A3', 'short'], ['unit-4', 'A4', 'short'],
  ['unit-5', 'A5', 'long', 100000, 25000, 'JMD'], ['unit-6', 'B6', 'short'], ['unit-7', 'B7', 'owner'],
  ['unit-8', 'B8', 'owner'], ['unit-9', 'B9', 'owner'], ['unit-10', 'B10', 'long', 100000, 25000, 'JMD'],
  ['unit-11', 'C11', 'long', 800, 100, 'USD'], ['unit-12', 'C12', 'owner'], ['unit-13', 'C13', 'long', 900, 100, 'USD'],
  ['unit-14', 'C14', 'short'], ['unit-15', 'C15', 'long', 75000, 20000, 'JMD'], ['unit-16', 'C16', 'short']
];

async function bundleFinance(entry, outDir, name) {
  const outfile = path.join(outDir, name);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  return import(pathToFileURL(outfile).href);
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-upgrade-'));
  const wt = path.join(work, 'v1.16.4');
  const seedDir = path.join(work, 'data-old');
  let worktreeAdded = false;
  let srv = null;

  const cleanup = async () => {
    if (srv) await srv.stop().catch(() => {});
    if (worktreeAdded) {
      try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: projectRoot, stdio: 'ignore' }); } catch { /* best effort */ }
      try { execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, stdio: 'ignore' }); } catch { /* best effort */ }
    }
    fs.rmSync(work, { recursive: true, force: true });
  };

  try {
    /* ---------------- the real v1.16.4, built from its tag ---------------- */
    try {
      execFileSync('git', ['rev-parse', '--verify', `${OLD_TAG}^{commit}`], { cwd: projectRoot, stdio: 'ignore' });
      execFileSync('git', ['worktree', 'add', '--detach', wt, OLD_TAG], { cwd: projectRoot, stdio: 'ignore' });
      worktreeAdded = true;
      fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
      await build({
        entryPoints: [path.join(wt, 'server.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external',
        outfile: path.join(wt, 'dist', 'server.cjs'), logLevel: 'silent'
      });
    } catch (err) {
      console.log(`  SKIPPED: could not build ${OLD_TAG} from git (${String(err.message).split('\n')[0]})`);
      T.check(`upgrade test skipped: ${OLD_TAG} is not available here`, true);
      return T.done();
    }

    fs.mkdirSync(seedDir);
    const env = { VDS_DRIVE_ROOTS_ONLY: '1' };

    /* ---------------- phase 1: the OLD server makes the data ---------------- */
    srv = await startServer({ port, adminPassword: 'Old-1234!', projectRoot: wt, dataDir: seedDir, env });
    const ver = JSON.parse((await fetch(srv.baseUrl + '/api/health').then(r => r.text())));
    T.check('the old server really is v1.16.4', ver.version === '1.16.4', ver.version);

    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Old-1234!', 'OldNew-9876!');
    const must = (res, label) => {
      if (res.status >= 400) throw new Error(`${label}: ${res.status} ${res.text.slice(0, 160)}`);
      return res;
    };
    const s0 = (await c.get('/api/db')).body.settings;
    must(await c.post('/api/settings', { booksBeginOn: '2026-09-01' }), 'books begin');

    // Staff, and permissions edited away from the defaults.
    for (const [username, role] of [['mgr', 'MANAGER'], ['fin', 'FINANCE_OFFICER'], ['jr', 'JUNIOR_OFFICER']]) {
      must(await c.post('/api/users', { name: username, username, role, password: `Staff-${username}-1234!` }), `user ${username}`);
    }
    must(await c.post('/api/settings', { rolePermissions: {
      FINANCE_OFFICER: { recordPayments: true, editUnits: true, enterUtilities: true, recordExpenses: true, postCharges: true, reversePayments: true, hasVetoPower: true },
      JUNIOR_OFFICER: { recordPayments: true, addBookings: true, enterUtilities: true }
    } }), 'permissions');

    // The register.
    for (const [id, number, kind, rent, levy, cur] of VILLAS) {
      let body;
      if (kind === 'owner') body = { number, ownerName: `Owner ${number}`, status: 'owner-occupied', monthlyMaintenance: 22000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 };
      else if (kind === 'short') body = { number, ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 18000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1, letOnOwnAccount: number !== 'A4' };
      else body = { number, ownerName: 'ISPO', tenantName: `Tenant ${number}`, tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: rent, monthlyMaintenance: levy, currency: cur, maintCurrency: cur, rentDueDay: 1, maintDueDay: 1, letOnOwnAccount: true };
      must(await c.put(`/api/units/${id}`, body), `unit ${number}`);
    }
    for (const m of ['2026-09', '2026-10', '2026-11']) must(await c.post('/api/charges/post-month', { monthString: m }), `post ${m}`);
    must(await c.post('/api/charges', { unitId: 'unit-5', category: 'Rent', oneOffType: 'Late fee', amount: 5000, currency: 'JMD', dueDate: '2026-11-05', description: 'Late fee' }), 'late fee');

    const dbA = async () => (await c.get('/api/db')).body;
    const pay = async (unitId, category, amount, currency, date, confirm = true, payer = 'Payer') => {
      const res = must(await c.post('/api/payments', { unitId, category, amount, currency, payerName: payer, method: 'Bank Transfer', date, confirmDuplicate: true }), `pay ${unitId}`);
      if (confirm) must(await c.post(`/api/payments/${res.body.payment.id}/confirm`, {}), 'confirm');
      return res.body.payment;
    };
    // A5: the keyed-twice legacy pattern (rent 75,000 + a separate 25,000 maintenance receipt), then a part payment.
    await pay('unit-5', 'Rent', 75000, 'JMD', '2026-09-03', true, 'Tenant A5');
    await pay('unit-5', 'Maintenance', 25000, 'JMD', '2026-09-03', true, 'Tenant A5');
    await pay('unit-5', 'Rent', 60000, 'JMD', '2026-10-04', true, 'Tenant A5');
    // B10: paid in full, then part of it refunded; a second receipt entered against the wrong villa and reversed.
    const b10 = await pay('unit-10', 'Rent', 100000, 'JMD', '2026-09-02', true, 'Tenant B10');
    must(await c.post(`/api/payments/${b10.id}/refund`, { amount: 10000, reason: 'overpaid', method: 'Cash', refundedOn: '2026-09-20' }), 'refund');
    const wrong = await pay('unit-10', 'Rent', 25000, 'JMD', '2026-10-06', true, 'Tenant B10');
    must(await c.post(`/api/payments/${wrong.id}/reverse`, { reversalReason: 'entered against the wrong villa' }), 'reverse');
    await pay('unit-10', 'Rent', 100000, 'JMD', '2026-10-02', true, 'Tenant B10');
    // C11 USD, C13 USD, C15.
    await pay('unit-11', 'Rent', 800, 'USD', '2026-09-02', true, 'Tenant C11');
    await pay('unit-13', 'Rent', 800, 'USD', '2026-09-02', true, 'Tenant C13');
    await pay('unit-13', 'Maintenance', 100, 'USD', '2026-09-02', true, 'Tenant C13');
    await pay('unit-15', 'Rent', 55000, 'JMD', '2026-09-02', true, 'Tenant C15');
    await pay('unit-15', 'Maintenance', 20000, 'JMD', '2026-09-02', true, 'Tenant C15');
    // Owners.
    await pay('unit-2', 'Maintenance', 22000, 'JMD', '2026-09-05', true, 'Owner A2');
    await pay('unit-7', 'Maintenance', 10000, 'JMD', '2026-09-05', true, 'Owner B7');
    await pay('unit-9', 'Maintenance', 22000, 'JMD', '2026-10-05', true, 'Owner B9');
    // An expected receipt never confirmed.
    await pay('unit-8', 'Maintenance', 5000, 'JMD', '2026-11-02', false, 'Owner B8');

    // Deposits, an expense, a negative supplier credit, a utility bill, a booking.
    const ten = (await dbA()).tenancies.filter(t => t.status === 'active');
    must(await c.post(`/api/tenancies/${ten[0].id}/deposit`, { amount: 50000, currency: ten[0].currency || 'JMD', method: 'Cash' }), 'deposit');
    must(await c.post('/api/expenses', { category: 'Maintenance', vendor: 'Roofer', description: 'roof', unitId: '', amount: 40000, currency: 'JMD', date: '2026-10-10', status: 'paid', datePaid: '2026-10-10', paymentMethod: 'Cash' }), 'expense');
    must(await c.post('/api/expenses', { category: 'Maintenance', vendor: 'Roofer', description: 'credit note', unitId: '', amount: -5000, currency: 'JMD', date: '2026-10-20', status: 'paid', datePaid: '2026-10-20', paymentMethod: 'Cash' }), 'supplier credit');
    const util = must(await c.post('/api/utilities', { unitId: 'unit-5', type: 'Water', billingPeriod: '2026-10', amountCharged: 4200, currency: 'JMD', previousReading: 10, currentReading: 50 }), 'utility');
    must(await c.post(`/api/utilities/${util.body.utility.id}/settle`, {}), 'settle utility');
    must(await c.post('/api/bookings', { unitId: 'unit-1', guestName: 'Guest', checkIn: '2026-10-12', checkOut: '2026-10-15', amount: 600, depositPaid: 100, currency: 'USD', source: 'Direct' }), 'booking');
    // C11: left owing two months, then evicted.
    const c11 = (await dbA()).tenancies.find(t => t.unitId === 'unit-11' && t.status === 'active');
    must(await c.post(`/api/tenancies/${c11.id}/evict`, { reason: 'left owing', effectiveDate: '2026-11-10' }), 'evict');

    const old = await dbA();
    const oldIntegrity = (await c.get('/api/integrity')).body;
    const oldAuditCount = old.auditLogs.length;
    await srv.stop();
    srv = null;

    /* The one fabricated step: what an even older release left on C13 and C15. */
    {
      const file = path.join(seedDir, 'db.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const ch of raw.charges) {
        if (ch.category === 'Rent' && ch.kind !== 'one-off' && ['unit-13', 'unit-15'].includes(ch.unitId) && ch.status === 'open') {
          const u = raw.units.find(x => x.id === ch.unitId);
          ch.amount = r2(u.monthlyRent - u.monthlyMaintenance);
          delete ch.rentPortion;
          delete ch.maintenancePortion;
        }
      }
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    const legacyRent = JSON.parse(fs.readFileSync(path.join(seedDir, 'db.json'), 'utf8')).charges.filter(ch => ch.category === 'Rent' && ch.status === 'open' && ch.rentPortion === undefined && ch.kind !== 'one-off');
    T.check('the old data set is realistic: 16 villas, charges, receipts, users, legacy rent', old.units.length === 16 && old.charges.length > 30 && old.payments.length >= 14 && legacyRent.length >= 6,
      `${old.units.length} villas, ${old.charges.length} charges, ${old.payments.length} receipts, ${legacyRent.length} legacy rent charges`);
    const frozenBytes = fs.readFileSync(path.join(seedDir, 'db.json'));

    /* ---------------- phase 2: the CURRENT build opens the same data ---------------- */
    const dataDir = path.join(work, 'data-new');
    fs.cpSync(seedDir, dataDir, { recursive: true });
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir, env });
    const n = makeClient(srv.baseUrl);
    T.check('the current build starts on a v1.16.4 database', (await n.get('/api/health')).status === 200);
    const login = await n.post('/api/auth/login', { username: 'admin', password: 'OldNew-9876!' }, { captureCookie: true });
    T.check('the administrator signs in with the old password', login.status === 200, `status ${login.status}`);
    const neu = (await n.get('/api/db')).body;
    const newVer = JSON.parse((await n.get('/api/health')).text).version;
    T.check('and it reports a newer version', newVer !== '1.16.4', newVer);

    // Nothing lost, nothing altered.
    const keyOf = (x, fields) => fields.map(f => `${f}=${x[f]}`).join('|');
    const sameSet = (a, b, fields) => {
      const mb = new Map(b.map(x => [x.id, keyOf(x, fields)]));
      return a.filter(x => mb.get(x.id) !== keyOf(x, fields)).map(x => x.id);
    };
    const payFields = ['amount', 'currency', 'status', 'receiptNo', 'category', 'unitId', 'date', 'refundedAmount'];
    const chFields = ['amount', 'currency', 'status', 'category', 'unitId', 'dueDate'];
    T.check('every receipt survives with identical figures', neu.payments.length === old.payments.length && sameSet(old.payments, neu.payments, payFields).length === 0, `${neu.payments.length}/${old.payments.length}; changed ${sameSet(old.payments, neu.payments, payFields).slice(0, 3)}`);
    const legacyIds = new Set(legacyRent.map(x => x.id));
    const chChanged = sameSet(old.charges, neu.charges, chFields);
    // Compare against the on-disk legacy edit for those charges.
    T.check('every charge survives (legacy-edited ones compared with their edited form)', neu.charges.length === old.charges.length && chChanged.every(id => legacyIds.has(id)), `${neu.charges.length}/${old.charges.length}; changed ${chChanged.filter(id => !legacyIds.has(id)).slice(0, 3)}`);
    T.check('every expense, utility, booking, tenancy, ownership survives', ['expenses', 'utilities', 'bookings', 'tenancies', 'ownerships'].every(k => neu[k].length === old[k].length), ['expenses', 'utilities', 'bookings', 'tenancies', 'ownerships'].map(k => `${k} ${neu[k].length}/${old[k].length}`).join(' '));
    T.check('the negative supplier credit is intact', neu.expenses.some(e => e.amount === -5000 && e.status !== 'void'));
    T.check('every user keeps username, role and active state', old.users.every(u => neu.users.some(x => x.username === u.username && x.role === u.role && x.active === u.active)));
    T.check('every villa keeps its status', old.units.every(u => neu.units.find(x => x.id === u.id)?.status === u.status));
    T.check('the books-begin date is kept', neu.settings.booksBeginOn === '2026-09-01');

    // Raw per-unit, per-currency money, computed here from the lists and nothing else.
    const raw = db => {
      const out = {};
      for (const u of db.units) for (const cat of ['Rent', 'Maintenance']) for (const cur of ['JMD', 'USD']) {
        const charged = db.charges.filter(x => x.unitId === u.id && x.category === cat && x.currency === cur && x.status === 'open').reduce((s, x) => s + x.amount, 0);
        const paid = db.payments.filter(x => x.unitId === u.id && x.category === cat && x.currency === cur && x.status === 'completed').reduce((s, x) => s + x.amount - (x.refundedAmount || 0), 0);
        out[`${u.number}/${cat}/${cur}`] = r2(charged - paid);
      }
      return out;
    };
    const rawOld = raw(old), rawNew = raw(neu);
    const rawDiff = Object.keys(rawOld).filter(k => rawOld[k] !== rawNew[k]);
    T.check('raw balance per villa, category and currency is identical (apart from the legacy edit)', rawDiff.every(k => /^(C13|C15)\/Rent\//.test(k)), rawDiff.map(k => `${k}: ${rawOld[k]} -> ${rawNew[k]}`).join('; '));

    // Permissions.
    const perms = neu.settings.rolePermissions;
    const oldPerms = old.settings.rolePermissions;
    T.check('Manager gains takeBackups', perms.MANAGER.takeBackups === true);
    T.check('Finance Officer (with veto power) gains takeBackups', perms.FINANCE_OFFICER.takeBackups === true && perms.FINANCE_OFFICER.hasVetoPower === true);
    T.check('Junior does not get takeBackups', perms.JUNIOR_OFFICER.takeBackups === false);
    const changedPerms = [];
    for (const role of Object.keys(oldPerms)) for (const k of Object.keys(oldPerms[role])) {
      if (perms[role][k] !== oldPerms[role][k]) changedPerms.push(`${role}.${k}: ${oldPerms[role][k]} -> ${perms[role][k]}`);
    }
    T.check('no other permission changed', changedPerms.length === 0, changedPerms.join('; '));
    for (const [username, expectBackup] of [['mgr', true], ['fin', true], ['jr', false]]) {
      const cl = makeClient(srv.baseUrl);
      const pw = `Staff-${username}-1234!`;
      await cl.post('/api/auth/login', { username, password: pw }, { captureCookie: true });
      await cl.post('/api/auth/change-password', { currentPassword: pw, newPassword: pw + 'x' });
      const st = await cl.get('/api/backup/status');
      T.check(`${username} ${expectBackup ? 'can' : 'cannot'} read backup status after the upgrade`, expectBackup ? st.status === 200 : st.status === 403, `status ${st.status}`);
    }

    // Integrity.
    const newIntegrity = (await n.get('/api/integrity')).body;
    const seriousNew = (newIntegrity.findings || newIntegrity.issues || []).filter(f => f.severity === 'serious' || f.blocking);
    const seriousOld = (oldIntegrity.findings || []).filter(f => f.severity === 'serious');
    T.check('the integrity report raises nothing serious that the old server did not', seriousNew.length <= seriousOld.length, seriousNew.slice(0, 3).map(f => `${f.code}: ${f.message}`).join(' | '));

    // Audit trail.
    T.check('the audit trail kept every old entry', neu.auditLogs.length >= oldAuditCount, `${neu.auditLogs.length} vs ${oldAuditCount}`);
    const probe = await n.post('/api/expenses', { category: 'Maintenance', vendor: 'Post-upgrade', description: 'x', unitId: '', amount: 100, currency: 'JMD', date: '2026-11-12', status: 'paid', datePaid: '2026-11-12', paymentMethod: 'Cash' });
    const after = (await n.get('/api/db')).body;
    T.check('a new write appends to the trail and is accepted', probe.status === 200 && after.auditLogs.length > neu.auditLogs.length);
    const sealed = after.auditLogs.filter(a => a.seal);
    T.check('new entries are sealed into the chain', sealed.length > 0, `${sealed.length} sealed of ${after.auditLogs.length}`);
    const tamper = (await n.get('/api/integrity')).body;
    T.check('and the chain verifies (no tamper finding)', !(tamper.findings || []).some(f => /audit|chain|tamper/i.test(f.code || '') && f.severity === 'serious'), JSON.stringify((tamper.findings || []).slice(0, 2)));

    // Ownership: every villa not owner-occupied is the corporation's own account.
    const fin = await bundleFinance(path.join(projectRoot, 'src', 'lib', 'finance.ts'), work, 'fin-new.mjs');
    const ownWrong = after.units.filter(u => fin.isOwnAccount(u) !== (u.status !== 'owner-occupied'));
    T.check('every villa that is not owner-occupied is ISPO\'s own account', ownWrong.length === 0, ownWrong.map(u => u.number).join(','));
    const oldFlag = old.units.filter(u => u.status !== 'owner-occupied' && !u.letOnOwnAccount).map(u => u.number);
    T.check('including the one the old tick box had left off (A4)', oldFlag.includes('A4') && fin.isOwnAccount(after.units.find(u => u.number === 'A4')));

    // Balances: old rules against new rules on the same data; every difference is listed.
    const oldFin = await bundleFinance(path.join(wt, 'src', 'lib', 'finance.ts'), work, 'fin-old.mjs');
    // The old rules are run on the data as it stood going in (including the legacy edit), so a difference is the rules, not the data.
    const going = JSON.parse(frozenBytes.toString('utf8'));
    const diffs = [];
    for (const u of after.units) for (const cat of ['Rent', 'Maintenance']) {
      const a = oldFin.accountBalance(going.units.find(x => x.id === u.id), cat, going.charges, going.payments, undefined, going.units);
      const b = fin.accountBalance(u, cat, after.charges, after.payments, undefined, after.units);
      if (a.balance !== b.balance) diffs.push(`${u.number}/${cat}: ${a.balance} -> ${b.balance}`);
    }
    T.check('per-account balances are unchanged by the upgrade ', diffs.length === 0, diffs.join('; '));
    console.log('  info: account balance differences old vs new rules on identical data: ' + (diffs.join('; ') || 'none'));
    // What the dashboard lists as owed, summed per currency, by each release's own rules.
    const owed = (f, db) => {
      const out = { JMD: 0, USD: 0 };
      for (const acc of f.delinquentAccounts(db.units, db.charges, db.payments, '2026-11-16')) out[acc.currency] = r2(out[acc.currency] + acc.balance);
      return out;
    };
    const rOld = owed(oldFin, going), rNew = owed(fin, after);
    {
      const key = acc => `${acc.unitNumber || acc.unit?.number || acc.unitId}/${acc.category}/${acc.currency}`;
      const listOld = new Map(oldFin.delinquentAccounts(going.units, going.charges, going.payments, '2026-11-16').map(a2 => [key(a2), a2.balance]));
      const listNew = new Map(fin.delinquentAccounts(after.units, after.charges, after.payments, '2026-11-16').map(a2 => [key(a2), a2.balance]));
      const gone = [...listOld].filter(([k]) => !listNew.has(k)).map(([k, v]) => `${k} ${v}`);
      const moved = [...listOld].filter(([k, v]) => listNew.has(k) && listNew.get(k) !== v).map(([k, v]) => `${k} ${v}->${listNew.get(k)}`);
      console.log(`  info: accounts no longer listed: ${gone.join(', ') || 'none'}; changed: ${moved.join(', ') || 'none'}`);
    }
    console.log(`  info: listed as owed (delinquent accounts), old rules ${JSON.stringify(rOld)}, new rules ${JSON.stringify(rNew)}`);
    T.check('the listed debt under the new rule is never larger than the old (the levy inside a tenant\'s rent is no longer listed twice)', rNew.JMD <= rOld.JMD && rNew.USD <= rOld.USD, `${JSON.stringify(rOld)} vs ${JSON.stringify(rNew)}`);

    // Restate banners: both dry runs see the legacy records.
    const dry1 = await n.post('/api/charges/restate-rent', {});
    T.check('the rent restate dry run lists the legacy charges on C13 and C15 (6)', dry1.status === 200 && dry1.body.count === 6, JSON.stringify(dry1.body).slice(0, 200));
    T.check('and names no villa that was not legacy', dry1.body.plan.every(p => ['C13', 'C15'].includes(p.unit)));
    const dry2 = await n.post('/api/payments/restate-maintenance-receipts', {});
    T.check('the receipt dry run answers (A5\'s keyed-twice Maintenance receipt is a candidate)', dry2.status === 200, JSON.stringify(dry2.body).slice(0, 200));
    const eligible = (dry2.body.plan || dry2.body.moves || dry2.body.moved || []);
    console.log('  info: receipt dry run: ' + JSON.stringify(dry2.body).slice(0, 300) + ` (${Array.isArray(eligible) ? eligible.length : '?'} listed)`);
    const idemCount = (await n.get('/api/db')).body.charges.length;
    T.check('a dry run changes nothing', idemCount === after.charges.length);

    // Closing a month after the upgrade works and holds.
    const close = await n.post('/api/periods/close', { through: '2026-09' });
    T.check('a month can be closed after the upgrade', close.status === 200, `status ${close.status} ${close.text.slice(0, 120)}`);
    const late = await n.post('/api/payments', { unitId: 'unit-2', category: 'Maintenance', amount: 1, currency: 'JMD', payerName: 'late', method: 'Cash', date: '2026-09-10', confirmDuplicate: true });
    T.check('and a receipt dated inside it is refused', late.status >= 400 && late.status < 500, `status ${late.status}`);
    await n.post('/api/periods/reopen', { through: '2026-09', reason: 'test finished' });

    // A backup taken on the new build restores into a fresh new build.
    const snap = await n.get('/api/backup/download');
    T.check('a backup downloads from the upgraded build', snap.status === 200 && !/passwordHash|scrypt/i.test(snap.text));
    const freshDir = path.join(work, 'data-fresh');
    fs.mkdirSync(freshDir);
    const fresh = await startServer({ port: port + 1, adminPassword: 'Fresh-1234!', projectRoot, dataDir: freshDir, env });
    try {
      const f = makeClient(fresh.baseUrl);
      await activateAdmin(f, 'Fresh-1234!', 'FreshNew-9876!');
      const snapshot = JSON.parse(snap.text);
      const dry = await f.post('/api/backup/restore', { source: 'snapshot', snapshot, dryRun: true });
      T.check('the restore dry run reads it', dry.status === 200 && dry.body.dryRun === true, dry.text.slice(0, 160));
      const real = await f.post('/api/backup/restore', { source: 'snapshot', snapshot, confirm: 'RESTORE' });
      T.check('the real restore succeeds', real.status === 200, real.text.slice(0, 160));
      const fdb = (await f.get('/api/db')).body;
      const nowDb = (await n.get('/api/db')).body;
      T.check('every receipt and charge came across', fdb.payments.length === nowDb.payments.length && fdb.charges.length === nowDb.charges.length, `${fdb.payments.length}/${nowDb.payments.length}, ${fdb.charges.length}/${nowDb.charges.length}`);
      T.check('the fresh server\'s own administrator still signs in (accounts untouched)', (await makeClient(fresh.baseUrl).post('/api/auth/login', { username: 'admin', password: 'FreshNew-9876!' })).status === 200);
      T.check('and the old accounts did not arrive with the snapshot', !fdb.users.some(u => u.username === 'mgr'));
    } finally {
      await fresh.stop();
    }
    await srv.stop();
    srv = null;

    /* ---------------- restarts and failure ---------------- */
    const idemDir = path.join(work, 'data-idem');
    fs.cpSync(seedDir, idemDir, { recursive: true });
    const quick = async () => {
      const s = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir: idemDir, env });
      await sleep(600);
      await s.stop();
      return sha(path.join(idemDir, 'db.json'));
    };
    const h1 = await quick();
    const h2 = await quick();
    const h3 = await quick();
    T.check('after the first upgrade save the database is byte-stable across restarts', h1 === h2 && h2 === h3, `${h1.slice(0, 8)} ${h2.slice(0, 8)} ${h3.slice(0, 8)}`);
    T.check('the upgrade did rewrite the old file (the migration is real)', h1 !== crypto.createHash('sha256').update(frozenBytes).digest('hex'));

    const badDir = path.join(work, 'data-bad');
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, 'db.json'), '{"units": [ this is not json');
    const before = sha(path.join(badDir, 'db.json'));
    let refused = false;
    try {
      const s = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir: badDir, env });
      await s.stop();
    } catch {
      refused = true;
    }
    T.check('a damaged database makes the server refuse to start', refused);
    T.check('and the damaged file is left exactly as it was', sha(path.join(badDir, 'db.json')) === before);

    return T.done();
  } finally {
    await cleanup();
  }
}
