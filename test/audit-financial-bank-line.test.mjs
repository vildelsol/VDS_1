/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bank reconciliation: matching a second receipt to a statement line that is
 * already matched is an override of a money check (audit, 2026-11-18).
 *
 * `confirmSameLine` used to be honoured for anyone allowed to tick receipts,
 * which by default includes the Junior Officer. One line on a statement settles
 * one receipt; telling the books otherwise hides a receipt the bank never saw.
 * It now goes through `useMoneyOverride`: the override permission, a reason, and
 * an audit line, the same gate as every other money override.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Audit: bank-line override needs permission, a reason and an audit line';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'BankLine-1234!', projectRoot });
  const T = reporter(title);
  try {
    // Sent exactly as given: no reason is added behind the test's back.
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'BankLine-1234!', 'BankLineNew-9876!');
    await makeLongTermUnit(admin, 'unit-1', { monthlyRent: 50000, monthlyMaintenance: 10000 });
    await admin.post('/api/charges/post-month', { monthString: '2026-10' });
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });

    const receipt = async (amount, date) =>
      (await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Rent', amount, currency: 'JMD', payerName: 'Tenant', method: 'Bank Transfer', date, confirmDuplicate: true, overrideReason: 'test receipts' })).body?.payment;
    const a = await receipt(20000, '2026-10-03');
    const b = await receipt(15000, '2026-10-04');
    const d = await receipt(15000, '2026-10-05');
    T.check('setup: three completed receipts', [a, b, d].every(p => p?.status === 'completed'), JSON.stringify([a, b, d].map(p => p?.status)));

    const first = await admin.post(`/api/payments/${a.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'NCB TRF 777' });
    T.check('the first receipt is matched to the statement line', first.status === 200 && first.body?.payment?.reconciledReference === 'NCB TRF 777', `${first.status}`);

    // Positive control: the junior may tick receipts at all.
    const own = await jr.post(`/api/payments/${d.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'NCB TRF 999' });
    T.check('a junior can still match a receipt to its own statement line (positive control)', own.status === 200, `${own.status} ${JSON.stringify(own.body)}`);

    const plain = await jr.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'ncb trf 777' });
    T.check('a second receipt on the same line is refused', plain.status === 400 && plain.body?.code === 'bank-line-already-matched', `${plain.status} ${plain.body?.code}`);

    const junior = await jr.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'NCB TRF 777', confirmSameLine: true, overrideReason: 'Two lines, same reference' });
    T.check('a junior cannot override it by confirming', junior.status === 403 && junior.body?.code === 'override-not-permitted', `${junior.status} ${junior.body?.code}`);

    const noReason = await admin.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'NCB TRF 777', confirmSameLine: true });
    T.check('an administrator overriding it must give a reason', noReason.status === 400 && noReason.body?.code === 'override-reason-required', `${noReason.status} ${noReason.body?.code}`);

    let db = (await admin.get('/api/db')).body;
    T.check('nothing was matched by the refused attempts', !db.payments.find(p => p.id === b.id).reconciledOn);

    const withReason = await admin.post(`/api/payments/${b.id}/reconcile`, { reconciledOn: '2026-10-10', reference: 'NCB TRF 777', confirmSameLine: true, overrideReason: 'Bank split one transfer into two lines with one reference' });
    T.check('with a reason the administrator can match it', withReason.status === 200 && withReason.body?.payment?.reconciledOn === '2026-10-10', `${withReason.status} ${JSON.stringify(withReason.body)}`);

    db = (await admin.get('/api/db')).body;
    const line = db.auditLogs.find(l => /Overrode a money check/.test(l.action) && /NCB TRF 777/.test(l.action));
    T.check('and the override is in the audit log with who and why', !!line && /split one transfer/.test(line.action) && line.user, JSON.stringify(line));

    /*
     * Any screen that sends the flag must ask for the reason. Today none does: the
     * Reconciliation screen sends no bank reference, so the twin check never fires
     * from it. This keeps a future screen honest.
     */
    const dir = path.join(projectRoot, 'src', 'components');
    const senders = fs.readdirSync(dir).filter(f => f.endsWith('.tsx') && /confirmSameLine/.test(fs.readFileSync(path.join(dir, f), 'utf-8')));
    for (const f of senders) {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      T.check(`${f} sends confirmSameLine with an overrideReason and shows the reason field`, /overrideReason/.test(src) && /<OverrideReasonField\b/.test(src));
    }
    T.check('the scan reads the component sources (positive control)', fs.readdirSync(dir).some(f => f === 'Reconciliation.tsx'), `${senders.length} sender(s)`);
  } finally {
    await srv.stop();
  }
  return T.done();
}
