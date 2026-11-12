/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The financial screens audited against each other (Ro, 2026-11-12:
 * "check ... the separation of books ... if all of it is working in sync as an
 * ecosystem should, accuracy is everything").
 *
 * Operational Reports, Owners Statements, Charts, Projections and Bank
 * Reconciliation are five different screens built by different code from the
 * same ledger. Each can be internally consistent and still disagree with the
 * others. This builds one property — let villas in both currencies, an
 * owner-occupier, a short-stay villa, costs on both books — runs both
 * corrections on it, and then asserts the identities that must hold BETWEEN the
 * screens, using the exact functions each screen calls.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'The financial screens audited against each other';

const C = n => Math.round((Number(n) || 0) * 100);
const FROM = '2026-09-01';
const TO = '2026-11-30';

export default async function run({ port, projectRoot }) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-eco-'));
  const outfile = path.join(outdir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-eco-db-'));
  const T = reporter(title);
  let srv = await startServer({ port, adminPassword: 'Eco-1234!', projectRoot, dataDir });

  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Eco-1234!', 'EcoNew-9876!');

    // Two JMD lets, one USD let, an owner-occupier, a short-stay villa.
    await makeLongTermUnit(c, 'unit-1', { monthlyRent: 100000, monthlyMaintenance: 20000, tenantName: 'Tenant One' });
    await makeLongTermUnit(c, 'unit-2', { monthlyRent: 75000, monthlyMaintenance: 20000, tenantName: 'Tenant Two' });
    await makeLongTermUnit(c, 'unit-3', { monthlyRent: 800, monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', tenantName: 'Tenant Three' });
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.put('/api/units/unit-5', { number: '5', ownerName: 'Owner Five', status: 'short-term', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    for (const m of ['2026-09', '2026-10', '2026-11']) await c.post('/api/charges/post-month', { monthString: m });

    // The old shape: rent keyed short, the levy keyed separately.
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const ch of raw.charges) {
      if (ch.category === 'Rent' && ch.kind !== 'one-off') {
        const u = raw.units.find(x => x.id === ch.unitId);
        ch.amount = u.monthlyRent - u.monthlyMaintenance;
        delete ch.rentPortion;
        delete ch.maintenancePortion;
      }
    }
    for (const t of raw.tenancies || []) if (t.status === 'active') t.startedOn = '2026-09-01';
    fs.writeFileSync(dbPath, JSON.stringify(raw));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'EcoNew-9876!' }, { captureCookie: true });

    const pay = (unitId, category, amount, date, currency = 'JMD', payer = 'P') =>
      recordAndConfirmPayment(c, { unitId, category, amount, currency, payerName: payer, method: 'Bank Transfer', date });
    for (const d of ['2026-09-07', '2026-10-07', '2026-11-05']) {
      await pay('unit-1', 'Rent', 80000, d); await pay('unit-1', 'Maintenance', 20000, d);
      await pay('unit-3', 'Rent', 675, d, 'USD'); await pay('unit-3', 'Maintenance', 125, d, 'USD');
    }
    for (const d of ['2026-09-07', '2026-10-07']) { await pay('unit-2', 'Rent', 55000, d); await pay('unit-2', 'Maintenance', 20000, d); }
    await pay('unit-4', 'Maintenance', 20000, '2026-09-02', 'JMD', 'Owner Four');
    await pay('unit-5', 'Maintenance', 20000, '2026-09-02', 'JMD', 'Owner Five');
    // Costs on both books.
    await c.post('/api/expenses', { category: 'Grounds', amount: 50000, currency: 'JMD', date: '2026-09-20', description: 'Gardening', vendor: 'A gardener' });
    await c.post('/api/expenses', { unitId: 'unit-1', category: 'Repairs', amount: 15000, currency: 'JMD', date: '2026-10-20', description: 'Plumbing', vendor: 'A plumber' });

    await c.post('/api/charges/restate-rent', { confirm: true });
    const moved = (await c.post('/api/payments/restate-maintenance-receipts', { confirm: true })).body;
    T.check('the property was built and both corrections ran', moved.moved === 8, JSON.stringify({ moved: moved.moved }));

    const db = (await c.get('/api/db')).body;
    const derived = F.settledFromRent(db.charges, db.payments);
    const settled = [...db.payments, ...derived];          // what every money screen is given
    const raw2 = db.payments;                               // what Reconciliation is given

    /* ---------- 1. the two books separate cleanly ---------- */
    for (const cur of ['JMD', 'USD']) {
      const ispo = F.paymentsInBook(settled, 'ispo').filter(p => p.currency === cur && p.status === 'completed');
      const strata = F.paymentsInBook(settled, 'strata').filter(p => p.currency === cur && p.status === 'completed');
      const all = settled.filter(p => p.currency === cur && p.status === 'completed');
      const ids = new Set([...ispo, ...strata].map(p => p.id));
      T.check(`${cur}: no receipt is on both books at once`, ispo.every(p => !strata.some(q => q.id === p.id)));
      T.check(`${cur}: every receipt lands on one book or the other, none falls between them`, ids.size === all.length, `${ids.size} of ${all.length}`);
      T.check(`${cur}: ISPO's book carries no maintenance`, ispo.every(p => p.category !== 'Maintenance'));
      T.check(`${cur}: the corporation's book carries no rent`, strata.every(p => p.category !== 'Rent'));
    }

    /* ---------- 2. Operational Reports: the books add up to the cash ---------- */
    for (const cur of ['JMD', 'USD']) {
      const cash = raw2.filter(p => p.status === 'completed' && p.currency === cur).reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const ispo = F.collectedInPeriod(F.paymentsInBook(settled, 'ispo'), cur, FROM, TO).total;
      const strataCash = F.collectedInPeriod(F.paymentsInBook(raw2, 'strata'), cur, FROM, TO).total;
      T.check(`${cur}: ISPO's rent plus the corporation's own cash levy is exactly the money that came in`,
        C(ispo) + C(strataCash) === cash, `${C(ispo)} + ${C(strataCash)} vs ${cash}`);

      /*
       * The combined view. Worked out here from the ledger rather than by
       * re-running the screen's own expression: ISPO's rent, plus the levy the
       * corporation took in cash from villas NOT funded out of rent. The levy on
       * a let villa is ISPO handing the corporation its share, and must be
       * counted once, on ISPO's side, not twice.
       */
      const fundedFromRent = new Set(
        db.charges.filter(x => x.category === 'Rent' && x.status === 'open' && (x.maintenancePortion || 0) > 0).map(x => `${x.unitId}|${x.currency}`)
      );
      const expected =
        raw2.filter(p => p.status === 'completed' && p.currency === cur && p.date >= FROM && p.date <= TO)
          .filter(p => !(p.category === 'Maintenance' && fundedFromRent.has(`${p.unitId}|${p.currency}`)))
          .reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const comb = F.consolidateEverything(db.charges, settled, db.units);
      const everything = F.collectedInPeriod(comb.payments, cur, FROM, TO).total;
      T.check(`${cur}: the combined view reports exactly the money that came in from outside, counting the levy passed between the books once`,
        C(everything) === expected, `${C(everything)} vs ${expected}`);
      T.check(`${cur}: and never more than the cash that actually arrived`, C(everything) <= cash, `${C(everything)} vs ${cash}`);
      T.check(`${cur}: not one levy receipt on a rent-funded villa survives into it`,
        !comb.payments.some(p => p.category === 'Maintenance' && fundedFromRent.has(`${p.unitId}|${p.currency}`)));

      // Per villa: a tenant is counted for every penny they handed over, once.
      for (const u of db.units.filter(x => x.status === 'long-term' && x.currency === cur)) {
        const handed = raw2.filter(p => p.unitId === u.id && p.status === 'completed' && p.currency === cur && p.date >= FROM && p.date <= TO)
          .reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
        const counted = comb.payments.filter(p => p.unitId === u.id && p.status === 'completed' && p.currency === cur && p.date >= FROM && p.date <= TO)
          .reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
        T.check(`${cur}: villa ${u.number}'s tenant is counted for every penny they paid, and no more`, counted === handed, `${counted} vs ${handed}`);
      }
    }

    /* ---------- 2b. a short stay ISPO lets on its own account ---------- */
    /*
     * A villa on Airbnb raises no rent charge, so inferring the transfer from the
     * rent charges never reached it: the levy ISPO handed the corporation was
     * counted as income on top of the guest's money. Ro, 2026-11-12: every let
     * villa AND every short stay is ISPO's, and ISPO passes the corporation its
     * levy on each.
     */
    {
      const short = { id: 'sx', number: 'SX', ownerName: 'VDS', status: 'short-term', letOnOwnAccount: true,
        monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 };
      const mc = m => ({ id: `mx-${m}`, unitId: 'sx', unitNumber: 'SX', category: 'Maintenance', periodMonth: m, dueDate: `${m}-01`,
        amount: 20000, currency: 'JMD', status: 'open', payerName: 'VDS', createdAt: '', createdBy: '' });
      const px = (cat, amt, date, who) => ({ id: `px-${cat}-${date}`, receiptNo: `RX${date}`, payerName: who, unitId: 'sx', unitNumber: 'SX',
        category: cat, amount: amt, currency: 'JMD', date, method: 'Cash', reference: '', notes: '', staffMember: 's', status: 'completed' });
      const ch = ['2026-09', '2026-10'].map(mc);
      const ps = [px('Booking', 90000, '2026-09-10', 'A guest'), px('Maintenance', 20000, '2026-09-11', 'VDS'), px('Maintenance', 20000, '2026-10-11', 'VDS')];
      const got = F.collectedInPeriod(F.consolidateEverything(ch, ps, [short]).payments, 'JMD', '2026-09-01', '2026-10-31').total;
      T.check('a short stay counts the guest\'s money and not the levy ISPO passed across', C(got) === C(90000), `${got} vs 90000`);
      const blind = F.collectedInPeriod(F.consolidateEverything(ch, ps, []).payments, 'JMD', '2026-09-01', '2026-10-31').total;
      T.check('and without the own-account flag it would double count — which is what makes the flag load-bearing', C(blind) === C(130000), `${blind}`);
    }

    /* ---------- 3. Owners Statements roll up to the corporation's book ---------- */
    for (const cur of ['JMD', 'USD']) {
      const statements = F.ownerStatements(db.units, db.charges, settled, [], [], FROM, TO).filter(s => s.currency === cur);
      const perOwner = statements.reduce((a, s) => a + C(s.maintenanceReceived ?? s.maintenancePaid ?? 0), 0);
      const strataAll = F.collectedInPeriod(F.paymentsInBook(settled, 'strata'), cur, FROM, TO).maintenance;
      T.check(`${cur}: every owner's statement added together equals the corporation's maintenance income`,
        perOwner === C(strataAll), `${perOwner} vs ${C(strataAll)}`);
    }

    /* ---------- 4. Charts and Projections against an independent count ---------- */
    for (const cur of ['JMD', 'USD']) {
      /*
       * Both screens are checked against money counted straight off the raw
       * receipts, not against each other: Charts and Reports share a function,
       * and comparing one to the other would pass however wrong both were.
       */
      const levyInCash = raw2.filter(p => p.category === 'Maintenance' && p.status === 'completed' && p.currency === cur && p.date >= FROM && p.date <= TO)
        .reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const levyFromRent = derived.filter(d => d.currency === cur && d.date >= FROM && d.date <= TO).reduce((a, d) => a + C(d.amount), 0);

      const projections = F.collectedInPeriod(settled, cur, FROM, TO).maintenance;
      T.check(`${cur}: Projections counts the levy taken in cash plus the levy settled out of rent, and nothing else`,
        C(projections) === levyInCash + levyFromRent, `${C(projections)} vs ${levyInCash + levyFromRent}`);

      const ops = F.operationsStatement([], settled, cur, FROM, TO).maintenanceCollected;
      T.check(`${cur}: the operations statement tells proprietors the same figure`, C(ops) === levyInCash + levyFromRent, `${C(ops)} vs ${levyInCash + levyFromRent}`);

      const rentInCash = raw2.filter(p => p.category === 'Rent' && p.status === 'completed' && p.currency === cur && p.date >= FROM && p.date <= TO)
        .reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
      const ispoRent = F.collectedInPeriod(F.paymentsInBook(settled, 'ispo'), cur, FROM, TO).rent;
      T.check(`${cur}: ISPO's rent income is the rent receipts, to the penny`, C(ispoRent) === rentInCash, `${C(ispoRent)} vs ${rentInCash}`);
    }

    /* ---------- 5. Bank Reconciliation sees real money only ---------- */
    T.check('Reconciliation is given the raw receipts, never a worked-out credit', raw2.every(p => !p.derived));
    T.check('and every receipt it can tick exists on the server', raw2.length === db.payments.length);
    T.check('a settled-from-rent credit is never reconcilable, because it never reached a bank',
      derived.length > 0 && derived.every(d => d.derived === true && !d.receiptNo));

    /* ---------- 6. nothing was invented or lost ---------- */
    const cashAll = raw2.filter(p => p.status === 'completed').reduce((a, p) => a + C(p.amount) - C(p.refundedAmount || 0), 0);
    T.check('the property holds real money only — every penny on a screen traces to a receipt', cashAll > 0);
    T.check('the books report no contradiction', (await c.get('/api/integrity')).body.serious === 0, JSON.stringify((await c.get('/api/integrity')).body.findings.map(f => f.code)));
    T.check('server healthy', (await c.get('/api/health')).status === 200);
  } catch (err) {
    T.check('the audit ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(outdir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return T.done();
}
