/*
 * The Bank reconciliation receipts list (Reconciliation.tsx) holds only money
 * that crossed the bank account (2026-11-24).
 *
 * ISPO's maintenance on its own villas is a book entry (Ro, 2026-11-23), and a
 * maintenance payment "settled from rent" is worked out of a rent receipt. Neither
 * is on any bank statement. The summary already left them out, but the list
 * below it showed them, so staff were asked to find receipts no bank would show.
 *
 * Renders the real screen and recomputes its figures from the fixture by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Bank reconciliation lists only receipts that reached the bank';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function loadScreen(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-bankrec-list-'));
  const outfile = path.join(dir, 'screen.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { default as ReconciliationTab } from './src/components/Reconciliation';
        export { setOwnershipRegistry } from './src/lib/finance';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const unit = (n, over = {}) => ({
  id: `u${n}`, number: String(n), ownerName: 'ISPO', tenantName: '', status: 'long-term', monthlyRent: 100000,
  monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '', rentDueDay: 1, maintDueDay: 1, ...over
});
const receipt = (id, unitId, category, amount, over = {}) => ({
  id, receiptNo: id.toUpperCase(), unitId, unitNumber: unitId.slice(1), category, amount, currency: 'JMD',
  date: '2026-10-05', method: 'Bank Transfer', payerName: 'Payer', status: 'completed', ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const RealDate = Date;
  const { mod: M, cleanup } = await loadScreen(projectRoot);
  // The screen opens on the current month: pin it to October 2026.
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : ['2026-10-20T12:00:00'])); }
    static now() { return new RealDate('2026-10-20T12:00:00').getTime(); }
  };
  try {
    M.setOwnershipRegistry([]);
    const units = [
      unit(1, { tenantName: 'Tenant One' }),                                          // ISPO villa, let
      unit(2, { status: 'short-term' }),                                              // ISPO villa, short-let
      unit(3, { status: 'owner-occupied', ownerName: 'A Proprietor', monthlyRent: 0 }) // proprietor
    ];
    const payments = [
      receipt('r-rent', 'u1', 'Rent', 100000, { payerName: 'Tenant One' }),            // ISPO's bank
      receipt('from-rent-u1', 'u1', 'Maintenance', 20000, { derived: true, payerName: 'ISPO', settlesDueDate: '2026-10-01' }),
      receipt('r-ispo-own', 'u2', 'Maintenance', 20000, { payerName: 'ISPO' }),        // book entry
      receipt('r-owner', 'u3', 'Maintenance', 20000, { payerName: 'A Proprietor' })    // strata's bank
    ];
    const session = { role: 'ADMINISTRATOR', permissions: {} };
    const h = M.React.createElement;
    const render = list => text(M.renderToStaticMarkup(h(M.ReconciliationTab, { payments: list, units, session, onReconcile: async () => {} })));

    const page = render(payments);
    // By hand: only the proprietor's J$20,000 reached the corporation's bank in October.
    T.check('the strata list holds one receipt, the proprietor’s', /1 receipt\(s\) in October 2026/.test(page), page.slice(0, 400));
    T.check('and totals J$20,000', /J\$20,000\.00 1 receipt\(s\)/.test(page), page.match(/.{60}1 receipt\(s\)/)?.[0]);
    T.check('the proprietor’s receipt is listed', page.includes('R-OWNER'));
    T.check('the settled-from-rent payment is not', !page.includes('FROM-RENT-U1'));
    T.check('ISPO’s own maintenance on its short-let villa is not', !page.includes('R-ISPO-OWN'));
    T.check('ISPO’s rent is not on the corporation’s list', !page.includes('R-RENT'));
    T.check('the list agrees with the summary’s money in', /Money in \(1\) J\$20,000\.00/.test(page), page.match(/Money in[^N]{0,80}/)?.[0]);

    // Positive control: a second proprietor receipt is picked up, so the list is not just empty-by-accident.
    const more = render([...payments, receipt('r-owner-2', 'u3', 'Maintenance', 5000, { date: '2026-10-09', payerName: 'A Proprietor' })]);
    T.check('control: a second proprietor receipt makes 2 receipts', /2 receipt\(s\) in October 2026/.test(more) && more.includes('R-OWNER-2'));
  } finally {
    globalThis.Date = RealDate;
    cleanup();
  }
  return T.done();
}
