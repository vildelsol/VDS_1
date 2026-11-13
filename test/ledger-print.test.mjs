/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The whole-ledger print.
 *
 * The HOA & Tenants Ledger could print one account's statement and nothing else:
 * there was no way to put the ledger itself on paper. The printed page is built
 * from the same account list the screen shows, so what has to hold is that the
 * paper carries every account, totals each currency on its own, never adds JMD to
 * USD, and says "owing" only for money actually owed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'The ledger prints whole, each currency totalled on its own';

const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, "'").replace(/\s+/g, ' ').trim();

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ledger-print-'));
  const outfile = path.join(dir, 'doc.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { LedgerDocument } from './src/components/FinanceHub';
        export { accountBalance } from './src/lib/finance';
        export { default as React } from 'react';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  try {
    const { LedgerDocument, accountBalance, renderToStaticMarkup, React } = await import(pathToFileURL(outfile).href);
    const unit = (id, number, over) => ({
      id, number, ownerName: `OWNER-${number}`, ownerEmail: '', ownerPhone: '', tenantName: '', tenantEmail: '', tenantPhone: '',
      status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 25000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, meterNumber: '', notes: '', ...over
    });
    const units = [unit('u1', 'A1'), unit('u2', 'A2'), unit('u3', 'A3'), unit('u4', 'A4', { monthlyMaintenance: 150, maintCurrency: 'USD' })];
    const charge = (u, month, amount, currency) => ({ id: `c-${u.id}-${month}`, unitId: u.id, unitNumber: u.number, category: 'Maintenance', periodMonth: month, dueDate: `${month}-01`, amount, currency, status: 'open', payerName: u.ownerName, description: 'x', createdAt: '', createdBy: 't' });
    const charges = [];
    for (const u of units.slice(0, 3)) for (const m of ['2026-08', '2026-09']) charges.push(charge(u, m, 25000, 'JMD'));
    for (const m of ['2026-08', '2026-09']) charges.push(charge(units[3], m, 150, 'USD'));
    const payments = [
      { id: 'p1', unitId: 'u1', unitNumber: 'A1', category: 'Maintenance', amount: 50000, currency: 'JMD', date: '2026-09-05', status: 'completed', payerName: 'OWNER-A1', method: 'Cash', receiptNo: 'R1' },
      { id: 'p2', unitId: 'u2', unitNumber: 'A2', category: 'Maintenance', amount: 25000, currency: 'JMD', date: '2026-08-05', status: 'completed', payerName: 'OWNER-A2', method: 'Cash', receiptNo: 'R2' },
      { id: 'p3', unitId: 'u4', unitNumber: 'A4', category: 'Maintenance', amount: 150, currency: 'USD', date: '2026-08-05', status: 'completed', payerName: 'OWNER-A4', method: 'Cash', receiptNo: 'R3' }
    ];
    const accounts = units.map(u => accountBalance(u, 'Maintenance', charges, payments, '2026-10-01', units));
    const html = renderToStaticMarkup(
      React.createElement(LedgerDocument, { accounts, category: 'Maintenance', asOf: '2026-10-01', payments, nameOf: u => u.ownerName, generatedBy: 'TESTER', onClose: () => {} })
    );
    const text = strip(html);

    T.check('it is titled and dated', /HOA maintenance ledger/i.test(text) && /1 Oct 2026/.test(text));
    T.check('every account is on the page', units.every(u => text.includes(`OWNER-${u.number}`)));
    T.check('a fully paid account reads Settled', /OWNER-A1 J\$50,000\.00 J\$50,000\.00 5 Sep 2026 Settled/.test(text), text.slice(text.indexOf('OWNER-A1'), text.indexOf('OWNER-A1') + 120));
    T.check('an unpaid account shows what is owed', /OWNER-A3.*J\$50,000\.00 J\$0\.00 never J\$50,000\.00/.test(text));
    T.check('the JMD total is billed 150,000, received 75,000, owing 75,000', /Total \(JMD\) J\$150,000\.00 J\$75,000\.00 J\$75,000\.00 owing/.test(text), text.slice(text.indexOf('Total (JMD)'), text.indexOf('Total (JMD)') + 100));
    T.check('the USD account is totalled on its own: billed 300, received 150, owing 150', /Total \(USD\) \$300\.00 \$150\.00 \$150\.00 owing/.test(text), text.slice(text.indexOf('Total (USD)'), text.indexOf('Total (USD)') + 100));
    T.check('no figure on the page adds the two currencies (no 150,150 or 75,150 anywhere)', !/150,150|75,150|225,000/.test(text));
    T.check('it is signed off by the person who printed it', /TESTER/.test(text));
    T.check('nothing on the page is NaN, undefined or null', !/NaN|undefined|null/.test(text));
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
