/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * ISPO's strata contribution, and what happens when it is paid twice.
 *
 * Ro, 2026-11-18: *"Tenants do not pay maintenance they pay rent only. we dont
 * give them a receipt for maintenance. once rent is paid, the maintenance payment
 * should come out of it and accounted for accordingly"* and *"the levy is not
 * credited to ISPO, that levy is ISPO's maintenance payment to the strata
 * corporation the same as every owner. That is how ISPO pays the strata
 * contribution."*
 *
 * So on a let villa there is one figure the tenant pays — the rent — and the levy
 * inside it is ISPO's own contribution to Villaggio Del Sol, settled out of that
 * rent rather than by a receipt of its own.
 *
 * The rules this holds the application to:
 *
 *   1. Rent received settles the month's levy, with no separate receipt and
 *      nothing for the tenant to pay twice.
 *   2. A second, hand-entered levy receipt for a month the rent already covered
 *      is recognised as the same obligation paid twice, and refused unless
 *      somebody deliberately confirms it. The server and the screen must agree
 *      about this — the check used to read the stored receipts only, so it never
 *      fired on exactly the villas the arrangement exists for.
 *   3. If it is taken anyway, it can be given back in full. It used to be
 *      unreachable: the cash displaced the contribution worked out from the rent,
 *      the account read nil, and nil was what counted as unspent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = "ISPO's strata contribution comes out of the rent";

const TODAY = localToday();
const THIS_MONTH = TODAY.slice(0, 7);
const PASS = 'Str0ng-Pass!2026';
const r2 = n => Math.round(n * 100) / 100;

