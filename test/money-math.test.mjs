/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The arithmetic itself, tested directly rather than through the API.
 *
 * Everything else in this suite drives the server. But the figures the business
 * actually acts on — what an account owes, what was collected in a month, what a
 * proprietor is told — are computed in `src/lib/money.ts` and `src/lib/finance.ts`,
 * and most of that runs in the browser where no test had ever reached it. The
 * server was well covered; the sums were not.
 *
 * Two properties matter more than any individual number:
 *
 *  - **Money does not drift.** Every total goes through cents, so adding a
 *    hundred small figures gives the figure a person would get on paper, not
 *    1.0000000000000007.
 *  - **USD and JMD never meet.** They are not converted and not combined. The
 *    rate on file is for display. A single mixed total would misstate a
 *    proprietor's account, and nothing downstream would notice.
 *
 * The modules are TypeScript, so they are bundled with esbuild (already a
 * dependency) into a temporary file and imported.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reporter } from './harness.mjs';

export const title = 'Money arithmetic & currency separation';

async function loadLib(projectRoot) {
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-math-'));
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(projectRoot, 'src/lib/finance.ts'))};\nexport * from ${JSON.stringify(path.join(projectRoot, 'src/lib/money.ts'))};\n`);
  const outfile = path.join(dir, 'lib.mjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  const mod = await import(`file://${outfile}`);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const unit = over => ({
  id: 'unit-1',
  number: '1',
  ownerName: 'Owner',
  tenantName: 'Tenant',
  status: 'long-term',
  monthlyRent: 50000,
  monthlyMaintenance: 10000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  ...over
});

