/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The combined ("everything") view counts money that is on both books once.
 *
 * A tenant pays rent J$75,000, of which the corporation takes J$20,000 as the
 * villa's maintenance. That J$20,000 is inside the tenant's rent charge and is
 * also the corporation's own maintenance charge. Added together it is counted
 * twice. Ro, 2026-11-10: "I do not want double counting... why would you bill
 * 960k when the real number is 780k?"
 *
 * The single-book views must NOT change: ISPO still bills the whole 75,000 and the
 * corporation still bills 20,000.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Combined view counts shared money once';

export default async function run({ port, projectRoot }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-combined-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({ entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' });
  const F = await import(pathToFileURL(outfile).href);
  const srv = await startServer({ port, adminPassword: 'Combined-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Combined-1234!', 'CombinedNew-9876!');
    const rents = [75000, 80000, 85000]; // agreed rents; 20,000 of each is the corporation's
    for (let i = 0; i < 3; i++) await makeLongTermUnit(c, `unit-${i + 1}`, { monthlyRent: rents[i], monthlyMaintenance: 20000, tenantName: `T${i + 1}` });
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'owner-occupied', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    const months = ['2026-06', '2026-07', '2026-08'];
    for (const m of months) await c.post('/api/charges/post-month', { monthString: m });

    const pay = (unitId, category, amount, date, payerName) =>
      recordAndConfirmPayment(c, { unitId, category, amount, currency: 'JMD', payerName, method: 'Cash', date });
    for (const [i, m] of months.entries()) {
      for (let u = 0; u < 3; u++) {
        await pay(`unit-${u + 1}`, 'Rent', rents[u], `${m}-05`, `T${u + 1}`);   // tenant pays the full agreed rent
        await pay(`unit-${u + 1}`, 'Maintenance', 20000, `${m}-06`, 'ISPO');           // ISPO passes the corporation's 20k on
      }
      await pay('unit-4', 'Maintenance', 20000, `${m}-07`, 'Owner Four');              // the owner pays their own
    }
    const db = (await c.get('/api/db')).body;
    const frozen = JSON.stringify([db.charges, db.payments]);
    const from = '2026-06-01', to = '2026-08-31';
    const sum = rows => Math.round(rows.reduce((a, x) => a + x, 0) * 100) / 100;

    // ---- single books: unchanged ----
    const ispoBilled = F.chargedInPeriod(F.chargesInBook(db.charges, 'ispo'), 'JMD', from, to);
    const strataBilled = F.chargedInPeriod(F.chargesInBook(db.charges, 'strata'), 'JMD', from, to);
    T.check('ISPO still bills the whole agreed rent: 3 x (75k+80k+85k) = 720,000', ispoBilled.total === 720000, String(ispoBilled.total));
    T.check('the corporation still bills its maintenance: 4 villas x 3 x 20,000 = 240,000', strataBilled.total === 240000, String(strataBilled.total));

    // ---- the combined view ----
    const merged = F.consolidateEverything(db.charges, db.payments, db.units);
    const billed = F.chargedInPeriod(merged.charges, 'JMD', from, to);
    const collected = F.collectedInPeriod(merged.payments, 'JMD', from, to);
    const rawBilled = F.chargedInPeriod(db.charges, 'JMD', from, to);
    T.check('without the fix the combined total double counts: 960,000', rawBilled.total === 960000, String(rawBilled.total));
    T.check('combined billed is the real 780,000', billed.total === 780000, String(billed.total));
    T.check('made of 540,000 rent and 240,000 maintenance', billed.rent === 540000 && billed.maintenance === 240000, `${billed.rent}/${billed.maintenance}`);
    T.check('combined received is the real money in: 720,000 from tenants + 60,000 from the owner', collected.total === 780000, String(collected.total));
    T.check('so the combined collection rate is exactly 100%', billed.total === collected.rent + collected.maintenance);
    const receivable = sum(db.units.flatMap(u => ['Rent', 'Maintenance'].map(cat => F.accountBalance(u, cat, merged.charges, merged.payments, to, db.units)).filter(a => a.currency === 'JMD').map(a => a.balance)));
    T.check('and the combined receivable is nil, not minus 180,000', receivable === 0, String(receivable));

    // ---- the single-book receipts still balance ----
    const strataIn = F.collectedInPeriod(F.paymentsInBook(db.payments, 'strata'), 'JMD', from, to).total;
    const ispoIn = F.collectedInPeriod(F.paymentsInBook(db.payments, 'ispo'), 'JMD', from, to).total;
    T.check('the corporation still sees ISPO\'s contributions as received: 240,000', strataIn === 240000, String(strataIn));
    T.check('ISPO still sees the tenants\' full payments: 720,000', ispoIn === 720000, String(ispoIn));

    // ---- no mutation ----
    T.check('the stored books are not altered by consolidating', JSON.stringify([db.charges, db.payments]) === frozen);
    T.check('an eliminated charge is a copy; the original keeps 75,000', db.charges.filter(x => x.category === 'Rent' && x.status === 'open').every(x => x.amount >= 75000));

    // ---- a month where the maintenance charge is voided is not eliminated ----
    const c1 = db.charges.find(x => x.unitId === 'unit-1' && x.category === 'Maintenance' && x.periodMonth === '2026-06');
    await c.post(`/api/charges/${c1.id}/void`, { reason: 'Voided to test pairing.' });
    const db2 = (await c.get('/api/db')).body;
    const m2 = F.consolidateEverything(db2.charges, db2.payments, db2.units);
    const rentJune = m2.charges.find(x => x.unitId === 'unit-1' && x.category === 'Rent' && x.periodMonth === '2026-06' && x.status === 'open');
    T.check('with no maintenance charge to pair with, the rent keeps all 75,000', rentJune.amount === 75000, String(rentJune.amount));
    T.check('a rent charge with no split (legacy) is never touched', F.consolidateEverything([{ ...rentJune, maintenancePortion: undefined, rentPortion: undefined }], []).charges[0].amount === 75000);
    const empty = F.consolidateEverything([], []);
    T.check('empty books consolidate to empty', empty.charges.length === 0 && empty.payments.length === 0);
  } catch (err) {
    T.check('test ran without error', false, err.stack || err.message);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
