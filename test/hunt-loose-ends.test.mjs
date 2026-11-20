/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Three figures the 2026-11-19 hunt found that no report stated honestly.
 *
 *   1. Owner statements: ISPO's USD guest income on a short-let villa made an
 *      all-$0 USD statement, "18 statements" for 16 villas. A statement is
 *      produced only for what it shows: levy, utilities, villa costs.
 *   2. Deposits held: J$170,000 held appeared in no report total, and a former
 *      tenant gone owing J$90,000 with J$90,000 of deposit held was never paired
 *      with it. The observations now total the deposits held and name the part
 *      that can meet a former tenant's debt.
 *   3. The combined book leaves out ISPO's own unpaid levy (ISPO owing itself);
 *      the Dashboard counts it. Both now name it, and the two agree on the sum.
 *
 * Pure: bundled source, no server. Each rule has a positive control.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Owner statements, deposits held and ISPO’s own levy are stated where they belong';

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-loose-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: { contents: `export * as obs from './src/lib/observations'; export * as fin from './src/lib/finance';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const FROM = '2026-10-01';
const TO = '2026-10-31';
const unit = (n, over = {}) => ({
  id: `u${n}`, number: String(n), ownerName: 'ISPO', ownerEmail: '', ownerPhone: '', tenantName: '', tenantEmail: '', tenantPhone: '',
  status: 'vacant', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '',
  rentDueDay: 1, maintDueDay: 1, ...over
});
const charge = (u, category, amount, over = {}) => ({
  id: `c-${u.id}-${category}-${over.periodMonth || '2026-10'}`, unitId: u.id, unitNumber: u.number, category, periodMonth: '2026-10',
  dueDate: '2026-10-01', amount, currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency, status: 'open',
  payerName: category === 'Rent' ? u.tenantName : u.ownerName, createdAt: '2026-10-01T00:00:00Z', createdBy: 'test', ...over
});
let n = 0;
const pay = (u, category, amount, over = {}) => ({
  id: `p${++n}`, receiptNo: `R${n}`, payerName: 'x', unitId: u.id, unitNumber: u.number, category, amount,
  currency: category === 'Maintenance' ? u.maintCurrency || u.currency : u.currency, date: '2026-10-05', method: 'Bank Transfer',
  reference: '', notes: '', staffMember: 'test', status: 'completed', ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await load(projectRoot);
  const { obs, fin } = mod;
  try {
    /* ---------------- 1. owner statements ---------------- */
    const shortLet = unit(1, { status: 'short-term', currency: 'USD', maintCurrency: 'JMD' });
    const proprietor = unit(2, { status: 'owner-occupied', ownerName: 'A Proprietor', currency: 'USD', maintCurrency: 'USD', monthlyMaintenance: 125 });
    const units = [shortLet, proprietor];
    const charges = [charge(shortLet, 'Maintenance', 20000), charge(proprietor, 'Maintenance', 125)];
    const payments = [
      pay(shortLet, 'Maintenance', 20000),
      pay(shortLet, 'Booking', 450, { currency: 'USD' }),
      pay(proprietor, 'Maintenance', 125)
    ];
    const st = fin.ownerStatements(units, charges, payments, [], [], FROM, TO);
    const key = s => `${s.unit.number} ${s.currency}`;
    T.check('a short-let villa whose USD money was guest income has no USD owner statement', !st.some(s => key(s) === '1 USD'), st.map(key).join(', '));
    T.check('control: its JMD levy statement is produced', st.some(s => key(s) === '1 JMD'), st.map(key).join(', '));
    T.check('control: a proprietor’s USD levy statement is produced', st.some(s => key(s) === '2 USD'), st.map(key).join(', '));
    const util = [{ id: 'r1', unitId: shortLet.id, unitNumber: '1', billingPeriod: '2026-10', currency: 'USD', amountCharged: 60, utilityType: 'Electricity' }];
    const withUtil = fin.ownerStatements(units, charges, payments, [], util, FROM, TO);
    T.check('control: a USD utility billed to it does make a USD statement, because the statement shows it', withUtil.some(s => key(s) === '1 USD'), withUtil.map(key).join(', '));

    /* ---------------- 2. deposits held ---------------- */
    const b10 = unit(10, { status: 'vacant', tenantName: '' });
    const a5 = unit(5, { status: 'long-term', tenantName: 'Still Here', monthlyRent: 80000 });
    const gone = {
      id: 't-b10', unitId: b10.id, unitNumber: '10', tenantName: 'Gone Owing', monthlyRent: 90000, currency: 'JMD', rentDueDay: 1,
      startedOn: '2026-01-01', endedOn: '2026-10-15', status: 'ended', depositAmount: 90000, depositCurrency: 'JMD', depositReceivedOn: '2026-01-01'
    };
    const stay = { id: 't-a5', unitId: a5.id, unitNumber: '5', tenantName: 'Still Here', monthlyRent: 80000, currency: 'JMD', rentDueDay: 1, startedOn: '2026-01-01', status: 'active', depositAmount: 80000, depositCurrency: 'JMD', depositReceivedOn: '2026-01-02' };
    const returned = { id: 't-old', unitId: a5.id, unitNumber: '5', tenantName: 'Returned Ok', monthlyRent: 70000, currency: 'JMD', rentDueDay: 1, startedOn: '2025-01-01', endedOn: '2025-12-31', status: 'ended', depositAmount: 70000, depositCurrency: 'JMD', depositReceivedOn: '2025-01-01', depositReturnedOn: '2026-01-05', depositReturnedAmount: 70000 };
    const dUnits = [b10, a5];
    const dCharges = [
      charge(b10, 'Rent', 90000, { payerName: 'Gone Owing' }),
      charge(a5, 'Rent', 80000, { payerName: 'Still Here' })
    ];
    const dPayments = [pay(a5, 'Rent', 80000)];
    const input = book => ({ units: dUnits, tenancies: [gone, stay, returned], bookings: [], charges: dCharges, payments: dPayments, expenses: [], utilities: [], currency: 'JMD', from: FROM, to: TO, book });
    const list = obs.observationsFor(input('ispo'));
    const held = list.find(o => /of deposits held at/.test(o.text));
    T.check('the deposits held are totalled: J$170,000, the returned one left out', !!held && /J\$170,000/.test(held.text), held?.text);
    T.check('and the part that can meet a former tenant’s rent is named', !!held && /J\$90,000(\.00)? of it can meet rent owed by former tenants/.test(held.text), held?.text);
    T.check('each deposit is listed with whose it is', !!held && held.details.some(d => /Gone Owing.*J\$90,000.*owing J\$90,000(\.00)? rent, deposit not settled/.test(d)) && held.details.some(d => /Still Here.*J\$80,000/.test(d)), JSON.stringify(held?.details));
    const owed = list.find(o => o.rank === obs.SUMMARY && /is owed at/.test(o.text));
    T.check('the owed summary says how much of it the deposits can meet', !!owed && /J\$90,000(\.00)? of it can be met from deposits held/.test(owed.text), owed?.text);
    const leak = list.find(o => o.rank === obs.SUMMARY && /where money leaked/.test(o.text));
    T.check('and the unsettled deposit is a next step: withhold it against the rent', !!leak && leak.details.some(d => /Gone Owing.*Withhold J\$90,000/.test(d)), JSON.stringify(leak?.details));
    const strata = obs.observationsFor(input('strata'));
    T.check('control: the corporation’s book states no tenancy deposits, which are ISPO’s', !strata.some(o => /deposits held/.test(o.text)));

    /* ---------------- 3. ISPO’s own levy, combined vs Dashboard ---------------- */
    const vacant = unit(7);
    const owner = unit(8, { status: 'owner-occupied', ownerName: 'A Proprietor' });
    const cUnits = [vacant, owner];
    const cCharges = [charge(vacant, 'Maintenance', 20000), charge(owner, 'Maintenance', 20000)];
    const cInput = book => ({ units: cUnits, tenancies: [], bookings: [], charges: cCharges, payments: [], expenses: [], utilities: [], currency: 'JMD', from: FROM, to: TO, book });
    const dash = fin.ownLevyArrears(fin.delinquentAccounts(cUnits, cCharges, [], TO));
    T.check('the Dashboard’s own-levy figure is ISPO’s vacant villa only', dash.length === 1 && dash[0].unit.id === vacant.id && dash[0].balance === 20000, JSON.stringify(dash.map(a => [a.unit.number, a.balance])));
    const comb = obs.observationsFor(cInput('everything')).find(o => /own levy is unpaid/.test(o.text));
    T.check('the combined report names the same J$20,000 and why the Dashboard reads higher', !!comb && /J\$20,000/.test(comb.text) && /Dashboard's arrears read J\$20,000(\.00)? higher/.test(comb.text), comb?.text);
    T.check('control: the corporation’s own book does not call it eliminated, because there it is owed', !obs.observationsFor(cInput('strata')).some(o => /own levy is unpaid/.test(o.text)));
  } finally {
    cleanup();
  }
  return T.done();
}
