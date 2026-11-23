/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two rules from Ro, 2026-11-23:
 *
 *   1. ISPO pays the levy on its own villas by book entry, for now. It is not a
 *      bank movement, so the bank reconciliation never lists it as money to find.
 *      A proprietor's levy receipt still is.
 *   2. A deposit ISPO keeps (withheld or applied) is ISPO's income, dated the day
 *      it was settled, shown as "Deposits kept". Held, or returned in full, it is
 *      nobody's income. It never reaches the corporation's book, and the ISPO
 *      Operations statement and the operating statement still agree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'ISPO’s levy is a book entry; kept deposits are ISPO’s income';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-book-entry-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as fin from './src/lib/finance';
        export * as bank from './src/lib/bankRec';
      `,
      resolveDir: projectRoot,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const unit = (n, over = {}) => ({
  id: `u${n}`, number: String(n), ownerName: 'ISPO', tenantName: '', status: 'long-term', monthlyRent: 50000,
  monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '', rentDueDay: 1, maintDueDay: 1, ...over
});

const receipt = (id, unitId, category, amount, over = {}) => ({
  id, receiptNo: id.toUpperCase(), unitId, unitNumber: unitId.slice(1), category, amount, currency: 'JMD',
  date: '2026-10-05', method: 'Bank Transfer', payerName: 'Payer', status: 'completed', ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  try {
    const { fin, bank } = mod;
    fin.setOwnershipRegistry([]);
    const units = [unit(1), unit(2, { status: 'owner-occupied', ownerName: 'A Proprietor', monthlyRent: 0 })];
    const payments = [
      receipt('r-ispo-levy', 'u1', 'Maintenance', 20000, { payerName: 'ISPO' }),
      receipt('r-owner-levy', 'u2', 'Maintenance', 20000, { payerName: 'A Proprietor' }),
      receipt('r-rent', 'u1', 'Rent', 50000, { payerName: 'Tenant One' })
    ];

    /* ---------------- 1. the levy ISPO pays itself is not a bank item ---------------- */
    const keys = list => list.map(i => i.id);
    const withUnits = bank.bankItems({ payments, units, ownerships: [] });
    T.check('ISPO’s levy on its own villa is not on the bank list', !keys(withUnits).includes('r-ispo-levy'), JSON.stringify(keys(withUnits)));
    T.check('a proprietor’s levy receipt still is', keys(withUnits).includes('r-owner-levy'), JSON.stringify(keys(withUnits)));
    T.check('and so is ISPO’s rent', keys(withUnits).includes('r-rent'), JSON.stringify(keys(withUnits)));
    const strataRec = bank.bankReconciliation({ payments, units }, 'JMD', '2026-10-01', '2026-10-31', 'strata');
    T.check('the strata bank rec expects only the proprietor’s J$20,000', strataRec.moneyIn.total === 20000, String(strataRec.moneyIn.total));
    // Control: the receipt is there to be dropped. Without units nothing tells them apart.
    T.check('control: without the villas the levy receipt would be listed', keys(bank.bankItems({ payments })).includes('r-ispo-levy'));

    /* ---------------- 2. deposits kept ---------------- */
    const tenancies = [
      { id: 't-kept', unitId: 'u1', unitNumber: '1', tenantName: 'Tenant One', currency: 'JMD', depositAmount: 50000, depositCurrency: 'JMD',
        depositReceivedOn: '2026-06-01', depositReturnedOn: '2026-10-20', depositReturnedAmount: 20000, depositWithheldAmount: 30000, depositWithheldReason: 'Broken door' },
      { id: 't-held', unitId: 'u1', unitNumber: '1', tenantName: 'Still Here', currency: 'JMD', depositAmount: 50000, depositReceivedOn: '2026-09-01' },
      { id: 't-back', unitId: 'u1', unitNumber: '1', tenantName: 'All Back', currency: 'JMD', depositAmount: 40000,
        depositReceivedOn: '2026-05-01', depositReturnedOn: '2026-10-10', depositReturnedAmount: 40000, depositWithheldAmount: 0 },
      { id: 't-sept', unitId: 'u1', unitNumber: '1', tenantName: 'Last Month', currency: 'JMD', depositAmount: 9000,
        depositReceivedOn: '2026-04-01', depositReturnedOn: '2026-09-30', depositReturnedAmount: 0, depositWithheldAmount: 9000, depositWithheldReason: 'Unpaid rent' }
    ];
    const bookings = [
      { id: 'b-kept', unitId: 'u1', unitNumber: '1', guestName: 'Guest Usd', currency: 'USD', damageDepositAmount: 200, damageDepositCurrency: 'USD',
        damageDepositReceivedOn: '2026-10-01', damageDepositReturnedOn: '2026-10-15', damageDepositReturnedAmount: 150, damageDepositWithheldAmount: 50, damageDepositWithheldReason: 'Stained sofa' }
    ];
    const kept = fin.depositsKept(tenancies, bookings);
    T.check('only deposits actually kept are listed', kept.map(k => k.id).sort().join() === 'damage-deposit-kept:b-kept,deposit-kept:t-kept,deposit-kept:t-sept', JSON.stringify(kept.map(k => k.id)));

    const st = (book, currency = 'JMD') =>
      fin.operatingStatement(payments, [], units, currency, '2026-10-01', '2026-10-31', { book, depositsKept: kept });
    const group = (s, label) => s.income.find(g => g.label === label);

    const ispo = st('ispo');
    T.check('ISPO’s book shows Deposits kept J$30,000, the October one only', group(ispo, 'Deposits kept')?.total === 30000, JSON.stringify(group(ispo, 'Deposits kept')));
    T.check('the line names the tenant and the reason', /Tenant One \(Broken door\)/.test(group(ispo, 'Deposits kept')?.lines?.[0]?.payer || ''), JSON.stringify(group(ispo, 'Deposits kept')?.lines));
    T.check('ISPO’s income is rent plus the deposit kept', ispo.totalIncome === 50000 + 30000, String(ispo.totalIncome));
    T.check('the strata book carries no deposit', !group(st('strata'), 'Deposits kept') && st('strata').totalIncome === 40000, JSON.stringify(st('strata').income.map(g => [g.label, g.total])));
    T.check('the combined book carries it once', group(st('everything'), 'Deposits kept')?.total === 30000, JSON.stringify(group(st('everything'), 'Deposits kept')));
    T.check('USD stays USD: US$50 kept, on the USD statement only', group(st('ispo', 'USD'), 'Deposits kept')?.total === 50 && !ispo.income.some(g => g.lines.some(l => l.amount === 50)), JSON.stringify(group(st('ispo', 'USD'), 'Deposits kept')));

    const ops = fin.ispoOperations([], payments, units, 'JMD', '2026-10-01', '2026-10-31', kept);
    T.check('ISPO Operations names the J$30,000 kept', ops.depositsKept === 30000, String(ops.depositsKept));
    T.check('and still agrees with the operating statement', ops.net === ispo.surplus, `${ops.net} vs ${ispo.surplus}`);
    T.check('control: with nothing kept, neither statement shows the line', !group(fin.operatingStatement(payments, [], units, 'JMD', '2026-10-01', '2026-10-31', { book: 'ispo' }), 'Deposits kept') && fin.ispoOperations([], payments, units, 'JMD', '2026-10-01', '2026-10-31').depositsKept === 0);
  } finally {
    cleanup();
  }
  return T.done();
}
