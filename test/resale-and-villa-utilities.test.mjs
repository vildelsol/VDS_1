/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two owner rules (2026-11-21).
 *
 *  RULE 1. On a villa that changed hands a maintenance payment pays only the payer's OWN levy. The ledger used to
 *  allocate payments oldest-first across the whole villa, so a buyer's payment cleared the seller's older arrears.
 *  A villa that never changed hands allocates exactly as before.
 *
 *  RULE 2. A utility bill tied to a villa is that villa owner's own cost ("similar to how all owners pay their own
 *  utility bills"). The documents to proprietors (Operations Statement, Monthly Report to Proprietors, Annual
 *  Report) leave it, and its recovery rows, out of the COMMON costs; a utility tied to no villa stays common.
 *
 * Like the other money suites this bundles the real src/lib modules rather than re-implementing them. Every guard
 * has a positive control. Money text has dots ("J$90,000.00"), so nothing here matches with [^.]* across it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Resale payments stay with the payer; villa utilities are the villa owner\'s own cost';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-resale-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as fin from './src/lib/finance';
        export * as obs from './src/lib/observations';
      `,
      resolveDir: projectRoot,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* ---------------- hand-built records ---------------- */

const unit = (id, number, over = {}) => ({
  id,
  number,
  ownerName: `Owner ${number}`,
  ownerEmail: '',
  ownerPhone: '',
  tenantName: '',
  tenantEmail: '',
  tenantPhone: '',
  status: 'owner-occupied',
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});
const levy = (u, month, amount = 20000, payerName) => ({
  id: `ch-${u.id}-${month}`,
  unitId: u.id,
  unitNumber: u.number,
  category: 'Maintenance',
  amount,
  currency: 'JMD',
  dueDate: `${month}-01`,
  periodMonth: month,
  status: 'open',
  payerName: payerName || u.ownerName,
  description: 'levy'
});
const pay = (id, u, category, amount, date, payerName = 'Someone', extra = {}) => ({
  id,
  receiptNo: `REC-${id}`,
  payerName,
  unitId: u.id,
  unitNumber: u.number,
  category,
  amount,
  currency: 'JMD',
  date,
  method: 'Cash',
  reference: '',
  notes: '',
  staffMember: 'x',
  status: 'completed',
  ...extra
});
const own = (id, u, name, startedOn, endedOn) => ({
  id,
  unitId: u.id,
  unitNumber: u.number,
  ownerName: name,
  ownerEmail: '',
  ownerPhone: '',
  startedOn,
  ...(endedOn ? { endedOn, status: 'ended' } : { status: 'active' }),
  recordedBy: 'x',
  recordedAt: `2020-01-01T00:00:0${id.length % 10}Z`
});
const cost = (id, over = {}) => ({
  id,
  category: 'Maintenance',
  vendor: `Vendor ${id}`,
  description: `Cost ${id}`,
  unitId: '',
  unitNumber: 'General',
  amount: 1000,
  currency: 'JMD',
  date: '2026-03-05',
  datePaid: '2026-03-05',
  status: 'paid',
  reference: '',
  notes: '',
  ...over
});

const ids = list => list.map(c => c.periodMonth).join(',');

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, obs } = mod;
  try {
    /* ================================================================
     * RULE 1. A payment pays the payer's own levy
     * ================================================================ */
    const V = unit('v1', 'V1', { ownerName: 'Buyer Brown' });
    const records = [own('o-v1-1', V, 'Sally Seller', '', '2026-06-01'), own('o-v1-2', V, 'Buyer Brown', '2026-06-01')];
    const charges = ['2026-03', '2026-04', '2026-05'].map(m => levy(V, m, 20000, 'Sally Seller')).concat(['2026-06', '2026-07'].map(m => levy(V, m, 20000, 'Buyer Brown')));
    const AS_OF = '2026-07-31';
    const bal = (payments, ownerships = records) => fin.accountBalance(V, 'Maintenance', charges, payments, AS_OF, [V], ownerships);

    // The new owner pays the month they bought in.
    const buyerPays = [pay('p1', V, 'Maintenance', 20000, '2026-06-05', 'Buyer Brown')];
    const a = bal(buyerPays);
    T.check('RULE 1: the buyer\'s payment settles the buyer\'s own June levy', a.byOwner?.find(s => s.owner.ownerName === 'Buyer Brown')?.coverage['ch-v1-2026-06'] === 20000, JSON.stringify(a.byOwner?.map(s => [s.owner.ownerName, s.owed, s.credit])));
    T.check('RULE 1: the seller\'s March, April and May stay unpaid (the buyer\'s money never clears them); the buyer\'s July is owed', ids(a.unpaidCharges) === '2026-03,2026-04,2026-05,2026-07', ids(a.unpaidCharges));
    T.check('RULE 1: the villa owes 60,000 (seller) + 20,000 (buyer) = 80,000 and nobody is relieved', a.balance === 80000 && a.status === 'in-arrears', `${a.balance} ${a.status}`);
    T.check('RULE 1: the oldest unpaid charge is the seller\'s March, so ageing is measured from it', a.oldestUnpaidDays === 152, String(a.oldestUnpaidDays));
    const withoutHistory = bal(buyerPays, []);
    T.check('control: with no ownership history the old oldest-first allocation holds (the same payment clears March)', ids(withoutHistory.unpaidCharges) === '2026-04,2026-05,2026-06,2026-07' && withoutHistory.balance === 80000, ids(withoutHistory.unpaidCharges));
    const oneRecord = bal(buyerPays, [records[1]]);
    T.check('control: a single ownership record (no change of hands) allocates oldest-first as before', ids(oneRecord.unpaidCharges) === '2026-04,2026-05,2026-06,2026-07' && !oneRecord.byOwner);

    // The seller pays after the sale, under their own name (spelling and spacing differ).
    const sellerPaysLate = buyerPays.concat([pay('p2', V, 'Maintenance', 20000, '2026-07-10', '  SALLY   seller ')]);
    const b = bal(sellerPaysLate);
    T.check('RULE 1: a payment by the former owner after the sale settles THEIR oldest levy (March), not the buyer\'s July', ids(b.unpaidCharges) === '2026-04,2026-05,2026-07' && b.balance === 60000, `${ids(b.unpaidCharges)} ${b.balance}`);
    // An agent paying for the seller before the sale: the payment is dated in the seller's period.
    const inSellersTime = [pay('p3', V, 'Maintenance', 20000, '2026-05-20', 'Island Property Agents')];
    const c = bal(inSellersTime);
    T.check('RULE 1: a payment dated in the seller\'s time settles the seller\'s levy even from a third-party payer', c.byOwner.find(s => s.owner.ownerName === 'Sally Seller').paid === 20000 && ids(c.unpaidCharges) === '2026-04,2026-05,2026-06,2026-07', ids(c.unpaidCharges));
    // The buyer overpays: surplus is the buyer's own credit; it never touches the seller's arrears.
    const buyerOverpays = [pay('p4', V, 'Maintenance', 70000, '2026-06-05', 'Buyer Brown')];
    const d = bal(buyerOverpays);
    const buyerShare = d.byOwner.find(s => s.owner.ownerName === 'Buyer Brown');
    T.check('RULE 1: a surplus is credit for the payer\'s own later charges (buyer: 40,000 of levy, 30,000 over)', buyerShare.owed === 0 && buyerShare.credit === 30000, `${buyerShare.owed} ${buyerShare.credit}`);
    T.check('RULE 1: and the seller\'s 60,000 is still owed whatever the buyer overpaid', d.balance === 60000 && ids(d.unpaidCharges) === '2026-03,2026-04,2026-05', `${d.balance} ${ids(d.unpaidCharges)}`);
    T.check('RULE 1: the buyer\'s credit is held, not lost: once the seller has cleared, the villa reads in credit 30,000', bal(buyerOverpays.concat([pay('p5', V, 'Maintenance', 60000, '2026-07-12', 'Sally Seller')])).balance === -30000);

    // Refunds net as at the date asked.
    const refunded = [pay('p6', V, 'Maintenance', 20000, '2026-06-05', 'Buyer Brown', { refundedAmount: 20000, refundedOn: '2026-07-20' })];
    T.check('RULE 1: a refunded buyer payment puts the buyer back into arrears for June', ids(bal(refunded).unpaidCharges) === '2026-03,2026-04,2026-05,2026-06,2026-07');

    // Every screen's helpers follow, through the one registry the client sets from each snapshot.
    fin.setOwnershipRegistry(records);
    const viaRegistry = fin.accountBalance(V, 'Maintenance', charges, buyerPays, AS_OF, [V]);
    T.check('RULE 1: screens that pass no ownership list read it from the registry and get the same allocation', ids(viaRegistry.unpaidCharges) === '2026-03,2026-04,2026-05,2026-07');
    const delinquent = fin.delinquentAccounts([V], charges, buyerPays, AS_OF);
    T.check('RULE 1: the Dashboard/notifications arrears list shows the villa at 80,000 with the seller\'s March as the oldest', delinquent.length === 1 && delinquent[0].balance === 80000 && delinquent[0].unpaidCharges[0].periodMonth === '2026-03', JSON.stringify(delinquent.map(x => [x.balance, x.unpaidCharges.map(c => c.periodMonth)])));
    const ageing = fin.ageAccountArrears(V, 'Maintenance', charges, buyerPays, AS_OF, [V]);
    T.check('RULE 1: Form 13B ageing totals the same 80,000 and ages the seller\'s three months (over 90 days: 60,000)', ageing.buckets.total === 80000 && ageing.buckets.over90 === 60000, JSON.stringify(ageing.buckets));
    const ownedBefore = fin.accountBalance(V, 'Maintenance', charges, buyerPays, '2026-05-31', [V]);
    T.check('RULE 1: as at a date before the sale nothing changes (the buyer had not paid yet; seller owes 60,000)', ownedBefore.balance === 60000);

    const owing = obs.accountsOwing({ units: [V], tenancies: [], bookings: [], charges, payments: buyerPays, expenses: [], currency: 'JMD', from: '2026-07-01', to: AS_OF, book: 'strata' });
    const owingRow = owing.find(x => x.unit.id === 'v1');
    T.check('RULE 1: the observations "who owes" list names the same 80,000, charge by charge (March 20,000 ... July 20,000)', !!owingRow && owingRow.balance === 80000 && owingRow.unpaid.map(u => u.unpaid).join(',') === '20000,20000,20000,20000', JSON.stringify(owingRow && [owingRow.balance, owingRow.unpaid.map(u => [u.charge.periodMonth, u.unpaid])]));
    // Uneven amounts: the buyer part-pays, so a part-paid charge exists on BOTH sides of the sale.
    const uneven = [levy(V, '2026-03', 30000, 'Sally Seller'), levy(V, '2026-04', 20000, 'Sally Seller'), levy(V, '2026-06', 20000, 'Buyer Brown')];
    const unevenPays = [pay('u1', V, 'Maintenance', 12000, '2026-06-05', 'Buyer Brown'), pay('u2', V, 'Maintenance', 5000, '2026-04-10', 'Sally Seller')];
    const owingUneven = obs.accountsOwing({ units: [V], tenancies: [], bookings: [], charges: uneven, payments: unevenPays, expenses: [], currency: 'JMD', from: '2026-03-01', to: AS_OF, book: 'strata' }).find(x => x.unit.id === 'v1');
    T.check('RULE 1: "who owes" carries each part-paid charge\'s own remainder (seller\'s March 25,000 after their 5,000; April 20,000; buyer\'s June 8,000)', owingUneven?.balance === 53000 && owingUneven.unpaid.map(u => `${u.charge.periodMonth}:${u.unpaid}`).join(',') === '2026-03:25000,2026-04:20000,2026-06:8000', JSON.stringify(owingUneven && owingUneven.unpaid.map(u => [u.charge.periodMonth, u.unpaid])));
    fin.setOwnershipRegistry([]);

    // Owner statements agree with the account.
    const stmts = fin.ownerStatements([V], charges, buyerPays, [], [], '2026-06-01', '2026-07-31', records);
    const buyerStmt = stmts.find(s => s.unit.ownerName === 'Buyer Brown' && s.currency === 'JMD');
    const sellerStmt = stmts.find(s => s.unit.ownerName === 'Sally Seller' && s.currency === 'JMD');
    T.check('RULE 1: the buyer\'s statement shows only their own position: June paid, July owed 20,000', buyerStmt?.maintenanceOutstanding === 20000 && buyerStmt.maintenanceBilled === 40000 && buyerStmt.maintenancePaid === 20000, JSON.stringify(buyerStmt && [buyerStmt.maintenanceOutstanding, buyerStmt.maintenanceBilled, buyerStmt.maintenancePaid]));
    T.check('RULE 1: the seller\'s statement still owes their 60,000 (the buyer\'s payment did not clear it)', sellerStmt?.maintenanceOutstanding === 60000, String(sellerStmt?.maintenanceOutstanding));
    T.check('RULE 1: the statements add up to the account balance (60,000 + 20,000 = 80,000)', (buyerStmt?.maintenanceOutstanding || 0) + (sellerStmt?.maintenanceOutstanding || 0) === a.balance);
    const legacyStmts = fin.ownerStatements([V], charges, buyerPays, [], [], '2026-06-01', '2026-07-31');
    T.check('control: the same statements run with no history are one statement for the villa (the old behaviour)', legacyStmts.filter(s => s.unit.number === 'V1' && s.currency === 'JMD').length === 1);

    // A villa that never changed hands: exactly as before, proven by an independent reference allocation.
    const W = unit('w1', 'W1');
    const wCharges = ['2026-01', '2026-02', '2026-03', '2026-04'].map(m => levy(W, m));
    const wPays = [pay('w-a', W, 'Maintenance', 15000, '2026-02-03', 'Owner W1'), pay('w-b', W, 'Maintenance', 30000, '2026-04-02', 'A stranger')];
    const reference = (() => {
      let credit = wPays.reduce((s, p) => s + p.amount, 0);
      const unpaid = [];
      for (const ch of wCharges) {
        if (credit >= ch.amount) credit -= ch.amount;
        else {
          unpaid.push(ch.periodMonth);
          credit = 0;
        }
      }
      return unpaid.join(',');
    })();
    fin.setOwnershipRegistry(records); // another villa's history is in the registry, W1 has none
    const w1 = fin.accountBalance(W, 'Maintenance', wCharges, wPays, '2026-04-30', [W, V]);
    fin.setOwnershipRegistry([]);
    const w0 = fin.accountBalance(W, 'Maintenance', wCharges, wPays, '2026-04-30', [W, V]);
    T.check('control: a villa that never changed hands allocates EXACTLY as before (same as the independent oldest-first reference)', ids(w1.unpaidCharges) === reference && ids(w0.unpaidCharges) === reference && w1.balance === 35000 && !w1.byOwner, `${ids(w1.unpaidCharges)} vs ${reference}`);
    T.check('control: and the result is deeply identical with another villa\'s history registered and without', JSON.stringify(w1) === JSON.stringify(w0));
    const singlePay = fin.accountBalance(W, 'Maintenance', wCharges, wPays, '2026-04-30', [W], [own('o-w-1', W, 'Owner W1', '')]);
    T.check('control: a villa with one ownership record is identical too', JSON.stringify(singlePay) === JSON.stringify(w0));

    // Rent is the tenant's, never split by owner.
    const rentU = unit('r1', 'R1', { status: 'long-term', monthlyRent: 50000 });
    const rentCharge = { ...levy(rentU, '2026-03', 50000), category: 'Rent', description: 'rent' };
    const rentRecords = [own('o-r1-1', rentU, 'Old Landlord', '', '2026-04-01'), own('o-r1-2', rentU, 'New Landlord', '2026-04-01')];
    const rentA = fin.accountBalance(rentU, 'Rent', [rentCharge], [pay('r-a', rentU, 'Rent', 50000, '2026-04-05', 'The Tenant', { category: 'Rent' })], '2026-04-30', [rentU], rentRecords);
    T.check('control: a Rent account is the tenant\'s and is allocated as always whoever owns the villa', rentA.balance === 0 && !rentA.byOwner);

    // settledFromRent: the levy inside the rent is settled by the proprietor's own cash first.
    const L = unit('l1', 'L1', { status: 'long-term', monthlyRent: 100000, ownerName: 'Buyer Brown' });
    const lRecords = [own('o-l1-1', L, 'Sally Seller', '', '2026-06-01'), own('o-l1-2', L, 'Buyer Brown', '2026-06-01')];
    const lCharges = [
      levy(L, '2026-03', 20000, 'Sally Seller'),
      levy(L, '2026-06', 20000, 'Buyer Brown'),
      { ...levy(L, '2026-06', 100000, 'The Tenant'), id: 'rent-l1-06', category: 'Rent', maintenancePortion: 20000, description: 'rent' }
    ];
    const lPayments = [pay('l-cash', L, 'Maintenance', 20000, '2026-06-03', 'Buyer Brown'), pay('l-rent', L, 'Rent', 100000, '2026-06-05', 'The Tenant')];
    const derivedNew = fin.settledFromRent(lCharges, lPayments, '2026-06-30', lRecords);
    const derivedOld = fin.settledFromRent(lCharges, lPayments, '2026-06-30', []);
    T.check('RULE 1: settledFromRent - the buyer\'s own cash already paid the buyer\'s June levy, so the rent adds no second credit for it', derivedNew.length === 0, JSON.stringify(derivedNew.map(x => x.amount)));
    T.check('control: with no history the same cash goes to the seller\'s March first and the rent then settles June (20,000 credit)', derivedOld.length === 1 && derivedOld[0].amount === 20000, JSON.stringify(derivedOld.map(x => x.amount)));
    const noHandsDerived = fin.settledFromRent(lCharges, lPayments, '2026-06-30', [lRecords[1]]);
    T.check('control: one ownership record behaves as no history', JSON.stringify(noHandsDerived) === JSON.stringify(derivedOld));
    // A rent receipt that arrives AFTER the sale for a month before it pays the seller's levy, not the buyer's.
    const lateCharges = [
      levy(L, '2026-05', 20000, 'Sally Seller'),
      levy(L, '2026-06', 20000, 'Buyer Brown'),
      { ...levy(L, '2026-05', 100000, 'The Tenant'), id: 'rent-l1-05', category: 'Rent', maintenancePortion: 20000, description: 'rent' }
    ];
    const lateDerived = fin.settledFromRent(lateCharges, [pay('l-late', L, 'Rent', 100000, '2026-06-10', 'The Tenant')], '2026-06-30', lRecords);
    const lateBal = fin.accountBalance(L, 'Maintenance', lateCharges, [pay('l-late', L, 'Rent', 100000, '2026-06-10', 'The Tenant')].concat(lateDerived), '2026-06-30', [L], lRecords);
    T.check('RULE 1: May\'s rent paid in June after the sale settles the SELLER\'s May levy (the credit carries the levy\'s due day)', lateDerived.length === 1 && lateDerived[0].settlesDueDate === '2026-05-01' && lateBal.byOwner.find(s => s.owner.ownerName === 'Sally Seller').owed === 0 && lateBal.byOwner.find(s => s.owner.ownerName === 'Buyer Brown').owed === 20000, JSON.stringify(lateBal.byOwner.map(s => [s.owner.ownerName, s.owed])));

    // Collection rate follows the same allocation.
    fin.setOwnershipRegistry(records);
    const rate = fin.settledOfBilled(charges, buyerPays, 'JMD', '2026-06-01', '2026-06-30', '2026-07-31', 'Maintenance');
    const rateBefore = fin.settledOfBilled(charges, buyerPays, 'JMD', '2026-03-01', '2026-05-31', '2026-07-31', 'Maintenance');
    T.check('RULE 1: the collection rate counts the buyer\'s payment against June (100%) and leaves the seller\'s Mar-May at 0%', rate.settled === 20000 && rate.billed === 20000 && rateBefore.settled === 0 && rateBefore.billed === 60000, JSON.stringify([rate, rateBefore]));
    fin.setOwnershipRegistry([]);
    const rateOld = fin.settledOfBilled(charges, buyerPays, 'JMD', '2026-03-01', '2026-05-31', '2026-07-31', 'Maintenance');
    T.check('control: without the history the same payment clears March (old behaviour), so the history is what moved it', rateOld.settled === 20000);

    /* ================================================================
     * RULE 2. A villa's utility bill is that owner's own cost
     * ================================================================ */
    const B1 = unit('b1', 'B1', { ownerName: 'Bea One' });
    const march = [pay('m1', B1, 'Maintenance', 20000, '2026-03-10', 'Bea One'), pay('m2', B1, 'Utility', 6000, '2026-03-12', 'Bea One')];
    const commonUtility = cost('u-common', { category: 'Utilities', amount: 10000, datePaid: '2026-03-08', date: '2026-03-08' });
    const villaUtility = cost('u-villa', { category: 'Utilities', amount: 8000, unitId: 'b1', unitNumber: 'B1', datePaid: '2026-03-09', date: '2026-03-09' });
    const repair = cost('r-1', { amount: 40000, datePaid: '2026-03-06', date: '2026-03-06' });
    const costs = [repair, commonUtility, villaUtility];
    const ops = fin.operationsStatement(costs, march, 'JMD', '2026-03-01', '2026-03-31');
    const mon = fin.monthlyOwnersReport([B1], [], march, costs, 'JMD', '2026-03');
    const util = ops.groups.find(g => g.category === 'Utilities');
    T.check('RULE 2: the Operations Statement counts the common-area utility and the repair, not the villa-tied utility or its recovery (40,000 + 10,000)', ops.costsPaid === 50000 && util?.lines.length === 1 && util.lines[0].id === 'u-common', `${ops.costsPaid} ${JSON.stringify(util)}`);
    T.check('RULE 2: the villa-tied utility bill is shown only in the villa memo (8,000 over 1 item), and no villa is named', ops.villaRecharged === 8000 && ops.villaRechargedCount === 1 && !JSON.stringify(ops).includes('B1'), `${ops.villaRecharged}/${ops.villaRechargedCount}`);
    T.check('RULE 2: the Monthly Report agrees with the Operations Statement: the same 50,000 of common costs', mon.costsPaid === 50000 && ops.costsPaid === mon.costsPaid && ops.surplus === mon.surplus, `${ops.costsPaid} vs ${mon.costsPaid}; ${ops.surplus} vs ${mon.surplus}`);
    T.check('RULE 2: the Monthly Report\'s Utilities line is the common utility alone', mon.categories.find(x => /Utilit/i.test(x.label))?.total === 10000, JSON.stringify(mon.categories));
    const monNote = fin.individualVillasNote(mon);
    T.check('RULE 2: the individual-villas note counts no utility, and says villa utilities are the owner\'s own cost', monNote === null, String(monNote));
    // A repair on a villa is still the corporation's spend and still noted, as before.
    const villaRepair = cost('r-v', { amount: 5000, unitId: 'b1', unitNumber: 'B1', datePaid: '2026-03-15', date: '2026-03-15' });
    const monRepair = fin.monthlyOwnersReport([B1], [], march, costs.concat([villaRepair]), 'JMD', '2026-03');
    const noteRepair = fin.individualVillasNote(monRepair);
    T.check('control: a repair done on a villa is still counted and noted (5,000 across 1 item), with the utility wording beside it', monRepair.costsPaid === 55000 && /J\$5,000\.00 across 1 item was spent on individual villas/.test(noteRepair || '') && /utility bills tied to a villa are that villa owner's own cost/i.test(noteRepair || ''), String(noteRepair));
    // Positive control: a utility tied to no villa is a common cost, in both documents, and the recovery alone changes nothing.
    const onlyCommon = fin.operationsStatement([commonUtility], [], 'JMD', '2026-03-01', '2026-03-31');
    const onlyCommonMon = fin.monthlyOwnersReport([B1], [], [], [commonUtility], 'JMD', '2026-03');
    T.check('control: a common-area utility still counts, in both documents (10,000)', onlyCommon.costsPaid === 10000 && onlyCommonMon.costsPaid === 10000);
    const withRecoveryOnly = fin.operationsStatement([commonUtility], march, 'JMD', '2026-03-01', '2026-03-31');
    T.check('RULE 2: a recovery from a villa is the villa owner\'s side of the books and does not net the common utility (still 10,000)', withRecoveryOnly.costsPaid === 10000);
    // Pending villa utility is not a common unpaid cost either.
    const pendingVilla = cost('u-pend', { category: 'Utilities', amount: 3000, unitId: 'b1', unitNumber: 'B1', status: 'pending', dueDate: '2026-03-20', date: '2026-03-20', datePaid: '' });
    const pendingCommon = cost('u-pend2', { category: 'Utilities', amount: 2000, status: 'pending', dueDate: '2026-03-21', date: '2026-03-21', datePaid: '' });
    const opsPending = fin.operationsStatement([pendingVilla, pendingCommon], [], 'JMD', '2026-03-01', '2026-03-31');
    const monPending = fin.monthlyOwnersReport([B1], [], [], [pendingVilla, pendingCommon], 'JMD', '2026-03');
    T.check('RULE 2: an unpaid villa utility is not an unpaid common cost; an unpaid common utility is (2,000 in both)', opsPending.costsUnpaid === 2000 && monPending.unpaidAtMonthEnd === 2000, `${opsPending.costsUnpaid} vs ${monPending.unpaidAtMonthEnd}`);
    // The strata Operating Statement (the corporation's own cash record) still carries the villa utility and its recovery,
    // so it ties to the bank; the Monthly Report differs from it by exactly the villa utilities.
    const opStrata = fin.operatingStatement(march, costs, [B1], 'JMD', '2026-03-01', '2026-03-31', { book: 'strata' });
    T.check('control: the strata Operating Statement is the corporation\'s cash record and still includes the villa utility, netted of its recovery (40,000 + 10,000 + 8,000 - 6,000)', opStrata.totalExpenditure === 52000, String(opStrata.totalExpenditure));
    T.check('RULE 2: so the Monthly Report equals it less the villa utility and its recovery (52,000 - (8,000 - 6,000) = 50,000)', mon.costsPaid === opStrata.totalExpenditure - (8000 - 6000));
    // Annual report to owners.
    const U = unit('a1', 'A1');
    const annualWith = fin.annualOwnersReport([U], [], march, costs, 'JMD', 2026, {});
    const annualWithout = fin.annualOwnersReport([U], [], [], [repair, commonUtility], 'JMD', 2026, {});
    T.check('RULE 2: the Annual Report\'s expenditure leaves out the villa utility and its recovery (same as with neither present)', annualWith.expenditure === annualWithout.expenditure && annualWith.expenditure === 50000, `${annualWith.expenditure} vs ${annualWithout.expenditure}`);
    // ISPO villa: its utility is ISPO's cost and is not a strata cost at all; nothing leaks onto the owners' documents.
    const ispoUtility = cost('u-ispo', { category: 'Utilities', amount: 9000, unitId: 'a9', unitNumber: 'A9', fund: 'ispo', datePaid: '2026-03-10', date: '2026-03-10' });
    const opsIspo = fin.operationsStatement([ispoUtility], [], 'JMD', '2026-03-01', '2026-03-31');
    T.check('control: an ISPO villa\'s utility is on neither the common costs nor the villa memo of the owners\' statement', opsIspo.costsPaid === 0 && opsIspo.villaRecharged === 0);
  } finally {
    fin_reset(mod);
    cleanup();
  }
  return T.done();
}

function fin_reset(mod) {
  try {
    mod.fin.setOwnershipRegistry([]);
  } catch {
    /* nothing to reset */
  }
}
