/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Professional-standard review of the tenancy lifecycle and deposits, 2026-11-16.
 *
 * Two kinds of check:
 *   - plain checks: behaviour that is right and must stay right;
 *   - "FINDING" checks: they assert the DEFECTIVE behaviour that exists today, so
 *     the file passes now and documents it. When a finding is fixed, its check
 *     flips to false and must be rewritten as an ordinary check of the new rule.
 *
 * Everything goes through the HTTP API, as the screens do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Tenancy lifecycle and deposits: professional workflow review';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Wf-1234567!', projectRoot });
  const src = f => fs.readFileSync(path.join(projectRoot, f), 'utf8');
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Wf-1234567!', 'WfNew-98765!');
    const s = (await c.get('/api/db')).body.settings;
    await c.post('/api/settings', { ...s, booksBeginOn: '2026-01-01' });
    const db = async () => (await c.get('/api/db')).body;
    const tenancies = async id => (await db()).tenancies.filter(t => t.unitId === id);
    const openRent = async id => (await db()).charges.filter(x => x.unitId === id && x.category === 'Rent' && x.status === 'open');
    const mkTenant = async (unit, name, extra = {}) => {
      await makeLongTermUnit(c, unit, { monthlyRent: 50000, monthlyMaintenance: 10000, tenantName: name, ...extra });
      const t = (await tenancies(unit))[0];
      await c.put(`/api/tenancies/${t.id}`, { startedOn: '2026-08-01' });
      return t;
    };
    const postMonths = async months => { for (const m of months) await c.post('/api/charges/post-month', { monthString: m }); };

    /* ---------- the UI sends exactly the field names the server reads (silent-failure class) ---------- */
    const ui = src('src/components/Units.tsx');
    for (const key of ['amount', 'currency', 'receivedOn', 'returnedAmount', 'withheldAmount', 'withheldReason', 'settledOn', 'effectiveDate', 'startedOn', 'leaseEndsOn', 'endedOn', 'endReason']) {
      T.check(`the screen sends "${key}" and the server reads it`, ui.includes(key) && src('server.ts').includes(`body.${key}`));
    }
    T.check('the evict screen sends "reason", which the server reads', /onSubmit\(\{ reason: reason\.trim\(\), effectiveDate/.test(ui) && src('server.ts').includes("body.reason, 'A reason for the eviction'"));

    /* ---------- deposits: what works ---------- */
    const a = await mkTenant('unit-1', 'Alpha');
    T.check('a deposit with a future date is refused', (await c.post(`/api/tenancies/${a.id}/deposit`, { amount: 5, receivedOn: '2099-01-01' })).status === 400);
    T.check('a zero and a negative deposit are refused', (await c.post(`/api/tenancies/${a.id}/deposit`, { amount: 0 })).status === 400 && (await c.post(`/api/tenancies/${a.id}/deposit`, { amount: -5 })).status === 400);
    T.check('control: a valid deposit is taken', (await c.post(`/api/tenancies/${a.id}/deposit`, { amount: 100000, currency: 'JMD', receivedOn: '2026-08-01' })).status === 200);
    T.check('returned plus withheld must equal the deposit', (await c.post(`/api/tenancies/${a.id}/deposit/settle`, { returnedAmount: 50000, withheldAmount: 10000, withheldReason: 'cleaning' })).status === 400);
    T.check('a deduction needs a stated reason', (await c.post(`/api/tenancies/${a.id}/deposit/settle`, { returnedAmount: 90000, withheldAmount: 10000 })).status === 400);
    T.check('nothing was settled by the refusals', (await tenancies('unit-1'))[0].depositReturnedOn === undefined);
    const settled = await c.post(`/api/tenancies/${a.id}/deposit/settle`, { returnedAmount: 90000, withheldAmount: 10000, withheldReason: 'broken tile in bathroom', settledOn: '2026-11-10' });
    T.check('control: a correct settlement is accepted and stores the reason', settled.status === 200 && settled.body.tenancy.depositWithheldReason === 'broken tile in bathroom');
    T.check('settling twice is refused', (await c.post(`/api/tenancies/${a.id}/deposit/settle`, { returnedAmount: 90000, withheldAmount: 10000, withheldReason: 'again' })).status === 400);
    T.check('taking a deposit after it was settled is refused', (await c.post(`/api/tenancies/${a.id}/deposit`, { amount: 1000 })).status === 400);
    const dbA = await db();
    T.check('deposit actions are on the audit trail with before and after', dbA.auditLogs.filter(l => /deposit/i.test(l.action)).length >= 2);

    // FINDING F8: the settlement is allowed on a tenancy still active, and the withheld money is applied to nothing.
    T.check('FINDING F8a: a deposit can be settled while the tenant still lives there', (await tenancies('unit-1'))[0].status === 'active');
    T.check('FINDING F8b: withheld money creates no charge, expense or receipt and offsets nothing (no itemised deduction)', dbA.payments.length === 0 && dbA.expenses.length === 0 && !dbA.charges.some(x => x.unitId === 'unit-1' && x.status === 'open' && /deposit|withheld/i.test(x.description || '')));

    /* ---------- FINDING F4: a second deposit silently replaces the first, including the currency ---------- */
    const b = await mkTenant('unit-2', 'Beta');
    await c.post(`/api/tenancies/${b.id}/deposit`, { amount: 100000, currency: 'JMD', receivedOn: '2026-08-01' });
    const second = await c.post(`/api/tenancies/${b.id}/deposit`, { amount: 500, currency: 'USD', receivedOn: '2026-08-02' });
    T.check('the refusal is a 409 that says why', second.status === 409 && /already held/i.test(second.body?.error || ''));
    const bNow = (await tenancies('unit-2'))[0];
    T.check('FIXED F4: a second deposit is refused instead of replacing the held J$100,000', bNow.depositAmount === 100000 && bNow.depositCurrency === 'JMD');
    const wrongCur = await c.post(`/api/tenancies/${b.id}/deposit`, { amount: 500, currency: 'USD', receivedOn: '2026-08-02', replace: true });
    T.check('FIXED F9: replacing is allowed when asked, but a currency other than the tenancy\'s still needs confirming', wrongCur.status === 409 && /confirm/i.test(wrongCur.body?.error || '') && (await tenancies('unit-2'))[0].depositAmount === 100000);
    const okCur = await c.post(`/api/tenancies/${b.id}/deposit`, { amount: 500, currency: 'USD', receivedOn: '2026-08-02', replace: true, confirmCurrency: true });
    T.check('control: with replace and confirmCurrency the deposit is replaced', okCur.status === 200 && (await tenancies('unit-2'))[0].depositAmount === 500);

    /* ---------- eviction: what works ---------- */
    const e = await mkTenant('unit-3', 'Echo');
    await postMonths(['2026-08', '2026-09', '2026-10']);
    await recordAndConfirmPayment(c, { unitId: 'unit-3', category: 'Rent', amount: 100000, currency: 'JMD', payerName: 'Echo', method: 'Cash', date: '2026-08-05' });
    await c.post(`/api/tenancies/${e.id}/deposit`, { amount: 120000, currency: 'JMD', receivedOn: '2026-08-01' });
    const ev = await c.post(`/api/tenancies/${e.id}/evict`, { reason: 'non payment of rent, notice served', effectiveDate: '2026-10-15' });
    const eNow = (await tenancies('unit-3'))[0];
    const u3 = (await db()).units.find(u => u.id === 'unit-3');
    T.check('eviction writes off only what was unpaid (paid months stay)', ev.status === 200 && ev.body.writtenOff > 0 && ev.body.writtenOff < 3 * 50000 * 2);
    T.check('eviction ends the tenancy, clears the tenant and frees the villa', eNow.status === 'ended' && eNow.evicted === true && u3.status === 'vacant' && !u3.tenantName);
    T.check('evicting an ended tenancy is refused', (await c.post(`/api/tenancies/${e.id}/evict`, { reason: 'twice over' })).status === 400);
    // FINDING F5
    T.check('FIXED F5a: without applyDeposit the deposit stays held, and the response and audit trail say so', eNow.depositAmount === 120000 && eNow.depositReturnedOn === undefined && eNow.writeOffAmount > 0 && ev.body.depositStillHeld?.amount === 120000 && (await db()).auditLogs.some(l => /deposit is still held/i.test(l.action)));
    const e2 = await mkTenant('unit-12', 'Echo Two');
    await postMonths(['2026-08', '2026-09']);
    await c.post(`/api/tenancies/${e2.id}/deposit`, { amount: 120000, currency: 'JMD', receivedOn: '2026-08-01' });
    const ev2 = await c.post(`/api/tenancies/${e2.id}/evict`, { reason: 'non payment, deposit applied', effectiveDate: '2026-10-01', applyDeposit: true });
    const e2Now = (await tenancies('unit-12'))[0];
    T.check('FIXED F5b: with applyDeposit the deposit is applied up to the rent written off, the rest recorded as due back, with a reason',
      ev2.status === 200 && ev2.body.depositApplied === Math.min(120000, ev2.body.writtenOff) && e2Now.depositWithheldAmount === ev2.body.depositApplied && e2Now.depositReturnedAmount === 120000 - ev2.body.depositApplied && /applied against/i.test(e2Now.depositWithheldReason || '') && !!e2Now.depositReturnedOn, JSON.stringify({ a: ev2.body.depositApplied, w: ev2.body.writtenOff }));
    T.check('and the application is on the audit trail', (await db()).auditLogs.some(l => /applied .* of the held deposit/i.test(l.action)));
    // no billing after the end
    await c.post('/api/charges/post-month', { monthString: '2026-11' });
    T.check('no rent is billed to a villa after the tenancy ended', !(await db()).charges.some(x => x.unitId === 'unit-3' && x.category === 'Rent' && x.periodMonth === '2026-11' && x.status === 'open'));

    /* ---------- move-out through the tenancy editor (PUT) ---------- */
    const m = await mkTenant('unit-4', 'Mike');
    await postMonths(['2026-08', '2026-09', '2026-10', '2026-11']);
    await recordAndConfirmPayment(c, { unitId: 'unit-4', category: 'Rent', amount: 50000, currency: 'JMD', payerName: 'Mike', method: 'Cash', date: '2026-08-05' });
    const out = await c.put(`/api/tenancies/${m.id}`, { endedOn: '2026-09-30', endReason: 'moved to Kingston' });
    const after = await openRent('unit-4');
    T.check('control: recording a move-out ends the tenancy and frees the villa', out.status === 200 && (await tenancies('unit-4'))[0].status === 'ended' && (await db()).units.find(u => u.id === 'unit-4').status === 'vacant');
    T.check('FIXED F1: rent for months AFTER the move-out date (Oct, Nov) is voided with a reason; earlier months are untouched by this rule', after.filter(x => x.periodMonth > '2026-09').length === 0 && (await db()).charges.filter(x => x.unitId === 'unit-4' && x.periodMonth > '2026-09' && x.category === 'Rent' && x.status === 'void' && /moved out/i.test(x.voidReason || '')).length === 2 && after.some(x => x.periodMonth === '2026-08'));
    const mu = (await db()).units.find(u => u.id === 'unit-4');
    const blocked = await c.put('/api/units/unit-4', { ...mu, status: 'long-term', tenantName: 'Nina', tenantChangeIntent: 'changeover', monthlyRent: 50000, monthlyMaintenance: 10000 });
    T.check('a new tenant cannot be registered over the former tenant\'s unpaid rent (by design)', blocked.status === 400 && /still owes/i.test(blocked.body?.error || ''));
    T.check('FINDING F2a: the ended tenancy can no longer be evicted, so that route out is closed', (await c.post(`/api/tenancies/${m.id}/evict`, { reason: 'trying to clear the arrears' })).status === 400);
    T.check('FIXED F2b: the screen now offers the write-off (it sends formerArrears when the server says the former tenant owes)', /formerArrears: 'write-off'/.test(ui) && /former-tenant-owes/.test(ui));
    const viaApi = await c.put('/api/units/unit-4', { ...mu, status: 'long-term', tenantName: 'Nina', tenantChangeIntent: 'changeover', monthlyRent: 50000, monthlyMaintenance: 10000, formerArrears: 'write-off' });
    T.check('control: the server DOES support the write-off choice when it is sent', viaApi.status === 200 && (await tenancies('unit-4')).some(t => t.tenantName === 'Nina' && t.status === 'active'));

    /* ---------- FINDING F3: a future move-out date vacates the villa today ---------- */
    const f = await mkTenant('unit-5', 'Fay');
    const fut = await c.put(`/api/tenancies/${f.id}`, { endedOn: '2099-03-01', endReason: 'notice given' });
    T.check('FIXED F3: a move-out dated years ahead is refused and the villa stays let', fut.status === 400 && /future/i.test(fut.body?.error || '') && (await db()).units.find(u => u.id === 'unit-5').status === 'long-term');
    T.check('FIXED F3b: the screen\'s move-out date field now has a maximum of today', /id="tn-end"[^>]*max=/.test(ui));

    /* ---------- FINDING F7: a corrected move-in date leaves earlier months billed ---------- */
    const g = await mkTenant('unit-6', 'Gus');
    await postMonths(['2026-08', '2026-09']);
    await c.put(`/api/tenancies/${g.id}`, { startedOn: '2026-10-01' });
    T.check('FIXED F7: moving the move-in date to October voids the August and September monthly rent that was billed before the tenant arrived (the move-in advance charge is left alone)', !(await openRent('unit-6')).some(x => x.kind !== 'advance-final-month' && (x.periodMonth === '2026-08' || x.periodMonth === '2026-09')) && (await db()).charges.filter(x => x.unitId === 'unit-6' && x.status === 'void' && /before .* moved in/i.test(x.voidReason || '')).length === 2);

    /* ---------- FINDING F6: nothing reminds anyone that a deposit is still owed ---------- */
    const h = await mkTenant('unit-7', 'Hal');
    await postMonths(['2026-08']);
    await recordAndConfirmPayment(c, { unitId: 'unit-7', category: 'Rent', amount: 100000, currency: 'JMD', payerName: 'Hal', method: 'Cash', date: '2026-08-05' });
    await c.post(`/api/tenancies/${h.id}/deposit`, { amount: 80000, currency: 'JMD', receivedOn: '2026-08-01' });
    await c.put(`/api/tenancies/${h.id}`, { endedOn: '2026-11-01', endReason: 'lease ended' });
    const hNow = (await tenancies('unit-7'))[0];
    T.check('FINDING F6a: a tenant has left and J$80,000 of their deposit is still held, with no settlement', hNow.status === 'ended' && hNow.depositAmount === 80000 && !hNow.depositReturnedOn);
    T.check('FINDING F6b: no notification, report or total anywhere mentions deposits held', !/deposit/i.test(src('src/components/NotificationsTab.tsx')) && !/depositAmount/.test(src('src/lib/finance.ts')));

    /* ---------- rent change is not retroactive, and the tenancy follows ---------- */
    const r = await mkTenant('unit-8', 'Rex');
    await postMonths(['2026-11']);
    const ru = (await db()).units.find(u => u.id === 'unit-8');
    await c.put('/api/units/unit-8', { ...ru, monthlyRent: 60000 });
    T.check('a rent change leaves the month already posted alone', (await openRent('unit-8')).filter(x => x.periodMonth === '2026-11' && x.kind !== 'advance-final-month').every(x => x.amount === 50000));
    T.check('and the tenancy record follows the new rent', (await tenancies('unit-8'))[0].monthlyRent === 60000);
    void r;

    /* ---------- permissions ---------- */
    await c.post('/api/users', { name: 'jr', username: 'jr', role: 'JUNIOR_OFFICER', password: 'Jr-12345678!' });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'jr', password: 'Jr-12345678!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'Jr-12345678!', newPassword: 'Jr-12345678!x' });
    const live = (await tenancies('unit-4')).find(t => t.status === 'active');
    T.check('a Junior cannot evict, settle a deposit or edit a tenancy', (await jr.post(`/api/tenancies/${live.id}/evict`, { reason: 'junior attempt' })).status === 403 && (await jr.post(`/api/tenancies/${live.id}/deposit/settle`, { returnedAmount: 1 })).status === 403 && (await jr.put(`/api/tenancies/${live.id}`, { endReason: 'x' })).status === 403);
    T.check('control: the administrator can (same calls, same tenancy)', (await c.put(`/api/tenancies/${live.id}`, { endReason: 'note' })).status === 200);

    return T.done();
  } finally {
    await srv.stop();
  }
}