const charge = over => ({ id: 'c1', unitId: 'unit-1', category: 'Rent', amount: 50000, currency: 'JMD', status: 'open', dueDate: '2026-07-01', ...over });
const payment = over => ({ id: 'p1', unitId: 'unit-1', category: 'Rent', amount: 50000, currency: 'JMD', status: 'completed', date: '2026-07-05', ...over });

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadLib(projectRoot);
  try {
    const { round2, sumMoney, addMoney, subtractMoney, parseMoneyInput, accountBalance, periodStatement, collectedInPeriod, chargedInPeriod, expensesInPeriod } = mod;

    /* ---------------------------------------------------------------- *
     * Money does not drift
     * ---------------------------------------------------------------- */

    T.check('0.1 + 0.2 is 0.30, not 0.30000000000000004', addMoney(0.1, 0.2) === 0.3, String(addMoney(0.1, 0.2)));
    T.check('a hundred cents make exactly one dollar', sumMoney(Array(100).fill(0.01)) === 1, String(sumMoney(Array(100).fill(0.01))));
    T.check('a thousand cents make exactly ten dollars', sumMoney(Array(1000).fill(0.01)) === 10, String(sumMoney(Array(1000).fill(0.01))));
    T.check('subtracting to zero gives a clean zero', subtractMoney(0.3, 0.1 + 0.2) === 0, String(subtractMoney(0.3, 0.1 + 0.2)));
    T.check('a large realistic ledger sums exactly', sumMoney([50000, 10000, 12345.67, 0.33, 999.99]) === 73345.99, String(sumMoney([50000, 10000, 12345.67, 0.33, 999.99])));
    T.check('half a cent rounds up rather than vanishing', round2(0.005) === 0.01, String(round2(0.005)));
    T.check('a third of a dollar is held to the cent', round2(1 / 3) === 0.33, String(round2(1 / 3)));
    T.check('adding a third three times does not make a dollar out of thin air', sumMoney([round2(1 / 3), round2(1 / 3), round2(1 / 3)]) === 0.99);

    // Order must not change a total, or two screens summing the same rows disagree.
    const rows = [1234.56, 0.07, 99.99, 5000, 0.01, 78.9];
    const forwards = sumMoney(rows);
    const backwards = sumMoney([...rows].reverse());
    T.check('a total is the same whichever order the rows are added', forwards === backwards, `${forwards} vs ${backwards}`);

    /* ---------------------------------------------------------------- *
     * Figures are read or refused
     * ---------------------------------------------------------------- */

    T.check('a plain figure is read', parseMoneyInput('50000') === 50000);
    T.check('a grouped figure is read', parseMoneyInput('1,234.56') === 1234.56);
    T.check('a figure with a currency mark is read', parseMoneyInput('$50,000') === 50000);
    T.check('a genuine decimal is kept to the cent', parseMoneyInput('50000.505') === 50000.51);
    T.check('a dotted thousands figure is refused, not read as 1.5', parseMoneyInput('1.500.000') === null);
    T.check('exponent notation is refused', parseMoneyInput('1e999') === null);
    T.check('trailing junk is refused', parseMoneyInput('50000abc') === null);
    T.check('an empty figure is refused', parseMoneyInput('') === null);
    T.check('Infinity is refused', parseMoneyInput(Infinity) === null);
    T.check('NaN is refused', parseMoneyInput(NaN) === null);

    /* ---------------------------------------------------------------- *
     * What an account owes
     * ---------------------------------------------------------------- */

    const u = unit();
    const charges = [charge({ id: 'c-jul', dueDate: '2026-07-01' }), charge({ id: 'c-aug', dueDate: '2026-08-01' })];

    const nothingPaid = accountBalance(u, 'Rent', charges, [], undefined, [u]);
    T.check('two unpaid months are owed in full', nothingPaid.balance === 100000, String(nothingPaid.balance));
    T.check('and the account reads as in arrears', nothingPaid.status === 'in-arrears');
    T.check('and both months are listed as unpaid', nothingPaid.unpaidCharges.length === 2);

    const oneMonthPaid = accountBalance(u, 'Rent', charges, [payment({ amount: 50000 })], undefined, [u]);
    T.check('paying one month leaves the other owed', oneMonthPaid.balance === 50000, String(oneMonthPaid.balance));
    T.check('and the paid month is cleared oldest-first', oneMonthPaid.unpaidCharges[0]?.id === 'c-aug');

    const settled = accountBalance(u, 'Rent', charges, [payment({ amount: 100000 })], undefined, [u]);
    T.check('paying both months settles the account', settled.balance === 0 && settled.status === 'settled');

    const overpaid = accountBalance(u, 'Rent', charges, [payment({ amount: 120000 })], undefined, [u]);
    T.check('overpaying reads as credit, not settled', overpaid.balance === -20000 && overpaid.status === 'credit', `${overpaid.balance} ${overpaid.status}`);

    // A refund is money handed back: the tenant owes it again.
    const refunded = accountBalance(u, 'Rent', charges, [payment({ amount: 100000, refundedAmount: 50000, refundedOn: '2026-08-10' })], undefined, [u]);
    T.check('a refund puts the account back into arrears', refunded.balance === 50000, String(refunded.balance));
    T.check('and the property is not still counted as holding the money', refunded.paid === 50000, String(refunded.paid));

    // ...but only from the day it was handed back.
    const beforeRefund = accountBalance(u, 'Rent', charges, [payment({ amount: 100000, refundedAmount: 50000, refundedOn: '2026-08-10' })], '2026-08-01', [u]);
    T.check('a refund does not reach back into a month already reported', beforeRefund.paid === 100000, String(beforeRefund.paid));

    // A pending receipt is an expectation, not money.
    const pendingOnly = accountBalance(u, 'Rent', charges, [payment({ status: 'pending', amount: 100000 })], undefined, [u]);
    T.check('an unconfirmed receipt moves no balance', pendingOnly.balance === 100000, String(pendingOnly.balance));
    const voided = accountBalance(u, 'Rent', charges, [payment({ status: 'reversed', amount: 100000 })], undefined, [u]);
    T.check('a voided receipt moves no balance', voided.balance === 100000, String(voided.balance));

    /* ---------------------------------------------------------------- *
     * USD and JMD never meet
     * ---------------------------------------------------------------- */

    const mixedPayments = [payment({ id: 'p-jmd', amount: 50000, currency: 'JMD' }), payment({ id: 'p-usd', amount: 50000, currency: 'USD' })];
    const jmdAccount = accountBalance(u, 'Rent', charges, mixedPayments, undefined, [u]);
    T.check('a USD receipt does not pay down a JMD account', jmdAccount.paid === 50000, String(jmdAccount.paid));
    T.check('and it is surfaced as a currency mismatch rather than ignored silently', jmdAccount.mismatchedCurrencyPayments.length === 1);

    const jmdCollected = collectedInPeriod(mixedPayments, 'JMD', '2026-07-01', '2026-07-31');
    const usdCollected = collectedInPeriod(mixedPayments, 'USD', '2026-07-01', '2026-07-31');
    T.check('the JMD collection total counts only JMD', jmdCollected.total === 50000, String(jmdCollected.total));
    T.check('the USD collection total counts only USD', usdCollected.total === 50000, String(usdCollected.total));
    T.check('neither total is the sum of both', jmdCollected.total + usdCollected.total === 100000 && jmdCollected.total !== 100000);

    const mixedCharges = [charge({ id: 'c-jmd', currency: 'JMD', amount: 50000 }), charge({ id: 'c-usd', currency: 'USD', amount: 400 })];
    T.check('charges are totalled per currency', chargedInPeriod(mixedCharges, 'JMD', '2026-07-01', '2026-07-31').total === 50000);
    T.check('and the other currency is untouched by it', chargedInPeriod(mixedCharges, 'USD', '2026-07-01', '2026-07-31').total === 400);

    const mixedExpenses = [
      { id: 'e1', amount: 12345.67, currency: 'JMD', status: 'paid', date: '2026-07-03', datePaid: '2026-07-03' },
      { id: 'e2', amount: 500, currency: 'USD', status: 'paid', date: '2026-07-04', datePaid: '2026-07-04' },
      { id: 'e3', amount: 999, currency: 'JMD', status: 'pending', date: '2026-07-05' }
    ];
    T.check('expenses are totalled per currency', expensesInPeriod(mixedExpenses, 'JMD', '2026-07-01', '2026-07-31') === 12345.67, String(expensesInPeriod(mixedExpenses, 'JMD', '2026-07-01', '2026-07-31')));
    T.check('an unpaid expense is not counted as money spent', expensesInPeriod(mixedExpenses, 'JMD', '2026-07-01', '2026-07-31') !== 13344.67);
    T.check('the USD expense stays in USD', expensesInPeriod(mixedExpenses, 'USD', '2026-07-01', '2026-07-31') === 500);

    // Maintenance can be billed in a different currency from rent on the same villa.
    const splitUnit = unit({ currency: 'JMD', maintCurrency: 'USD', monthlyMaintenance: 300 });
    const splitCharges = [charge({ id: 'c-rent', category: 'Rent', currency: 'JMD', amount: 50000 }), charge({ id: 'c-maint', category: 'Maintenance', currency: 'USD', amount: 300 })];
    const rentAcct = accountBalance(splitUnit, 'Rent', splitCharges, [], undefined, [splitUnit]);
    const maintAcct = accountBalance(splitUnit, 'Maintenance', splitCharges, [], undefined, [splitUnit]);
    T.check('a villa billed in two currencies keeps its rent in JMD', rentAcct.currency === 'JMD' && rentAcct.balance === 50000);
    T.check('and its maintenance in USD', maintAcct.currency === 'USD' && maintAcct.balance === 300);

    /* ---------------------------------------------------------------- *
     * A statement has to add up
     * ---------------------------------------------------------------- */

    const stmt = periodStatement(u, 'Rent', charges, [payment({ amount: 50000, date: '2026-07-05' })], '2026-07-01', '2026-07-31', [u]);
    T.check('a statement opens at nothing owed before the first charge', stmt.opening === 0, String(stmt.opening));
    T.check('it charges the month', stmt.charged === 50000, String(stmt.charged));
    T.check('it counts what was paid in the month', stmt.paid === 50000, String(stmt.paid));
    T.check('and it closes at opening + charged - paid', stmt.closing === round2(stmt.opening + stmt.charged - stmt.paid), String(stmt.closing));

    const august = periodStatement(u, 'Rent', charges, [payment({ amount: 50000, date: '2026-07-05' })], '2026-08-01', '2026-08-31', [u]);
    T.check("August opens where July closed", august.opening === stmt.closing, `${august.opening} vs ${stmt.closing}`);
    T.check('so no month is silently skipped or double-counted', august.closing === 50000, String(august.closing));

    // A July receipt refunded in August must move August, never restate July.
    const late = [payment({ amount: 50000, date: '2026-07-05', refundedAmount: 50000, refundedOn: '2026-08-10' })];
    const julyAgain = periodStatement(u, 'Rent', charges, late, '2026-07-01', '2026-07-31', [u]);
    const augustAgain = periodStatement(u, 'Rent', charges, late, '2026-08-01', '2026-08-31', [u]);
    T.check('a refund in August leaves July exactly as it was reported', julyAgain.paid === 50000 && julyAgain.closing === 0, `paid ${julyAgain.paid} closing ${julyAgain.closing}`);
    T.check('and August carries the money going back out', augustAgain.paid === -50000, String(augustAgain.paid));
    T.check('so the year still adds up across the two months', round2(julyAgain.paid + augustAgain.paid) === 0);

    return T.done();
  } finally {
    cleanup();
  }
}