function monthBack(back) {
  const [y, m] = TODAY.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-cfr-'));
  const outfile = path.join(dir, 'fin.mjs');
  await build({
    stdin: { contents: `export * as fin from './src/lib/finance';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { fin: mod.fin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { fin, cleanup } = await loadFinance(projectRoot);
  const server = await startServer({ port, adminPassword: 'admin123', projectRoot });
  const c = makeClient(server.baseUrl);

  try {
    await activateAdmin(c, 'admin123', PASS);
    await c.put('/api/units/unit-1', {
      number: '1',
      ownerName: 'ISPO',
      tenantName: 'Tenant One',
      status: 'long-term',
      monthlyRent: 75000,
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });
    await c.post('/api/charges/post-month', { monthString: THIS_MONTH });

    let db = (await c.get('/api/db')).body;
    const rentCharge = db.charges.find(x => x.unitId === 'unit-1' && x.category === 'Rent' && x.periodMonth === THIS_MONTH);
    T.check(
      'the tenant is billed one figure, with ISPO\'s levy named inside it',
      rentCharge && r2(rentCharge.amount) === 75000 && r2(rentCharge.maintenancePortion) === 20000 && r2(rentCharge.rentPortion) === 55000,
      JSON.stringify(rentCharge && { a: rentCharge.amount, r: rentCharge.rentPortion, m: rentCharge.maintenancePortion })
    );

    /* ---- Rule 1 ------------------------------------------------------ */
    const rent = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Rent',
      amount: 75000,
      currency: 'JMD',
      payerName: 'Tenant One',
      method: 'Cash',
      date: `${THIS_MONTH}-05`,
      receivedNow: true
    });
    const rentId = rent.body?.payment?.id;
    if (rentId) await c.post(`/api/payments/${rentId}/confirm`, {});

    db = (await c.get('/api/db')).body;
    T.check(
      'Rule 1 — the tenant is receipted for rent only, never for maintenance',
      db.payments.filter(p => p.unitId === 'unit-1' && p.category === 'Maintenance').length === 0,
      'a maintenance receipt was issued to the tenant'
    );

    /* ---- Rule 2 ------------------------------------------------------ */
    const second = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 20000,
      currency: 'JMD',
      payerName: 'ISPO',
      method: 'Cash',
      date: TODAY,
      receivedNow: true
    });
    /*
     * The refusal must be the ALREADY_SETTLED one specifically. A test that
     * accepts any 4xx would have passed on "a payment cannot be dated in the
     * future" — which is how a test comes to prove nothing at all.
     */
    T.check(
      'Rule 2 — a second levy payment for a month the rent already covered is refused until somebody confirms it',
      second.status === 400 && /owes nothing/.test(JSON.stringify(second.body)) && /received/.test(JSON.stringify(second.body)),
      `${second.status} ${JSON.stringify(second.body).slice(0, 200)}`
    );
    T.check(
      'Rule 2b — and it names the levy already settled from the rent, so the cashier knows why',
      /settled/i.test(JSON.stringify(second.body)),
      JSON.stringify(second.body).slice(0, 200)
    );

    /* ---- Rule 3 ------------------------------------------------------ */
    const forced = await c.post('/api/payments', {
      unitId: 'unit-1',
      category: 'Maintenance',
      amount: 20000,
      currency: 'JMD',
      payerName: 'ISPO',
      method: 'Cash',
      date: TODAY,
      receivedNow: true,
      confirmAlreadySettled: true
    });
    const forcedId = forced.body?.payment?.id;
    if (forcedId) await c.post(`/api/payments/${forcedId}/confirm`, {});
    T.check('setup: the duplicate levy payment was taken once confirmed', !!forcedId && forced.status === 200, `${forced.status}`);

    const refund = await c.post(`/api/payments/${forcedId}/refund`, {
      amount: 20000,
      reason: 'the levy for this month came out of the rent',
      method: 'Cash',
      refundedOn: TODAY
    });
    T.check(
      'Rule 3 — the duplicate can be handed back in full, because the rent covered the month without it',
      refund.status === 200,
      `${refund.status} ${JSON.stringify(refund.body).slice(0, 220)}`
    );

    db = (await c.get('/api/db')).body;
    const refunded = db.payments.find(p => p.id === forcedId);
    T.check(
      'Rule 3b — and the ledger records the money going back out, rather than pretending it never arrived',
      refunded && r2(refunded.refundedAmount) === 20000 && refunded.status === 'completed',
      JSON.stringify(refunded && { status: refunded.status, refunded: refunded.refundedAmount })
    );
    /* ---- Rule 4: the last month paid at move-in carries its levy ------ */
    const movedIn = `${monthBack(2)}-01`;
    await c.put('/api/units/unit-2', {
      number: '2',
      ownerName: 'ISPO',
      tenantName: 'Tenant Two',
      status: 'long-term',
      monthlyRent: 60000,
      monthlyMaintenance: 15000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });
    /*
     * The move-in date goes on the TENANCY, and setting it is what raises first
     * and last month's rent. Putting it on the villa does nothing, which is a
     * quiet way for a test to prove nothing at all.
     */
    const freshTenancy = (await c.get('/api/db')).body.tenancies.find(t => t.unitId === 'unit-2' && t.status === 'active');
    const started = await c.put(`/api/tenancies/${freshTenancy.id}`, { startedOn: movedIn });
    T.check('setup: the move-in date was recorded', started.status === 200, `${started.status} ${JSON.stringify(started.body).slice(0, 140)}`);
    for (const m of [monthBack(2), monthBack(1), monthBack(0)]) await c.post('/api/charges/post-month', { monthString: m });

    db = (await c.get('/api/db')).body;
    const advance = db.charges.find(x => x.unitId === 'unit-2' && x.kind === 'advance-final-month');
    if (!advance) {
      console.log('    DEBUG tenancies:', JSON.stringify(db.tenancies.map(t => ({ u: t.unitId, s: t.startedOn, st: t.status, adv: t.advanceRentChargeId }))));
      console.log('    DEBUG unit2 charges:', JSON.stringify(db.charges.filter(x => x.unitId === 'unit-2').map(x => ({ c: x.category, p: x.periodMonth, k: x.kind }))));
      console.log('    DEBUG booksBeginOn:', db.settings.booksBeginOn);
    }
    T.check(
      "setup: first and last month's rent were raised, and the last carries ISPO's levy inside it",
      advance && r2(advance.maintenancePortion) === 15000,
      JSON.stringify(advance && { period: advance.periodMonth, m: advance.maintenancePortion })
    );

    // The tenant pays everything they owe, rent only, as they always do.
    for (const ch of db.charges.filter(x => x.unitId === 'unit-2' && x.category === 'Rent' && x.status === 'open')) {
      const p = await c.post('/api/payments', {
        unitId: 'unit-2',
        category: 'Rent',
        amount: ch.amount,
        currency: 'JMD',
        payerName: 'Tenant Two',
        method: 'Cash',
        date: `${ch.periodMonth === THIS_MONTH ? THIS_MONTH : ch.periodMonth}-05`,
        receivedNow: true
      });
      const pid = p.body?.payment?.id;
      if (pid) await c.post(`/api/payments/${pid}/confirm`, {});
    }

    const tenancyTwo = (await c.get('/api/db')).body.tenancies.find(t => t.unitId === 'unit-2' && t.status === 'active');
    const ended = await c.put(`/api/tenancies/${tenancyTwo.id}`, { status: 'ended', endedOn: TODAY });
    T.check('setup: the tenant moved out', ended.status === 200, `${ended.status} ${JSON.stringify(ended.body).slice(0, 160)}`);

    db = (await c.get('/api/db')).body;
    const unitTwo = db.units.find(u => u.id === 'unit-2');
    const withContributions = db.payments.concat(fin.settledFromRent(db.charges, db.payments));
    const levyAccount = fin.accountBalance(unitTwo, 'Maintenance', db.charges, withContributions, undefined, db.units);
    T.check(
      "Rule 4 — the final month's levy is settled from the rent paid in advance, not billed to ISPO as arrears",
      r2(levyAccount.balance) <= 0,
      `the levy account still shows ${levyAccount.balance} owing after the tenant paid everything`
    );

    const movedToFinal = db.charges.find(x => x.id === advance.id);
    T.check(
      'Rule 4b — and the advance now stands against the month it actually paid for',
      movedToFinal && movedToFinal.periodMonth === THIS_MONTH,
      `advance still sits in ${movedToFinal && movedToFinal.periodMonth}`
    );
    /* ---- Rule 5: one answer to "what share of the month was collected" --- */
    await c.put('/api/units/unit-5', {
      number: '5',
      ownerName: 'ISPO',
      tenantName: 'Tenant Five',
      status: 'long-term',
      monthlyRent: 50000,
      monthlyMaintenance: 10000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      rentDueDay: 1,
      maintDueDay: 1
    });
    await c.post('/api/charges/post-month', { monthString: THIS_MONTH });
    const fiveRent = await c.post('/api/payments', {
      unitId: 'unit-5',
      category: 'Rent',
      amount: 50000,
      currency: 'JMD',
      payerName: 'Tenant Five',
      method: 'Cash',
      date: `${THIS_MONTH}-05`,
      receivedNow: true
    });
    if (fiveRent.body?.payment?.id) await c.post(`/api/payments/${fiveRent.body.payment.id}/confirm`, {});

    const assessment = await c.post('/api/charges', {
      unitId: 'unit-5',
      category: 'Maintenance',
      oneOffType: 'Special assessment',
      amount: 300000,
      currency: 'JMD',
      dueDate: `${THIS_MONTH}-02`,
      description: 'Roof works'
    });
    T.check('setup: a special assessment was raised on the villa', assessment.status === 200, `${assessment.status} ${JSON.stringify(assessment.body).slice(0, 140)}`);
    const assessPaid = await c.post('/api/payments', {
      unitId: 'unit-5',
      category: 'Maintenance',
      amount: 300000,
      currency: 'JMD',
      payerName: 'ISPO',
      method: 'Bank Transfer',
      date: `${THIS_MONTH}-10`,
      receivedNow: true
    });
    if (assessPaid.body?.payment?.id) await c.post(`/api/payments/${assessPaid.body.payment.id}/confirm`, {});
    T.check('setup: and paid in full', assessPaid.status === 200, `${assessPaid.status} ${JSON.stringify(assessPaid.body).slice(0, 160)}`);

    db = (await c.get('/api/db')).body;
    const fiveOnly = db.units.filter(u => u.id === 'unit-5');
    const fiveCharges = db.charges.filter(x => x.unitId === 'unit-5');
    const fivePayments = db.payments.filter(x => x.unitId === 'unit-5');
    const combined = fin.combinedSettledOfBilled(fiveCharges, fivePayments, fiveOnly, 'JMD', `${THIS_MONTH}-01`, `${THIS_MONTH}-28`, `${THIS_MONTH}-28`);
    T.check(
      'Rule 5 — everything billed for the month was paid, so the combined rate says so',
      combined.rate === 100,
      `the ledger panel would print ${combined.rate}% of ${combined.billed} billed, settled ${combined.settled}`
    );

  } finally {
    cleanup();
    await server.stop();
  }

  return T.done();
}
