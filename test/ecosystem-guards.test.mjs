/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The safeguards that stop a money fault persisting.
 *
 *  1. An idempotency key is bound to its content, and survives a restart.
 *  2. The same money entered twice within minutes is stopped in every category.
 *  3. The audit trail is a hash chain; editing it by hand is detected.
 *  4. A closed month cannot be changed without reopening it, and a change made
 *     to the file by hand is named.
 *  5. The integrity check runs on every write and refuses one that makes the books worse.
 *
 * Every refusal is paired with a positive control that is allowed, so a guard that
 * simply refuses everything cannot pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday, sleep } from './harness.mjs';

export const title = 'Ecosystem safeguards (idempotency, duplicates, audit chain, closed months, write guard)';

function lastMonth() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-guards-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'Guard-1234!', projectRoot, dataDir });
  try {
    const c = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
    await activateAdmin(c, 'Guard-1234!', 'GuardNew-9876!');
    const month = lastMonth();
    await makeLongTermUnit(c);
    await c.post('/api/charges/post-month', { monthString: month });

    const rent = (over = {}) => ({
      unitId: 'unit-1', category: 'Rent', amount: 50000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', receivedNow: true,
      date: `${month}-05`, ...over
    });
    const completed = async () => (await c.get('/api/db')).body.payments.filter(p => p.status === 'completed').length;

    /* ---------------- 1. idempotency ---------------- */

    const key = 'key-A';
    const first = await c.post('/api/payments', rent(), { headers: { 'Idempotency-Key': key } });
    T.check('a payment is recorded with its key', first.status === 200, String(first.body?.error || ''));
    const same = await c.post('/api/payments', rent(), { headers: { 'Idempotency-Key': key } });
    T.check('the same key with the same content is replayed, not recorded again', same.status === 200 && same.body?.payment?.id === first.body?.payment?.id && (await completed()) === 1);

    const other = await c.post('/api/payments', rent({ amount: 12345 }), { headers: { 'Idempotency-Key': key } });
    T.check('the same key with DIFFERENT content is refused, not answered with the old receipt', other.status === 422 && other.body?.code === 'idempotency-key-reused', `${other.status} ${other.body?.code}`);
    T.check('and nothing was recorded for it', (await completed()) === 1);
    const fresh = await c.post('/api/payments', rent({ amount: 12345, confirmAlreadySettled: true }), { headers: { 'Idempotency-Key': 'key-B' } });
    T.check('control: a new key with that content is accepted', fresh.status === 200, String(fresh.body?.error || ''));

    await sleep(500);
    await srv.stop();
    srv = await startServer({ port, adminPassword: 'GuardNew-9876!', projectRoot, dataDir });
    const c2 = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
    await c2.post('/api/auth/login', { username: 'admin', password: 'GuardNew-9876!' }, { captureCookie: true });
    const before = (await c2.get('/api/db')).body.payments.length;
    const replay = await c2.post('/api/payments', rent(), { headers: { 'Idempotency-Key': key } });
    T.check('a retry after a restart is still recognised', replay.status === 200 && replay.body?.payment?.id === first.body?.payment?.id, `${replay.status} ${replay.body?.error || ''}`);
    T.check('and posts nothing', (await c2.get('/api/db')).body.payments.length === before);

    /* ---------------- 2. the same money twice, any category ---------------- */

    const util = (over = {}) => ({ unitId: 'unit-1', category: 'Utility', amount: 7777, currency: 'JMD', payerName: 'Tenant', method: 'Cash', receivedNow: true, date: localToday(), ...over });
    const u1 = await c2.post('/api/payments', util());
    T.check('a utility payment is recorded', u1.status === 200, String(u1.body?.error || ''));
    const u2 = await c2.post('/api/payments', util());
    T.check('the same utility payment a moment later is refused', u2.status === 400 && u2.body?.code === 'possible-duplicate-payment', `${u2.status} ${u2.body?.code}`);
    const u3 = await c2.post('/api/payments', util({ amount: 7778 }));
    T.check('control: a different amount is a different payment', u3.status === 200, String(u3.body?.error || ''));
    const u4 = await c2.post('/api/payments', util({ confirmDuplicate: true }));
    T.check('control: confirming it is genuinely separate money records it', u4.status === 200, String(u4.body?.error || ''));

    /* ---------------- 3. the audit chain ---------------- */

    let integ = (await c2.get('/api/integrity')).body;
    T.check('a freshly written audit trail verifies', !integ.findings.some(f => f.code === 'audit-trail-broken'), JSON.stringify(integ.findings.map(f => f.code)));

    /* ---------------- 4. closing a month ---------------- */

    const closed = await c2.post('/api/periods/close', { through: month });
    T.check('a finished month can be closed', closed.status === 200, String(closed.body?.error || ''));
    const thisMonth = localToday().slice(0, 7);
    const tooSoon = await c2.post('/api/periods/close', { through: thisMonth });
    T.check('the current month cannot', tooSoon.status === 400);

    const late = await c2.post('/api/payments', rent({ amount: 100, confirmAlreadySettled: true, date: `${month}-20` }));
    T.check('a payment dated inside the closed month is refused', late.status === 409 && late.body?.code === 'integrity-guard', `${late.status} ${late.body?.code}`);
    T.check('and not recorded', !(await c2.get('/api/db')).body.payments.some(p => p.amount === 100));
    const open = await c2.post('/api/payments', util({ amount: 4242 }));
    T.check('control: a payment dated in the open month is accepted', open.status === 200, String(open.body?.error || ''));

    const noReason = await c2.post('/api/periods/reopen', {});
    T.check('reopening without a reason is refused', noReason.status === 400);
    const reopened = await c2.post('/api/periods/reopen', { reason: 'Late cheque for the closed month' });
    T.check('reopening with a reason works', reopened.status === 200, String(reopened.body?.error || ''));
    const allowed = await c2.post('/api/payments', rent({ amount: 100, confirmAlreadySettled: true, date: `${month}-20` }));
    T.check('control: the same payment is accepted once the month is reopened', allowed.status === 200, String(allowed.body?.error || ''));
    T.check('the reopening is in the audit trail with its reason', (await c2.get('/api/db')).body.auditLogs.some(a => /Reopened the books/.test(a.action) && /Late cheque/.test(a.action)));
    await c2.post('/api/periods/close', { through: month });

    /* ---------------- four eyes on corrections ---------------- */

    {
      const mk = async (amount) => (await c2.post('/api/payments', util({ amount, confirmDuplicate: true }))).body.payment.id;
      const [p1, p2, p3, p4] = [await mk(1111), await mk(2222), await mk(3333), await mk(4444)];
      const v0 = await c2.post(`/api/payments/${p1}/reverse`, { reversalReason: 'entered in error' });
      T.check('control: with approval switched off, a void needs no second person', v0.status === 200, String(v0.body?.error || ''));

      await c2.post('/api/users', { name: 'Second Admin', username: 'second', role: 'ADMINISTRATOR', password: 'SecondPass-11!' });
      const on = await c2.post('/api/settings', { requireCosign: true });
      T.check('an administrator can switch the second approval on', on.status === 200, String(on.body?.error || ''));

      const alone = await c2.post(`/api/payments/${p2}/reverse`, { reversalReason: 'entered in error' });
      T.check('a void with no second person is refused', alone.status === 403 && alone.body?.code === 'cosign-required', `${alone.status} ${alone.body?.code}`);
      const self = await c2.post(`/api/payments/${p2}/reverse`, { reversalReason: 'entered in error', cosign: { username: 'admin', password: 'GuardNew-9876!' } });
      T.check('approving your own void is refused', self.status === 403, `${self.status}`);
      const wrong = await c2.post(`/api/payments/${p2}/reverse`, { reversalReason: 'entered in error', cosign: { username: 'second', password: 'not-the-password' } });
      T.check('a wrong password is refused', wrong.status === 403, `${wrong.status}`);
      const ghost = await c2.post(`/api/payments/${p2}/reverse`, { reversalReason: 'entered in error', cosign: { username: 'nobody', password: 'x' } });
      T.check('an unknown approver gets the same refusal, so names cannot be probed', ghost.status === 403 && ghost.body?.error === wrong.body?.error, String(ghost.body?.error));
      T.check('and the receipt is still standing', (await c2.get('/api/db')).body.payments.find(p => p.id === p2).status === 'completed');

      const ok = await c2.post(`/api/payments/${p2}/reverse`, { reversalReason: 'entered in error', cosign: { username: 'second', password: 'SecondPass-11!' } });
      T.check('control: a different administrator approving lets it through', ok.status === 200, String(ok.body?.error || ''));
      T.check('and both names are in the audit trail', (await c2.get('/api/db')).body.auditLogs.some(a => /Approved by Second Admin/.test(a.action) && a.approvedBy === 'Second Admin'));

      const refund = await c2.post(`/api/payments/${p3}/refund`, { amount: 100, reason: 'overpaid', refundedOn: localToday() });
      T.check('a refund is gated the same way', refund.status === 403 && refund.body?.code === 'cosign-required', `${refund.status} ${refund.body?.code}`);
      const edit = await c2.put(`/api/payments/${p4}`, { amount: 4445 });
      T.check('so is a correction to a received receipt', edit.status === 403 && edit.body?.code === 'cosign-required', `${edit.status} ${edit.body?.code}`);

      let locked = null;
      for (let i = 0; i < 6; i++) locked = await c2.post(`/api/payments/${p4}/reverse`, { reversalReason: 'entered in error', cosign: { username: 'second', password: 'guess-' + i } });
      T.check('repeated wrong guesses are throttled', locked.status === 429, `${locked.status}`);
      await c2.post('/api/settings', { requireCosign: false });
    }

    /* ---------------- hand edits to the file are detected ---------------- */

    await srv.stop();
    const file = path.join(dataDir, 'db.json');
    const clean = fs.readFileSync(file, 'utf-8');
    const doc = JSON.parse(clean);
    const victim = doc.payments.find(p => p.date.slice(0, 7) === month && p.status === 'completed');
    victim.amount += 1; // quietly change a closed month's money
    doc.auditLogs[doc.auditLogs.length > 3 ? 3 : 0].newValue = 'tampered'; // and an audit entry
    fs.writeFileSync(file, JSON.stringify(doc));
    srv = await startServer({ port, adminPassword: 'GuardNew-9876!', projectRoot, dataDir });
    const c3 = makeClient(srv.baseUrl);
    await c3.post('/api/auth/login', { username: 'admin', password: 'GuardNew-9876!' }, { captureCookie: true });
    integ = (await c3.get('/api/integrity')).body;
    T.check('a closed month changed by hand is named', integ.findings.some(f => f.code === 'closed-period-changed'), JSON.stringify(integ.findings.map(f => f.code)));
    T.check('an audit entry edited by hand is named', integ.findings.some(f => f.code === 'audit-trail-broken'), JSON.stringify(integ.findings.map(f => f.code)));

    /* ---------------- 5. existing faults do not block work ---------------- */

    const still = await c3.post('/api/payments', util({ amount: 5151 }));
    T.check('work continues on books that already carry a known fault', still.status === 200, `${still.status} ${still.body?.error || ''}`);

    /* ---------------- one bank line, one receipt ---------------- */

    {
      const db0 = (await c3.get('/api/db')).body;
      const [a, b] = db0.payments.filter(p => p.status === 'completed' && !p.reconciledOn);
      const m1 = await c3.post(`/api/payments/${a.id}/reconcile`, { reconciledOn: localToday(), reference: 'BNK-777' });
      T.check('a receipt is matched to a bank reference', m1.status === 200, String(m1.body?.error || ''));
      const m2 = await c3.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: localToday(), reference: 'bnk-777' });
      T.check('the same reference on a second receipt is refused', m2.status === 400 && m2.body?.code === 'bank-line-already-matched', `${m2.status} ${m2.body?.code}`);
      const m3 = await c3.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: localToday(), reference: 'BNK-778' });
      T.check('control: a different reference is accepted', m3.status === 200, String(m3.body?.error || ''));
    }

    /* ---------------- clean books reconcile ---------------- */

    await srv.stop();
    fs.writeFileSync(file, clean);
    srv = await startServer({ port, adminPassword: 'GuardNew-9876!', projectRoot, dataDir });
    const c4 = makeClient(srv.baseUrl);
    await c4.post('/api/auth/login', { username: 'admin', password: 'GuardNew-9876!' }, { captureCookie: true });
    integ = (await c4.get('/api/integrity')).body;
    T.check('control: the untouched file shows no closed-period or audit fault', !integ.findings.some(f => ['closed-period-changed', 'audit-trail-broken'].includes(f.code)), JSON.stringify(integ.findings.map(f => f.code)));
    T.check('and every account balance reconciles with the raw ledger', !integ.findings.some(f => f.code === 'balance-does-not-reconcile'), JSON.stringify(integ.findings.filter(f => f.code === 'balance-does-not-reconcile')));
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
