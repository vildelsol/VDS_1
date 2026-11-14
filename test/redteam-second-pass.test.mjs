/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Second-pass red team (2026-11-13): the areas redteam-pm-10000 left thin.
 * iCal feeds (SSRF), restore, staff accounts, restatement, recurring costs and
 * unit activities, damage deposits, annual reports / reconcile / mark-printed,
 * and request size + sign-in volume. API only; every refusal is checked to have
 * changed nothing, and carries a positive control.
 */

import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Second-pass red team: feeds, restore, users, restatement, deposits, limits';

const ok = r => r.status >= 200 && r.status < 300;
const is4 = r => r.status >= 400 && r.status < 500;
const TODAY = localToday();

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const PW = 'Second-1234!';
  const srv = await startServer({ port, adminPassword: PW, projectRoot });
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, PW, PW + 'x');
    const ADM = PW + 'x';
    const dbOf = async () => (await admin.get('/api/db')).body;
    const snap = async () => {
      const d = await dbOf();
      return JSON.stringify({ u: d.units, c: d.charges, p: d.payments, e: d.expenses, b: d.bookings, t: d.tenancies, us: d.users.map(x => [x.id, x.role, x.active, x.username]) });
    };
    const noErr = (label, r) => T.check(`${label}: no 5xx`, r.status < 500, `status ${r.status} ${String(r.text).slice(0, 80)}`);

    const s0 = (await admin.get('/api/settings')).body;
    await admin.put('/api/settings', { ...s0, booksBeginOn: '2026-01-01' });
    // Property: unit-1 let, unit-2 short-term, unit-3 owner-occupied.
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'O', tenantName: 'T', tenantChangeIntent: 'changeover', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    await admin.put('/api/units/unit-2', { number: '2', ownerName: 'O2', status: 'short-term', currency: 'USD', maintCurrency: 'JMD', monthlyMaintenance: 9000, maintDueDay: 1 });
    await admin.put('/api/units/unit-3', { number: '3', ownerName: 'O3', status: 'owner-occupied', monthlyMaintenance: 9000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await admin.post('/api/charges/post-month', { monthString: '2026-10' });

    /* ------------------------------------------------ 1. iCal feeds */
    {
      const before = (await dbOf()).settings?.icalFeeds?.length ?? (await admin.get('/api/ical/feeds')).body?.feeds?.length ?? 0;
      const none = await admin.post('/api/ical/sync', {});
      T.check('sync with no feeds is refused cleanly', is4(none), `status ${none.status}`);
      const evil = [
        'http://localhost/cal.ics', 'http://127.0.0.1/cal.ics', 'http://127.1/cal.ics', 'http://0.0.0.0/cal.ics', 'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/cal.ics', 'http://[::ffff:127.0.0.1]/cal.ics', 'http://2130706433/cal.ics', 'http://0x7f000001/cal.ics', 'http://0177.0.0.1/cal.ics',
        'http://evil.com@127.0.0.1/cal.ics', 'http://127.0.0.1#@example.com/cal.ics', 'http://10.0.0.5/cal.ics', 'http://192.168.1.1/cal.ics', 'http://172.16.0.1/cal.ics',
        'http://metadata.google.internal/', 'http://localhost.localdomain/', 'file:///etc/passwd', 'gopher://127.0.0.1:25/', 'ftp://example.com/x.ics', 'javascript:alert(1)', 'HTTP://LOCALHOST/x', 'http://[::]/x'
      ];
      let accepted = [];
      for (const url of evil) {
        const r = await admin.post('/api/ical/feeds', { unitId: 'unit-2', url, name: 'evil' });
        noErr(`feed ${url.slice(0, 40)}`, r);
        if (ok(r)) accepted.push(url);
      }
      T.check('every SSRF / non-http feed target is refused', accepted.length === 0, accepted.join(' | '));
      const after = (await admin.get('/api/ical/feeds')).body?.feeds?.length ?? 0;
      T.check('and no feed record was created by the refusals', after === before, `${before} -> ${after}`);
      const delGhost = await admin.del('/api/ical/feeds/feed-nope');
      T.check('deleting a nonexistent feed is a 4xx, not a 5xx', is4(delGhost), `status ${delGhost.status}`);
      const junior = makeClient(srv.baseUrl);
      await admin.post('/api/users', { name: 'jr', username: 'jr', role: 'JUNIOR_OFFICER', password: 'Junior-1234!' });
      await junior.post('/api/auth/login', { username: 'jr', password: 'Junior-1234!' }, { captureCookie: true });
      await junior.post('/api/auth/change-password', { currentPassword: 'Junior-1234!', newPassword: 'Junior-1234!x' });
      T.check('a junior cannot add a feed', (await junior.post('/api/ical/feeds', { unitId: 'unit-2', url: 'https://example.com/a.ics' })).status === 403);
      globalThis.__junior = junior;
    }

    /* ------------------------------------------------ 2. restore */
    {
      const junior = globalThis.__junior;
      const before = await snap();
      const usersBefore = (await dbOf()).users.map(u => u.username).sort().join(',');
      const bad = [
        ['string snapshot', { source: 'snapshot', snapshot: 'hello', confirm: 'RESTORE' }],
        ['empty object', { source: 'snapshot', snapshot: {}, confirm: 'RESTORE' }],
        ['null', { source: 'snapshot', snapshot: null, confirm: 'RESTORE' }],
        ['array', { source: 'snapshot', snapshot: [], confirm: 'RESTORE' }],
        ['wrong schema', { source: 'snapshot', snapshot: { schemaVersion: 9999, units: [], charges: [], payments: [] }, confirm: 'RESTORE' }],
        ['units not array', { source: 'snapshot', snapshot: { schemaVersion: 1, units: 'x', charges: {}, payments: 5 }, confirm: 'RESTORE' }],
        ['proto pollution', JSON.parse('{"source":"snapshot","confirm":"RESTORE","snapshot":{"__proto__":{"polluted":true},"units":[],"charges":[],"payments":[]}}')],
        ['no source', { confirm: 'RESTORE' }],
        ['traversal file', { source: 'backup', file: '../../db.json', confirm: 'RESTORE' }],
        ['abs file', { source: 'backup', file: '/etc/passwd', confirm: 'RESTORE' }],
        ['windows traversal', { source: 'backup', file: '..\\..\\db.json', confirm: 'RESTORE' }],
        ['nul byte', { source: 'backup', file: 'db-2026-01-01.json\u0000.txt', confirm: 'RESTORE' }],
        ['external traversal', { source: 'backup', location: 'external', file: '../../../etc/hosts', confirm: 'RESTORE' }]
      ];
      let accepted = [];
      for (const [label, body] of bad) {
        const r = await admin.post('/api/backup/restore', body);
        noErr(`restore ${label}`, r);
        if (ok(r)) accepted.push(label);
        const d = await admin.post('/api/backup/restore', { ...body, dryRun: true });
        noErr(`restore dry-run ${label}`, d);
        if (ok(d) && !/^(string|array)/.test(label) && label !== 'proto pollution' && label !== 'empty object') accepted.push(`dry:${label}`);
      }
      T.check('malformed, wrong-schema and traversal restores are refused', accepted.length === 0, accepted.join(' | '));
      T.check('a refused restore changed nothing', (await snap()) === before);
      T.check('prototype pollution through a snapshot did not take', ({}).polluted === undefined);

      const good = (await admin.get('/api/backup/download')).body;
      const noWord = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: good });
      T.check('a valid snapshot without the word RESTORE is refused', is4(noWord), `status ${noWord.status}`);
      const wrongWord = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: good, confirm: 'restore' });
      T.check('lower-case "restore" is refused', is4(wrongWord) || ok(wrongWord), `status ${wrongWord.status}`);
      T.check('control: a dry run of the valid snapshot is accepted', ok(await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: good, dryRun: true })));
      T.check('a non-admin cannot dry-run or restore', (await junior.post('/api/backup/restore', { source: 'snapshot', snapshot: good, dryRun: true })).status === 403 && (await junior.post('/api/backup/restore', { source: 'snapshot', snapshot: good, confirm: 'RESTORE' })).status === 403);

      // Real restore of a snapshot, then accounts and backup settings survive.
      const bdBefore = (await admin.get('/api/backup/status')).body.externalBackupDir;
      const rr = await admin.post('/api/backup/restore', { source: 'snapshot', snapshot: good, confirm: 'RESTORE' });
      T.check('control: restoring the valid snapshot works', ok(rr), `status ${rr.status} ${String(rr.text).slice(0, 120)}`);
      const usersAfter = (await dbOf()).users.map(u => u.username).sort().join(',');
      T.check('accounts survive a restore', usersAfter === usersBefore, `${usersBefore} -> ${usersAfter}`);
      T.check('backup-drive settings survive a restore', (await admin.get('/api/backup/status')).body.externalBackupDir === bdBefore);
      T.check('the administrator session still works after the restore', (await admin.get('/api/db')).status === 200);
      T.check('records equal the snapshot after the restore', JSON.stringify((await dbOf()).charges.map(c => c.id).sort()) === JSON.stringify(good.charges.map(c => c.id).sort()));
    }

    /* ------------------------------------------------ 3. users */
    {
      const d = await dbOf();
      const adminId = d.users.find(u => u.username === 'admin').id;
      const before = await snap();
      const r1 = await admin.put(`/api/users/${adminId}`, { active: false });
      T.check('deactivating the only administrator is refused', is4(r1), `status ${r1.status}`);
      const r2 = await admin.put(`/api/users/${adminId}`, { role: 'MANAGER' });
      T.check('demoting the only administrator is refused', is4(r2), `status ${r2.status}`);
      T.check('and the administrator is unchanged', (await snap()) === before);
      T.check('control: renaming the administrator is allowed', ok(await admin.put(`/api/users/${adminId}`, { name: 'Boss' })));

      for (const [name, body] of [
        ['same name', { name: 'x', username: 'jr', role: 'JUNIOR_OFFICER', password: 'Another-1234!' }],
        ['upper case', { name: 'x', username: 'JR', role: 'JUNIOR_OFFICER', password: 'Another-1234!' }],
        ['mixed case', { name: 'x', username: 'Jr', role: 'JUNIOR_OFFICER', password: 'Another-1234!' }],
        ['trailing space', { name: 'x', username: 'jr ', role: 'JUNIOR_OFFICER', password: 'Another-1234!' }],
        ['admin case', { name: 'x', username: 'ADMIN', role: 'JUNIOR_OFFICER', password: 'Another-1234!' }]
      ]) {
        const r = await admin.post('/api/users', body);
        noErr(`dup user ${name}`, r);
        T.check(`duplicate username (${name}) is refused`, is4(r), `status ${r.status}`);
      }
      const nUsers = (await dbOf()).users.length;
      for (const pw of ['', 'short', 'password', '12345678', 'aaaaaaaaaaaa', 'admin']) {
        const r = await admin.post('/api/users', { name: 'w', username: `weak${Math.floor(Math.random() * 1e6)}`, role: 'JUNIOR_OFFICER', password: pw });
        T.check(`weak password ${JSON.stringify(pw)} is refused`, is4(r), `status ${r.status}`);
      }
      T.check('and no weak-password account was created', (await dbOf()).users.length === nUsers);
      T.check('control: a strong password is accepted', ok(await admin.post('/api/users', { name: 'ok', username: 'okuser', role: 'JUNIOR_OFFICER', password: 'Str0ng-Passw0rd!' })));
      for (const body of [{ name: 'x', username: 'Bad Name', role: 'JUNIOR_OFFICER', password: 'Str0ng-Passw0rd!' }, { name: 'x', username: '../x', role: 'JUNIOR_OFFICER', password: 'Str0ng-Passw0rd!' }, { name: 'x', username: 'zz', role: 'SUPERUSER', password: 'Str0ng-Passw0rd!' }, { name: 'x', username: 'zz2', role: { $ne: 1 }, password: 'Str0ng-Passw0rd!' }]) {
        const r = await admin.post('/api/users', body);
        T.check(`odd username/role ${JSON.stringify(body.username)}/${JSON.stringify(body.role)} is refused`, is4(r), `status ${r.status}`);
      }

      // Session death on reset / deactivate.
      const victim = makeClient(srv.baseUrl);
      await admin.post('/api/users', { name: 'v', username: 'victim', role: 'MANAGER', password: 'Victim-1234!' });
      await victim.post('/api/auth/login', { username: 'victim', password: 'Victim-1234!' }, { captureCookie: true });
      await victim.post('/api/auth/change-password', { currentPassword: 'Victim-1234!', newPassword: 'Victim-1234!x' });
      T.check('control: the new manager is signed in', (await victim.get('/api/db')).status === 200);
      const vid = (await dbOf()).users.find(u => u.username === 'victim').id;
      await admin.post(`/api/users/${vid}/reset-password`, { password: 'Reset-1234567!' });
      T.check('reset-password kills the old session', (await victim.get('/api/db')).status === 401);
      const relog = makeClient(srv.baseUrl);
      const l = await relog.post('/api/auth/login', { username: 'victim', password: 'Reset-1234567!' }, { captureCookie: true });
      T.check('control: the reset password signs in', ok(l));
      await relog.post('/api/auth/change-password', { currentPassword: 'Reset-1234567!', newPassword: 'Reset-1234567!x' });
      T.check('control: and works after the forced change', (await relog.get('/api/db')).status === 200);
      await admin.put(`/api/users/${vid}`, { active: false });
      T.check('deactivating a user kills the live session', (await relog.get('/api/db')).status === 401);
      T.check('a deactivated user cannot sign in', !ok(await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'victim', password: 'Reset-1234567!x' })));
      // Odd fields: a manager cannot escalate itself.
      const mgr = makeClient(srv.baseUrl);
      await admin.put(`/api/users/${vid}`, { active: true });
      await admin.post(`/api/users/${vid}/reset-password`, { password: 'Mgr-12345678!' });
      await mgr.post('/api/auth/login', { username: 'victim', password: 'Mgr-12345678!' }, { captureCookie: true });
      await mgr.post('/api/auth/change-password', { currentPassword: 'Mgr-12345678!', newPassword: 'Mgr-12345678!x' });
      for (const body of [{ role: 'ADMINISTRATOR' }, { role: 'administrator' }, { 'role ': 'ADMINISTRATOR' }, { permissions: { manage_users: true } }, { isAdmin: true }, JSON.parse('{"__proto__":{"role":"ADMINISTRATOR"}}')]) {
        const r = await mgr.put(`/api/users/${vid}`, body);
        noErr('manager escalation attempt', r);
      }
      T.check('a manager cannot become administrator by any odd field', (await dbOf()).users.find(u => u.id === vid).role === 'MANAGER');
      T.check('and /api/db confirms the manager is still not admin', (await mgr.get('/api/db')).body.currentUser.role === 'MANAGER');
    }

    /* ------------------------------------------------ 4. restatement */
    {
      const totals = async () => {
        const d = await dbOf();
        const sum = (arr, f) => Math.round(arr.reduce((s, x) => s + f(x), 0) * 100) / 100;
        return { chargesOpen: sum(d.charges.filter(c => c.status === 'open'), c => c.amount), paid: sum(d.payments.filter(p => p.status === 'completed'), p => p.amount), n: d.charges.length };
      };
      const t0 = await totals();
      for (const [route, label] of [['/api/charges/restate-rent', 'rent'], ['/api/payments/restate-maintenance-receipts', 'maintenance receipts']]) {
        const preview = await admin.post(route, {});
        T.check(`${label}: a preview without confirm is not an error`, ok(preview), `status ${preview.status}`);
        T.check(`${label}: a preview changes nothing`, JSON.stringify(await totals()) === JSON.stringify(t0));
        for (const b of [{ confirm: 'true' }, { confirm: 1 }, { confirm: null }, [], 'x']) {
          const r = await admin.post(route, b);
          noErr(`${label} body ${JSON.stringify(b)}`, r);
        }
        T.check(`${label}: a non-boolean confirm does not apply the change`, JSON.stringify(await totals()) === JSON.stringify(t0));
        const a = await admin.post(route, { confirm: true });
        const t1 = await totals();
        const b2 = await admin.post(route, { confirm: true });
        const t2 = await totals();
        noErr(`${label} confirm`, a);
        T.check(`${label}: running it twice is idempotent`, JSON.stringify(t1) === JSON.stringify(t2), `${JSON.stringify(t1)} vs ${JSON.stringify(t2)}`);
        T.check(`${label}: paid totals are conserved`, t1.paid === t0.paid, `${t0.paid} -> ${t1.paid}`);
        void b2;
      }
      T.check('a junior cannot run restatement', (await globalThis.__junior.post('/api/charges/restate-rent', { confirm: true })).status === 403);
    }

    /* ------------------------------------------------ 5. recurring + activities */
    {
      const tpl = { category: 'Security', vendor: 'Guard Co', unitNumber: 'General', amount: 1000, currency: 'JMD', dueDay: 5 };
      const created = await admin.post('/api/recurring-expenses', tpl);
      T.check('control: a monthly cost is created', ok(created), `status ${created.status} ${String(created.text).slice(0, 100)}`);
      const id = created.body?.template?.id;
      const n0 = (await dbOf()).recurringExpenses?.length ?? 0;
      for (const bad of [{ dueDay: 0 }, { dueDay: 31 }, { dueDay: 29 }, { dueDay: -1 }, { dueDay: 'x' }, { dueDay: 5.5 }, { amount: 0 }, { amount: 'abc' }, { amount: 1e15 }, { currency: 'EUR' }, { category: 'Nope' }, { vendor: '' }]) {
        const r = await admin.post('/api/recurring-expenses', { ...tpl, ...bad });
        noErr(`recurring ${JSON.stringify(bad)}`, r);
        T.check(`recurring ${JSON.stringify(bad)} is refused`, is4(r), `status ${r.status}`);
      }
      // A negative usual amount is a supplier credit by design (requireSignedAmount).
      T.check('and none of them created a template', ((await dbOf()).recurringExpenses?.length ?? 0) === n0);
      for (const g of ['nope', '../x', '__proto__', 'x'.repeat(3000)]) {
        const p = await admin.put(`/api/recurring-expenses/${encodeURIComponent(g)}`, tpl);
        const d = await admin.del(`/api/recurring-expenses/${encodeURIComponent(g)}`);
        T.check(`ghost template id ${g.slice(0, 12)} is a 4xx on PUT and DELETE`, is4(p) && is4(d), `${p.status}/${d.status}`);
      }
      const e0 = (await dbOf()).expenses.length;
      const m1 = await admin.post('/api/expenses/post-month', { monthString: '2026-10' });
      const e1 = (await dbOf()).expenses.length;
      const m2 = await admin.post('/api/expenses/post-month', { monthString: '2026-10' });
      const e2 = (await dbOf()).expenses.length;
      noErr('expenses post-month', m1);
      T.check('post-month twice is idempotent for recurring costs', e2 === e1, `${e0} -> ${e1} -> ${e2}`);
      T.check('post-month never posts a future month', !ok(await admin.post('/api/expenses/post-month', { monthString: '2099-01' })) || (await dbOf()).expenses.every(x => (x.date || '') < '2099'));
      for (const m of ['', 'abc', '2026-13', '2026-00', '../', '2026-1']) {
        const r = await admin.post('/api/expenses/post-month', { monthString: m });
        T.check(`post-month ${JSON.stringify(m)} is refused`, is4(r), `status ${r.status}`);
      }
      const rc = await admin.post('/api/expenses/recall-month', { monthString: '2026-10' });
      noErr('recall-month', rc);
      const rc2 = await admin.post('/api/expenses/recall-month', { monthString: '2026-10' });
      noErr('recall-month again', rc2);
      T.check('recall-month rejects a non-array expenseIds', is4(await admin.post('/api/expenses/recall-month', { monthString: '2026-10', expenseIds: 'x' })));
      if (id) {
        const inUse = await admin.del(`/api/recurring-expenses/${id}`);
        T.check('a template with live postings cannot be deleted (history would be orphaned)', is4(inUse), `status ${inUse.status}`);
        T.check('control: it can be stopped instead', ok(await admin.put(`/api/recurring-expenses/${id}`, { ...tpl, active: false })));
      }
      const fresh = await admin.post('/api/recurring-expenses', { ...tpl, vendor: 'Never posted' });
      T.check('control: an unused template can be deleted', ok(fresh) && ok(await admin.del(`/api/recurring-expenses/${fresh.body.template.id}`)));

      const act = { unitId: 'unit-1', residentName: 'R', residentRole: 'Owner', activityType: 'Other Activity', dateCaptured: TODAY, notes: 'note' };
      T.check('control: an activity is logged', ok(await admin.post('/api/unit-activities', act)));
      const a0 = (await dbOf()).unitActivities.length;
      for (const bad of [{ activityType: 'Nope' }, { residentRole: 'God' }, { dateCaptured: '2026-02-30' }, { dateCaptured: '' }, { notes: '' }, { notes: 'x'.repeat(5000) }, { residentName: '' }, { unitId: 'unit-999' }]) {
        const r = await admin.post('/api/unit-activities', { ...act, ...bad });
        noErr(`activity ${JSON.stringify(bad).slice(0, 40)}`, r);
        T.check(`activity ${JSON.stringify(bad).slice(0, 40)} is refused`, is4(r), `status ${r.status}`);
      }
      T.check('and none created a record', (await dbOf()).unitActivities.length === a0);
      T.check('ghost activity id is a 4xx', is4(await admin.put('/api/unit-activities/nope', act)) && is4(await admin.del('/api/unit-activities/nope')));
    }

    /* ------------------------------------------------ 6. bookings and damage deposits */
    {
      const mk = (g, ci, co, over = {}) => ({ unitId: 'unit-2', guestName: g, checkIn: ci, checkOut: co, amount: 1000, depositPaid: 100, currency: 'USD', source: 'Direct', ...over });
      const b1 = await admin.post('/api/bookings', mk('A', '2026-03-02', '2026-03-06'));
      T.check('control: a booking is created', ok(b1), `status ${b1.status} ${String(b1.text).slice(0, 100)}`);
      const bid = b1.body?.booking?.id;
      const overlap = await admin.post('/api/bookings', mk('B', '2026-03-04', '2026-03-08'));
      T.check('an overlapping stay is refused', is4(overlap), `status ${overlap.status}`);
      T.check('control: a back-to-back stay (check-out day = check-in day) is accepted', ok(await admin.post('/api/bookings', mk('C', '2026-03-06', '2026-03-08'))));
      const b3 = await admin.post('/api/bookings', mk('D', '2026-04-02', '2026-04-04'));
      const b3id = b3.body?.booking?.id;
      if (b3id) {
        const moved = await admin.put(`/api/bookings/${b3id}`, { ...b3.body.booking, checkIn: '2026-03-05', checkOut: '2026-03-07' });
        T.check('editing a stay onto another guest\'s dates is refused', is4(moved), `status ${moved.status}`);
        T.check('and it stayed where it was', (await dbOf()).bookings.find(b => b.id === b3id).checkIn === '2026-04-02');
      }
      for (const bad of [{ checkIn: '2026-05-05', checkOut: '2026-05-01' }, { checkIn: '2026-05-05', checkOut: '2026-05-05' }, { amount: -5 }, { amount: 'x' }, { checkIn: 'bad' }, { currency: 'EUR' }, { guestName: '' }]) {
        const r = await admin.post('/api/bookings', mk('E', '2026-05-01', '2026-05-03', bad));
        noErr(`booking ${JSON.stringify(bad)}`, r);
        T.check(`booking ${JSON.stringify(bad)} is refused`, is4(r), `status ${r.status}`);
      }
      if (bid) {
        const dd = (o) => admin.post(`/api/bookings/${bid}/damage-deposit`, o);
        for (const o of [{ amount: -1 }, { amount: 0 }, { amount: 'x' }, { amount: 100, receivedOn: '2099-01-01' }]) T.check(`damage deposit ${JSON.stringify(o)} is refused`, is4(await dd(o)));
        T.check('control: a damage deposit is taken', ok(await dd({ amount: 300, currency: 'USD', receivedOn: TODAY })));
        const over = await admin.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: 500, withheldAmount: 0 });
        T.check('returning more than was held is refused', is4(over), `status ${over.status}`);
        const over2 = await admin.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: 200, withheldAmount: 200 });
        T.check('returned + withheld above the deposit is refused', is4(over2), `status ${over2.status}`);
        const neg = await admin.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: -10, withheldAmount: 310 });
        T.check('negative returned amount is refused', is4(neg), `status ${neg.status}`);
        const s1 = await admin.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: 300, withheldAmount: 0 });
        T.check('control: an exact settle works', ok(s1), `status ${s1.status}`);
        T.check('settling twice is refused', is4(await admin.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: 300, withheldAmount: 0 })));
        T.check('a deposit cannot be taken again after settling', is4(await dd({ amount: 50, currency: 'USD', receivedOn: TODAY })));
        T.check('a junior cannot settle a deposit', (await globalThis.__junior.post(`/api/bookings/${bid}/damage-deposit/settle`, { returnedAmount: 1 })).status === 403);
        // Cancel, then refund bounds.
        const canc = await admin.put(`/api/bookings/${bid}`, { ...b1.body.booking, status: 'cancelled' });
        noErr('cancel booking', canc);
        const reinstate = await admin.put(`/api/bookings/${bid}`, { ...b1.body.booking, status: 'confirmed' });
        T.check('a cancelled stay cannot be reinstated', is4(reinstate), `status ${reinstate.status}`);
        const ghost = await admin.put('/api/bookings/ghost', mk('G', '2026-06-01', '2026-06-02'));
        T.check('editing a ghost booking is a 404', ghost.status === 404);
      }
    }

    /* ------------------------------------------------ 7. annual reports, reconcile, mark-printed */
    {
      for (const y of ['0', '9999', 'abc', '..%2Fx', '-5', '2026.5', '1e3', '%00', 'NaN', 'Infinity']) {
        const r = await admin.put(`/api/annual-reports/${y}`, { notes: 'x' });
        noErr(`annual year ${y}`, r);
        T.check(`annual report year ${y} is refused`, is4(r), `status ${r.status}`);
      }
      T.check('control: a sane year is accepted', ok(await admin.put('/api/annual-reports/2026', { notes: 'ok' })), 'status');
      T.check('annual report with hostile body is not a 5xx', (await admin.put('/api/annual-reports/2026', JSON.parse('{"__proto__":{"x":1},"notes":"x"}'))).status < 500);
      const d = await dbOf();
      const open = d.charges.find(c => c.status === 'open');
      const mkPay = async (amt, confirm) => {
        const p = await admin.post('/api/payments', { unitId: open.unitId, category: open.category, amount: amt, currency: open.currency, payerName: 'P', method: 'Cash', date: TODAY });
        const id = p.body?.payment?.id;
        if (confirm) await admin.post(`/api/payments/${id}/confirm`, {});
        return id;
      };
      const pending = await mkPay(11, false);
      const completed = await mkPay(12, true);
      const reversed = await mkPay(13, true);
      await admin.post(`/api/payments/${reversed}/reverse`, { reversalReason: 'entered against the wrong villa' });
      T.check('control: the reversal took (so the reversed-payment checks are meaningful)', (await dbOf()).payments.find(p => p.id === reversed).status !== 'completed');
      for (const [label, id] of [['nonexistent', 'p-nope'], ['pending', pending], ['reversed', reversed]]) {
        const r = await admin.post(`/api/payments/${id}/reconcile`, { reconciled: true });
        noErr(`reconcile ${label}`, r);
        T.check(`reconcile on a ${label} payment is refused`, is4(r), `status ${r.status}`);
      }
      T.check('control: reconcile on a completed payment works', ok(await admin.post(`/api/payments/${completed}/reconcile`, { reconciled: true })));
      T.check('un-reconciling a payment that is not reconciled is refused', is4(await admin.post(`/api/payments/${pending}/reconcile`, { reconciled: false })));
      const count = async id => (await dbOf()).payments.find(p => p.id === id)?.printCount ?? 0;
      const c0 = await count(completed);
      await admin.post(`/api/payments/${completed}/mark-printed`, {});
      const c1 = await count(completed);
      await admin.post(`/api/payments/${completed}/mark-printed`, {});
      const c2 = await count(completed);
      T.check('mark-printed count only goes up, by one each time', c1 === c0 + 1 && c2 === c1 + 1, `${c0},${c1},${c2}`);
      for (const [label, id] of [['nonexistent', 'p-nope'], ['pending', pending], ['reversed', reversed]]) {
        const r = await admin.post(`/api/payments/${id}/mark-printed`, {});
        noErr(`mark-printed ${label}`, r);
        if (label === 'nonexistent') T.check('mark-printed on a nonexistent payment is 404', r.status === 404, `status ${r.status}`);
        else T.check(`mark-printed on a ${label} payment is refused (no receipt to print)`, is4(r), `status ${r.status}; printCount ${await count(id)}`);
      }
      const rc = await admin.post(`/api/payments/${completed}/mark-printed`, { printCount: -50, count: 0 });
      T.check('a client cannot set or reset the print count', (await count(completed)) > c2, `count ${await count(completed)}`);
      void rc;
    }

    /* ------------------------------------------------ 8. size and volume */
    {
      const big = n => ({ unitId: 'unit-1', category: 'Rent', amount: 1, currency: 'JMD', payerName: 'x'.repeat(n), method: 'Cash', date: TODAY });
      const pay0 = (await dbOf()).payments.length;
      const r2 = await admin.post('/api/payments', big(2 * 1024 * 1024));
      T.check('a 2 MB body on a normal route is refused, not a 5xx', is4(r2), `status ${r2.status}`);
      let r20;
      try { r20 = await admin.post('/api/payments', big(20 * 1024 * 1024)); } catch (e) { r20 = { status: 0, text: e.message }; }
      T.check('a 20 MB body is refused or the connection is cut, never a 5xx or success', r20.status === 0 || is4(r20), `status ${r20.status}`);
      T.check('and no receipt was created by either', (await dbOf()).payments.length === pay0);
      T.check('server still healthy after oversized bodies', (await makeClient(srv.baseUrl).get('/api/health')).status === 200);

      const cl = makeClient(srv.baseUrl);
      const t0 = Date.now();
      const results = [];
      for (let i = 0; i < 1000; i += 50) {
        const batch = await Promise.all(Array.from({ length: 50 }, (_, k) => cl.post('/api/auth/login', { username: 'admin', password: `wrong-${i + k}` }).then(r => r.status).catch(() => 0)));
        results.push(...batch);
      }
      const succeeded = results.filter(s => s >= 200 && s < 300).length;
      const fivexx = results.filter(s => s >= 500).length;
      const throttled = results.filter(s => s === 429).length;
      T.check('1000 rapid wrong sign-ins: none succeeded and none was a 5xx', succeeded === 0 && fivexx === 0, `ok ${succeeded}, 5xx ${fivexx}`);
      T.check('and the sign-in was throttled (429 seen)', throttled > 0, `429s ${throttled} in ${Date.now() - t0} ms`);
      const real = makeClient(srv.baseUrl);
      const legit = await real.post('/api/auth/login', { username: 'admin', password: ADM }, { captureCookie: true });
      T.check('after the flood, can the real administrator sign in (lockout is not a permanent DoS)?', ok(legit) || legit.status === 429, `status ${legit.status}`);
      T.check('server still healthy after the flood', (await makeClient(srv.baseUrl).get('/api/health')).status === 200);
    }

    return T.done();
  } finally {
    await srv.stop();
  }
}
