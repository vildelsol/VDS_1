/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A villa's utilities never leak into the wrong books.
 *
 * Ro, 2026-11-22: "does any other proprietor have their utilities on the strata
 * books? NO." Every proprietor, ISPO included, holds its own utility accounts
 * with the providers. Asserted here:
 *
 *   1. A Utilities cost on a proprietor's villa is refused, on the register and
 *      on a monthly template; on an ISPO villa it goes to ISPO's book whatever
 *      the form sent; a common utility (no villa) keeps the book chosen.
 *   2. A meter reading on a proprietor's villa is refused; on ISPO's it is kept.
 *   3. Anything of either kind already on file is named on the observations of
 *      the book that counts it, never silently left in the totals.
 *   4. Unrecovered utilities are listed on the book that will receive them.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'A villa’s utilities never leak into the wrong books';

const unitBody = (number, status) => ({
  number,
  ownerName: status === 'owner-occupied' ? 'A Proprietor' : 'ISPO',
  status,
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD'
});

const utilityCost = extra => ({
  category: 'Utilities',
  vendor: 'JPS',
  description: 'Electricity',
  amount: 40000,
  currency: 'JMD',
  date: '2026-10-05',
  status: 'paid',
  datePaid: '2026-10-05',
  paymentMethod: 'Bank Transfer',
  fund: 'strata',
  ...extra
});

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-villa-utility-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export * as obs from './src/lib/observations';
        export * as fin from './src/lib/finance';
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
  id: `u${n}`,
  number: String(n),
  ownerName: 'ISPO',
  tenantName: '',
  status: 'vacant',
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  meterNumber: '',
  notes: '',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

const row = (id, over) => ({
  id,
  category: 'Utilities',
  vendor: 'JPS',
  description: '',
  unitId: '',
  unitNumber: 'General',
  amount: 40000,
  currency: 'JMD',
  date: '2026-10-05',
  datePaid: '2026-10-05',
  status: 'paid',
  paymentMethod: 'Bank Transfer',
  fund: 'strata',
  ...over
});

