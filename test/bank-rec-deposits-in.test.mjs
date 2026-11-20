/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A deposit taken is money in on the bank reconciliation.
 *
 * Hunt, 2026-11-19: J$170,000 of tenancy deposits had reached the bank and
 * appeared nowhere on the reconciliation, while their return would have shown
 * as money out. A deposit is the tenant's or guest's money held, never income,
 * so it raises no receipt; it now stands on the money-in side in its own right,
 * matched to a statement line like any other movement. Positive controls
 * throughout, so a refusal never passes for a rule that is merely broken.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Bank reconciliation: deposits received are money in';

async function bundle(projectRoot, entry, external = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-depin-'));
  const outfile = path.join(dir, 'mod.mjs');
  await build({ entryPoints: [path.join(projectRoot, ...entry)], bundle: true, format: 'esm', platform: 'neutral', external, outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'DepIn-1234!', projectRoot });
  const T = reporter(title);
  const rec = await bundle(projectRoot, ['src', 'lib', 'bankRec.ts']);
  const integ = await bundle(projectRoot, ['server', 'integrity.ts'], ['crypto', 'fs', 'path']);
  try {
    const admin = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(admin, 'DepIn-1234!', 'DepInNew-9876!');
    await makeLongTermUnit(admin, 'unit-1');
    await admin.put('/api/units/unit-2', { number: 'B2', ownerName: 'ISPO', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'USD', maintCurrency: 'JMD', maintDueDay: 1 });

    let db = (await admin.get('/api/db')).body;
    const tenancy = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    const dep = await admin.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 90000, currency: 'JMD', method: 'Bank Transfer', receivedOn: '2026-10-03' });
    T.check('setup: a J$90,000 tenancy deposit received 2026-10-03', dep.status === 200, `${dep.status} ${JSON.stringify(dep.body).slice(0, 200)}`);
    const stay = (await admin.post('/api/bookings', { unitId: 'unit-2', guestName: 'Damage Guest', checkIn: '2026-10-10', checkOut: '2026-10-12', currency: 'USD', source: 'Direct', amount: 300 })).body?.booking;
    const dd = await admin.post(`/api/bookings/${stay?.id}/damage-deposit`, { amount: 200, currency: 'USD', receivedOn: '2026-10-09' });
    T.check('setup: a US$200 damage deposit received 2026-10-09', dd.status === 200, `${dd.status} ${JSON.stringify(dd.body).slice(0, 200)}`);

    db = (await admin.get('/api/db')).body;
    const input = { payments: db.payments, expenses: db.expenses, tenancies: db.tenancies, bookings: db.bookings };
    const jmd = rec.mod.bankReconciliation(input, 'JMD', '2026-10-01', '2026-10-31');
    const usd = rec.mod.bankReconciliation(input, 'USD', '2026-10-01', '2026-10-31');
    const jIn = jmd.moneyIn.items.find(i => i.kind === 'deposit-received');
    const uIn = usd.moneyIn.items.find(i => i.kind === 'damage-deposit-received');
    T.check('the tenancy deposit is money in on the JMD reconciliation, on the day received', jIn?.amount === 90000 && jIn.date === '2026-10-03' && jIn.direction === 'in', JSON.stringify(jIn));
    T.check('the damage deposit is money in on the USD reconciliation', uIn?.amount === 200 && uIn.date === '2026-10-09', JSON.stringify(uIn));
    T.check('and neither crosses into the other currency', !jmd.moneyIn.items.some(i => i.kind === 'damage-deposit-received') && !usd.moneyIn.items.some(i => i.kind === 'deposit-received'));
    const nov = rec.mod.bankReconciliation(input, 'JMD', '2026-11-01', '2026-11-30');
    T.check('control: it is not money in for a month it was not received', !nov.moneyIn.items.some(i => i.kind === 'deposit-received'));
    T.check('a deposit raises no receipt, so it is counted once', !db.payments.some(p => p.amount === 90000));

    const m = await admin.post(`/api/tenancies/${tenancy.id}/deposit-received/reconcile`, { reconciledOn: '2026-10-04', currency: 'JMD', reference: 'NCB IN 9' });
    T.check('the deposit received can be matched to a statement line', m.status === 200 && m.body?.record?.depositBankMatch?.on === '2026-10-04', `${m.status} ${JSON.stringify(m.body).slice(0, 200)}`);
    const early = await admin.post(`/api/bookings/${stay.id}/damage-deposit-received/reconcile`, { reconciledOn: '2026-10-08', currency: 'USD' });
    T.check('a statement date before the deposit arrived is refused', early.status === 400 && early.body?.code === 'bank-date-before-item', `${early.status} ${early.body?.code}`);
    const ok = await admin.post(`/api/bookings/${stay.id}/damage-deposit-received/reconcile`, { reconciledOn: '2026-10-09', currency: 'USD' });
    T.check('control: the damage deposit matched on its own day', ok.status === 200 && ok.body?.record?.damageDepositBankMatch?.on === '2026-10-09', `${ok.status}`);
    const audit = (await admin.get('/api/db')).body.auditLogs;
    T.check('the match is on the audit trail with the amount', audit.some(a => /^Matched the deposit received from .* \(JMD 90000\) to the bank statement of 2026-10-04, line "NCB IN 9"/.test(a.action)));

    const replace = await admin.post(`/api/tenancies/${tenancy.id}/deposit`, { amount: 80000, currency: 'JMD', receivedOn: '2026-10-03', replace: true, overrideReason: 'Wrong figure' });
    T.check('a deposit matched to the bank cannot be replaced until un-matched', replace.status === 409 && replace.body?.code === 'bank-item-already-matched', `${replace.status} ${replace.body?.code}`);
    const un = await admin.post(`/api/tenancies/${tenancy.id}/deposit-received/reconcile`, { reconciled: false });
    T.check('control: un-matching it is allowed', un.status === 200 && !un.body?.record?.depositBankMatch, `${un.status}`);

    // A tick on a deposit the books do not hold is reported.
    db = (await admin.get('/api/db')).body;
    const t = db.tenancies.find(x => x.id === tenancy.id);
    const bogus = { ...db, tenancies: db.tenancies.map(x => (x.id === t.id ? { ...x, depositAmount: 0, depositBankMatch: { on: '2026-10-04', by: 'x', at: 'x' } } : x)) };
    const codes = d => integ.mod.checkIntegrity(d).findings.map(f => f.code);
    const flagged = codes(bogus).includes('bank-match-without-deposit-in');
    const clean = codes(db);
    T.check('integrity reports a bank tick on a deposit the books do not hold', flagged, JSON.stringify(codes(bogus)));
    T.check('control: and not on a sound database', !clean.includes('bank-match-without-deposit-in'));
  } finally {
    rec.cleanup();
    integ.cleanup();
    await srv.stop();
  }
  return T.done();
}
