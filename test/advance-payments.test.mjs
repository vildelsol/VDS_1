/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Paying in advance — tenants and proprietors may pay ahead and have later
 * charges deducted from the credit.
 *
 * Requirement (Ro, 2026-11-16). Credit stays DERIVED (a negative account
 * balance), never stored. What this pins:
 *  - an explicit advance payment is accepted where the generic overrides would
 *    have been needed, is marked as an advance, and the same money WITHOUT the
 *    flag is still refused (control);
 *  - later charges consume the credit oldest-first, and the balance reaches zero;
 *  - only unspent credit can be refunded;
 *  - credit a former tenant left cannot pay the next tenant's rent: the changeover
 *    is refused until it is refunded;
 *  - an advance is refused where it could offset nothing (wrong currency, villa not billed).
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, localToday, accountOwedCents } from './harness.mjs';

export const title = 'Advance payments and credit';

function monthsAhead(n) {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Advance-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Advance-1234!', 'AdvanceNew-9876!');
    const db = async () => (await c.get('/api/db')).body;
    const balance = async (unitId, category) => {
      const d = await db();
      return accountOwedCents(d, unitId, category, 'JMD') / 100;
    };
    const receive = (unitId, category, amount, extra = {}) =>
      c.post('/api/payments', { unitId, category, amount, currency: 'JMD', payerName: 'Payer', method: 'Cash', date: localToday(), receivedNow: true, ...extra });

    await makeLongTermUnit(c, 'unit-1', { tenantName: 'Tenant One' });

    /* ---- nothing billed yet: a prepayment with the intent flag ---- */
    const noFlag = await receive('unit-1', 'Maintenance', 30000);
    T.check('control: money with nothing billed and no stated intent is still refused', noFlag.status === 400, `${noFlag.status}`);
    const adv0 = await receive('unit-1', 'Maintenance', 30000, { advancePayment: true });
    T.check('the same money as an explicit advance is accepted', adv0.status === 200, String(adv0.body?.error || ''));
    T.check('and it is marked as an advance', adv0.body?.payment?.advance === true);
    T.check('it sits as a credit, not as a lost payment', (await balance('unit-1', 'Maintenance')) === -30000);
    const audit = (await db()).auditLogs.find(a => /advance/.test(a.action));
    T.check('the audit line says it was held as an advance', !!audit);

    /* ---- later charges consume the credit, oldest first ---- */
    await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
    T.check('the month posted: the credit covers it (10000 billed, 30000 paid)', (await balance('unit-1', 'Maintenance')) === -20000, String(await balance('unit-1', 'Maintenance')));
    const d1 = await db();
    const acct = d1.charges.filter(x => x.unitId === 'unit-1' && x.category === 'Maintenance' && x.status === 'open');
    T.check('exactly one maintenance charge was posted (the advance created none)', acct.length === 1, `${acct.length}`);

    /* ---- a prepayment above what is owed, rent ---- */
    const over = await receive('unit-1', 'Rent', 150000);
    T.check('control: 150000 against 50000 owed without the flag is refused', over.status === 400, `${over.status}`);
    const rentAdv = await receive('unit-1', 'Rent', 150000, { advancePayment: true });
    T.check('with the flag it is accepted', rentAdv.status === 200, String(rentAdv.body?.error || ''));
    T.check('rent balance is a 100000 credit', (await balance('unit-1', 'Rent')) === -100000, String(await balance('unit-1', 'Rent')));

    /* ---- only unspent credit can be refunded ---- */
    const tooMuch = await c.post(`/api/payments/${rentAdv.body.payment.id}/refund`, { amount: 150000, reason: 'Wants it all back', method: 'Cash' });
    T.check('refunding the spent part of the receipt is refused', tooMuch.status === 400 && tooMuch.body?.code === 'refund-exceeds-unspent-credit', `${tooMuch.status} ${tooMuch.body?.code}`);
    T.check('and nothing was changed', (await balance('unit-1', 'Rent')) === -100000);

    /* ---- credit a former tenant left cannot pay the next tenant ---- */
    const blocked = await c.put('/api/units/unit-1', {
      number: '1', ownerName: 'Owner', tenantName: 'Tenant Two', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000,
      currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, tenantChangeIntent: 'changeover'
    });
    T.check('a changeover while the former tenant holds credit is refused', blocked.status === 400 && blocked.body?.code === 'former-tenant-credit', `${blocked.status} ${blocked.body?.code} ${String(blocked.body?.error).slice(0, 100)}`);
    const refunded = await c.post(`/api/payments/${rentAdv.body.payment.id}/refund`, { amount: 100000, reason: 'Tenant leaving, unused advance returned', method: 'Cash' });
    T.check('the unspent 100000 can be refunded', refunded.status === 200, String(refunded.body?.error || ''));
    T.check('the balance is then settled, not in credit', (await balance('unit-1', 'Rent')) === 0, String(await balance('unit-1', 'Rent')));
    const allowed = await c.put('/api/units/unit-1', {
      number: '1', ownerName: 'Owner', tenantName: 'Tenant Two', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000,
      currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, tenantChangeIntent: 'changeover'
    });
    T.check('with the credit refunded, the changeover goes through', allowed.status === 200, String(allowed.body?.error || '').slice(0, 160));

    /* ---- an advance that could offset nothing ---- */
    const usd = await receive('unit-1', 'Rent', 100, { advancePayment: true, currency: 'USD' });
    T.check('an advance in the wrong currency is refused', usd.status === 400, `${usd.status}`);
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner', tenantName: '', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    const notBilled = await receive('unit-2', 'Rent', 5000, { advancePayment: true });
    T.check('an advance of rent on a villa that is not billed rent is refused', notBilled.status === 400, `${notBilled.status}`);
    const ownerMaint = await receive('unit-2', 'Maintenance', 30000, { advancePayment: true });
    T.check('but an owner can pay maintenance in advance', ownerMaint.status === 200, String(ownerMaint.body?.error || ''));
    T.check('and it shows as a credit on the owner account', (await balance('unit-2', 'Maintenance')) === -30000);

    /* ---- the seller's credit does not pay the buyer's contributions ---- */
    const ownerBody = (over = {}) => ({ number: '2', ownerName: 'Seller Owner', tenantName: '', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over });
    // Ro, 2026-11-21: sales happen outside the app; the status change is never blocked over money. The seller's
    // credit stays the seller's: a payment pays only the payer's own levy.
    const sale = await c.put('/api/units/unit-2', ownerBody({ ownerName: 'Buyer Owner', ownerChangeIntent: 'sale', ownerAcquiredOn: localToday() }));
    T.check('a sale while the seller holds maintenance credit goes through (not blocked)', sale.status === 200, `${sale.status} ${sale.body?.code} ${String(sale.body?.error).slice(0, 100)}`);

    /* ---- credit that already sits on a villa that changed hands is surfaced ---- */
    await makeLongTermUnit(c, 'unit-4', { tenantName: 'Leaving Tenant' });
    await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
    const adv4 = await receive('unit-4', 'Rent', 200000, { advancePayment: true });
    T.check('setup: unit-4 holds rent credit', adv4.status === 200 && (await balance('unit-4', 'Rent')) < 0, String(adv4.body?.error || ''));
    const before4 = (await c.get('/api/integrity')).body.findings.find(f => f.code === 'credit-held-on-a-villa-that-changed-hands');
    T.check("the sold villa's leftover seller credit is named for the office to settle", !!before4 && before4.records.some(r => /Villa 2/.test(r)), JSON.stringify(before4 || null).slice(0, 200));
    T.check('control: unit-4\'s tenant has not left, so unit-4 is not named yet', !before4 || !before4.records.some(r => /Villa 4/.test(r)), JSON.stringify(before4 || null).slice(0, 200));
    const vac = await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner', tenantName: '', status: 'vacant', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, tenantChangeIntent: 'moved-out' });
    T.check('setup: the villa was set vacant and its tenancy ended', vac.status === 200 && (await db()).tenancies.some(t => t.unitId === 'unit-4' && t.status === 'ended'), `${vac.status} ${JSON.stringify(vac.body).slice(0, 160)} ${JSON.stringify((await db()).tenancies.filter(t => t.unitId === 'unit-4').map(t => t.status))}`);
    const found = (await c.get('/api/integrity')).body.findings.find(f => f.code === 'credit-held-on-a-villa-that-changed-hands');
    T.check('once the tenancy ended with credit on the account, the integrity check names the villa', !!found && found.records.some(r => /Villa 4 rent/.test(r)), JSON.stringify(found || null).slice(0, 200));

    /* ---- a returning tenant does not inherit a stranger's credit (QA, 2026-11-16) ---- */
    {
      const monthsBack = n => monthsAhead(-n);
      const body = (tenant, over = {}) => ({ number: '5', ownerName: 'Owner', tenantName: tenant, status: tenant ? 'long-term' : 'vacant', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over });
      await c.put('/api/units/unit-5', body('Alice'));
      for (const n of [2, 1, 0]) await c.post('/api/charges/post-month', { monthString: monthsBack(n) });
      await receive('unit-5', 'Rent', 150000, { payerName: 'Alice' });
      T.check('setup: Alice has paid three months in full, no credit', (await balance('unit-5', 'Rent')) === 0, String(await balance('unit-5', 'Rent')));
      const out1 = await c.put('/api/units/unit-5', body('', { tenantChangeIntent: 'moved-out' }));
      const inBob = await c.put('/api/units/unit-5', body('Bob'));
      T.check('setup: Bob moves in after Alice', out1.status === 200 && inBob.status === 200, `${out1.status} ${inBob.status} ${String(inBob.body?.error || '').slice(0, 100)}`);
      const bobAdv = await receive('unit-5', 'Rent', 100000, { payerName: 'Bob', advancePayment: true });
      T.check('setup: Bob prepays, leaving 100000 credit', bobAdv.status === 200 && (await balance('unit-5', 'Rent')) === -100000, `${bobAdv.status} ${await balance('unit-5', 'Rent')}`);
      await c.put('/api/units/unit-5', body('', { tenantChangeIntent: 'moved-out' }));
      const carl = await c.put('/api/units/unit-5', body('Carl'));
      T.check('Carl (a stranger) is refused: Bob left credit', carl.status === 400 && carl.body?.code === 'former-tenant-credit', `${carl.status} ${carl.body?.code}`);
      const aliceBack = await c.put('/api/units/unit-5', body('Alice'));
      T.check('Alice returning is ALSO refused: her old payments were spent on her own rent, they are not this credit', aliceBack.status === 400 && aliceBack.body?.code === 'former-tenant-credit', `${aliceBack.status} ${aliceBack.body?.code}`);
    }

    /* ---- a pending advance cannot be confirmed onto a different holder or an unbilled villa (QA) ---- */
    {
      const body = (tenant, over = {}) => ({ number: '6', ownerName: 'Owner', tenantName: tenant, status: tenant ? 'long-term' : 'vacant', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over });
      await c.put('/api/units/unit-6', body('Old P'));
      await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
      const logged = await c.post('/api/payments', { unitId: 'unit-6', category: 'Rent', amount: 90000, currency: 'JMD', payerName: 'Old P', method: 'Cheque', date: localToday(), advancePayment: true });
      T.check('setup: Old P logs a pending advance', logged.status === 200 && logged.body?.payment?.status === 'pending', `${logged.status} ${String(logged.body?.error || '').slice(0, 100)}`);
      await c.put('/api/units/unit-6', body('', { tenantChangeIntent: 'moved-out' }));
      await c.put('/api/units/unit-6', body('Newbie Q'));
      const late = await c.post(`/api/payments/${logged.body.payment.id}/confirm`, {});
      T.check('confirming Old P\'s advance after Newbie Q took over is refused', late.status === 400, `${late.status} ${String(late.body?.error || '').slice(0, 120)}`);
      T.check('and no credit landed on Newbie Q', (await balance('unit-6', 'Rent')) >= 0, String(await balance('unit-6', 'Rent')));

      await c.put('/api/units/unit-7', { ...body('Tenant Seven'), number: '7' });
      await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
      const logged7 = await c.post('/api/payments', { unitId: 'unit-7', category: 'Rent', amount: 90000, currency: 'JMD', payerName: 'Tenant Seven', method: 'Cheque', date: localToday(), advancePayment: true });
      await c.put('/api/units/unit-7', { ...body('', { tenantChangeIntent: 'moved-out' }), number: '7' });
      const conf7 = await c.post(`/api/payments/${logged7.body.payment.id}/confirm`, {});
      T.check('confirming a rent advance on a villa that is no longer billed rent is refused', conf7.status === 400, `${conf7.status} ${String(conf7.body?.error || '').slice(0, 120)}`);

      await c.put('/api/units/unit-8', { ...body('Tenant Eight'), number: '8' });
      await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
      const logged8 = await c.post('/api/payments', { unitId: 'unit-8', category: 'Rent', amount: 90000, currency: 'JMD', payerName: 'Tenant Eight', method: 'Cheque', date: localToday(), advancePayment: true });
      const redenom = await c.put('/api/units/unit-8', { ...body('Tenant Eight'), number: '8', currency: 'USD', maintCurrency: 'USD', monthlyRent: 500 });
      const conf8 = await c.post(`/api/payments/${logged8.body.payment.id}/confirm`, {});
      // With charges open the register refuses a currency change, so a JMD advance cannot be stranded that way here;
      // if it were ever allowed, the confirm must refuse the stranded advance.
      T.check('a villa with open charges cannot be re-denominated under a pending advance, or the confirm refuses it', redenom.status === 400 || conf8.status === 400, `put ${redenom.status}, confirm ${conf8.status}`);
    }

    /* ---- the integrity warning does not fire on the CURRENT tenant's own prepayment (QA) ---- */
    {
      const body = (tenant, over = {}) => ({ number: '9', ownerName: 'Owner', tenantName: tenant, status: tenant ? 'long-term' : 'vacant', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...over });
      await c.put('/api/units/unit-9', body('Old O'));
      await c.post('/api/charges/post-month', { monthString: monthsAhead(0) });
      await receive('unit-9', 'Rent', 50000, { payerName: 'Old O' });
      await c.put('/api/units/unit-9', body('', { tenantChangeIntent: 'moved-out' }));
      const inN = await c.put('/api/units/unit-9', body('New N'));
      const advN = await receive('unit-9', 'Rent', 100000, { payerName: 'New N', advancePayment: true });
      T.check('setup: New N moved in and prepaid 100000', inN.status === 200 && advN.status === 200, `${inN.status} ${advN.status}`);
      const f = (await c.get('/api/integrity')).body.findings.find(x => x.code === 'credit-held-on-a-villa-that-changed-hands');
      T.check('the warning does not name a villa whose credit is the sitting tenant\'s own', !(f?.records || []).some(r => /Villa 9 rent/.test(r)), JSON.stringify(f?.records));
    }
  } finally {
    await srv.stop();
  }
  return T.done();
}