export default async function run({ port, projectRoot }) {
  const T = reporter(title);

  /* ---------------- the server refuses ---------------- */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-villa-utility-srv-'));
  const srv = await startServer({ port, adminPassword: 'Util-1234!', projectRoot, dataDir });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Util-1234!', 'UtilNew-9876!');
    const u1 = await c.put('/api/units/unit-1', unitBody('1', 'vacant'));
    const u2 = await c.put('/api/units/unit-2', unitBody('2', 'owner-occupied'));
    T.check('setup: villa 1 is ISPO’s and villa 2 a proprietor’s', u1.status === 200 && u2.status === 200, `${u1.status} ${u2.status}`);

    const onOwner = await c.post('/api/expenses', utilityCost({ unitId: 'unit-2' }));
    T.check('a utility cost on a proprietor’s villa is refused', onOwner.status === 400 && /own account/.test(JSON.stringify(onOwner.body)), `${onOwner.status} ${JSON.stringify(onOwner.body).slice(0, 200)}`);
    const onOwnerIspoFund = await c.post('/api/expenses', utilityCost({ unitId: 'unit-2', fund: 'ispo' }));
    T.check('and refused on ISPO’s book too: it is nobody’s cost but the owner’s', onOwnerIspoFund.status === 400, String(onOwnerIspoFund.status));

    const onIspo = await c.post('/api/expenses', utilityCost({ unitId: 'unit-1' }));
    const common = await c.post('/api/expenses', utilityCost({ unitNumber: 'General', description: 'Pool pump' }));
    const repair = await c.post('/api/expenses', utilityCost({ unitId: 'unit-2', category: 'Contractors', description: 'Owner-requested repair' }));
    for (const [name, r] of [['ISPO villa utility', onIspo], ['common utility', common], ['repair on a proprietor villa', repair]]) {
      T.check(`${name} is still accepted`, r.status < 400, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }

    const tmpl = await c.post('/api/recurring-expenses', {
      category: 'Utilities', vendor: 'NWC', description: 'Water', unitId: 'unit-2', amount: 9000, currency: 'JMD', dueDay: 5, fund: 'strata'
    });
    T.check('a monthly utility template on a proprietor’s villa is refused', tmpl.status === 400, `${tmpl.status} ${JSON.stringify(tmpl.body).slice(0, 200)}`);

    const readingBody = unitId => ({ unitId, billingPeriod: '2026-10', previousReading: 100, currentReading: 150, amountCharged: 5000, currency: 'JMD' });
    const rOwner = await c.post('/api/utilities', readingBody('unit-2'));
    T.check('a meter reading billing a proprietor’s villa is refused', rOwner.status === 400, `${rOwner.status} ${JSON.stringify(rOwner.body).slice(0, 200)}`);
    const rIspo = await c.post('/api/utilities', readingBody('unit-1'));
    T.check('a meter reading on an ISPO villa is accepted', rIspo.status < 400, `${rIspo.status} ${JSON.stringify(rIspo.body).slice(0, 200)}`);

    const db = (await c.get('/api/db')).body;
    const ispoRow = db.expenses.find(e => e.unitId === 'unit-1' && e.category === 'Utilities');
    T.check('the ISPO villa’s utility is on ISPO’s book, though the form sent strata', ispoRow?.fund === 'ispo', JSON.stringify(ispoRow));
    const commonRow = db.expenses.find(e => e.description === 'Pool pump');
    T.check('the common utility keeps the book chosen', (commonRow?.fund || 'strata') === 'strata', JSON.stringify(commonRow));
    T.check('nothing on a proprietor’s villa reached the utility register', !db.expenses.some(e => e.unitId === 'unit-2' && e.category === 'Utilities') && !db.utilities.some(u => u.unitId === 'unit-2'));
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  /* ---------------- records already on file, and the combined screens ---------------- */
  const { mod, cleanup } = await loadModules(projectRoot);
  try {
    const { obs } = mod;
    const units = [unit(1), unit(2, { status: 'owner-occupied', ownerName: 'A Proprietor' })];
    const expenses = [
      row('stray', { unitId: 'u2', unitNumber: '2' }),
      row('common', { description: 'Pool pump' }),
      row('ispo-util', { unitId: 'u1', unitNumber: '1', fund: 'ispo' })
    ];
    const utilities = [
      { id: 'r-own', unitId: 'u2', unitNumber: '2', meterNumber: '', billingPeriod: '2026-10', previousReading: 0, currentReading: 1, consumption: 1, amountCharged: 7000, currency: 'JMD', status: 'unpaid' },
      { id: 'r-ispo', unitId: 'u1', unitNumber: '1', meterNumber: '', billingPeriod: '2026-10', previousReading: 0, currentReading: 1, consumption: 1, amountCharged: 3000, currency: 'JMD', status: 'unpaid' }
    ];
    const input = book => ({ units, tenancies: [], bookings: [], charges: [], payments: [], expenses, utilities, currency: 'JMD', from: '2026-10-01', to: '2026-10-31', book });
    const flat = list => list.map(o => [o.text, ...(o.details || [])].join('\n')).join('\n');

    const strata = flat(obs.observationsFor(input('strata')));
    T.check('a proprietor’s utility already on the strata book is named, with the villa and amount', /utility bill\(s\) on proprietors' villas, J\$40,000\.00/.test(strata) && /Villa 2|\b2: JPS/.test(strata), strata);
    T.check('a meter reading already billing a proprietor’s villa is named', /meter reading\(s\) bill proprietors' villas/.test(strata), strata);
    const ispo = flat(obs.observationsFor(input('ispo')));
    T.check('ISPO’s book does not list the strata book’s stray bill', !/proprietors' villas, J\$40,000/.test(ispo), ispo);

    T.check('an unrecovered utility on an ISPO villa is listed on ISPO’s book', /3,000\.00 from ISPO/.test(ispo), ispo);
    T.check('and not on the corporation’s', !/3,000\.00 from ISPO/.test(strata), strata);

  } finally {
    cleanup();
  }

  return T.done();
}
