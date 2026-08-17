/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The operational and financial health grade.
 *
 * A single letter on the dashboard is the most dangerous kind of figure in this
 * application: it is the one nobody checks, because checking it means
 * reconstructing it. So the rules it must obey are stricter than for a number
 * somebody would naturally interrogate.
 *
 *   - The grade is the weighted mean of the components printed beside it, and
 *     nothing else. If it cannot be reproduced from what is on screen, it lies.
 *   - **A component with no data is excluded, never scored zero.** A property
 *     that has billed nothing has not failed at collection. Scoring absent as
 *     zero would manufacture a bad grade out of an empty month, and somebody
 *     would act on it.
 *   - Nothing measurable at all means no grade, not grade E.
 *   - Per currency, like everything else here.
 *
 * Uses the real `src/lib/finance.ts` rather than a copy of its rules.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Operational and financial health';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-health-'));
  const outfile = path.join(dir, 'finance.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const FROM = '2026-01-01';
const TO = '2026-12-31';

const villa = (over = {}) => ({
  id: 'unit-1',
  number: '1',
  ownerName: 'Owner',
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
  meterNumber: '',
  notes: '',
  ...over
});

const charge = (over = {}) => ({
  id: `chg-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  periodMonth: '2026-06',
  dueDate: '2026-06-01',
  amount: 100000,
  currency: 'JMD',
  status: 'open',
  payerName: 'Owner',
  createdAt: '',
  createdBy: 'test',
  ...over
});

const payment = (over = {}) => ({
  id: `p-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  category: 'Maintenance',
  amount: 100000,
  currency: 'JMD',
  date: '2026-06-10',
  status: 'completed',
  payerName: 'Owner',
  method: 'Cash',
  receiptNo: 'R1',
  ...over
});

const expense = (over = {}) => ({
  id: `ex-${Math.random().toString(16).slice(2)}`,
  category: 'Security',
  vendor: 'Armour',
  description: '',
  unitId: '',
  unitNumber: 'General',
  amount: 50000,
  currency: 'JMD',
  date: '2026-06-15',
  dueDate: '2026-06-15',
  datePaid: '2026-06-15',
  status: 'paid',
  paymentMethod: 'Bank Transfer',
  reference: '',
  notes: '',
  ...over
});

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  const { operationalHealth, gradeFor } = mod;

  const health = (units, charges, payments, expenses, currency = 'JMD') =>
    operationalHealth(units, charges, payments, expenses, currency, FROM, TO);

  try {
    /* ---------------- the grade is its own components ---------------- */
    {
      const r = health([villa()], [charge()], [payment()], [expense()]);
      T.check('a property with records gets a grade', !!r, String(r));

      // The invariant that makes the letter trustworthy: it is reproducible
      // from exactly what is printed next to it.
      const rebuilt =
        Math.round(r.components.reduce((s, c) => s + c.score * (c.weight / 100), 0) * 100) / 100;
      T.check(
        'the grade is the weighted mean of the components shown beside it',
        Math.abs(rebuilt - r.score) < 0.05,
        `rebuilt ${rebuilt} vs stated ${r.score}`
      );
      T.check(
        'and the weights shown add up to a hundred per cent',
        Math.abs(r.components.reduce((s, c) => s + c.weight, 0) - 100) < 0.05,
        String(r.components.reduce((s, c) => s + c.weight, 0))
      );
      T.check('the letter matches the score', r.grade === gradeFor(r.score), `${r.grade} for ${r.score}`);
      T.check('every component states the figure behind it', r.components.every(c => !!c.detail && c.detail.length > 3));
      T.check('and no component scores outside 0–100', r.components.every(c => c.score >= 0 && c.score <= 100));
    }

    /* ---------------- absent is never zero ---------------- */
    {
      // Nothing billed. Collection cannot be measured — it must be dropped, not
      // scored zero, or an empty month reads as a failing property.
      const r = health([villa()], [], [], [expense()]);
      T.check('with nothing billed, collection is not scored at all', !r || !r.components.some(c => c.key === 'collection'), JSON.stringify(r?.components));
      T.check('and cost coverage is not scored either', !r || !r.components.some(c => c.key === 'coverage'));
      if (r) {
        T.check('the remaining weights are renormalised to a hundred', Math.abs(r.components.reduce((s, c) => s + c.weight, 0) - 100) < 0.05, String(r.components.reduce((s, c) => s + c.weight, 0)));
      }
    }

    {
      // Absolutely nothing on file: no grade, rather than the worst grade.
      const r = health([villa()], [], [], []);
      T.check('a property with no records at all gets no grade, not an E', r === null, JSON.stringify(r));
    }

    /* ---------------- the components move the right way ---------------- */
    {
      const paidUp = health([villa()], [charge()], [payment()], [expense()]);
      const nobodyPaid = health([villa()], [charge()], [], [expense()]);
      T.check(
        'a property where nobody paid grades worse than one where everybody did',
        nobodyPaid.score < paidUp.score,
        `${nobodyPaid.score} vs ${paidUp.score}`
      );

      const collection = paidUp.components.find(c => c.key === 'collection');
      T.check('full collection scores full marks', collection.score === 100, String(collection.score));
      T.check(
        'and no collection scores none',
        nobodyPaid.components.find(c => c.key === 'collection').score === 0
      );
    }

    {
      // Over-collection is catch-up, not performance, and must not run over 100
      // — otherwise it would mask a weak component elsewhere.
      const r = health([villa()], [charge({ amount: 50000 })], [payment({ amount: 100000 })], [expense()]);
      const collection = r.components.find(c => c.key === 'collection');
      T.check('collecting more than was billed is capped at full marks, not more', collection.score === 100, String(collection.score));
    }

    {
      // Spending more than is billed is the structural loss the annual report
      // exists to surface. It has to pull the grade down.
      const sustainable = health([villa()], [charge({ amount: 200000 })], [payment({ amount: 200000 })], [expense({ amount: 100000 })]);
      const lossMaking = health([villa()], [charge({ amount: 100000 })], [payment({ amount: 100000 })], [expense({ amount: 400000 })]);
      T.check(
        'a property spending more than it bills grades worse than one that does not',
        lossMaking.score < sustainable.score,
        `${lossMaking.score} vs ${sustainable.score}`
      );
      T.check(
        'and its cost coverage is the component that says so',
        lossMaking.components.find(c => c.key === 'coverage').score <
          sustainable.components.find(c => c.key === 'coverage').score
      );
    }

    {
      // Old debt is materially worse than recent debt, and a flat arrears total
      // hides that completely.
      const recent = health([villa()], [charge({ dueDate: '2026-12-15' })], [], [expense()]);
      const ancient = health([villa()], [charge({ dueDate: '2026-01-05' })], [], [expense()]);
      T.check(
        'debt over ninety days grades worse than debt from last month',
        ancient.score < recent.score,
        `${ancient.score} vs ${recent.score}`
      );
      T.check(
        'and the ageing component is what moved',
        ancient.components.find(c => c.key === 'ageing').score < recent.components.find(c => c.key === 'ageing').score
      );
    }

    {
      // A property that billed and was paid in full has no arrears. That is a
      // full ageing score, stated — not a dropped component, or a property with
      // no debt would be graded only where it can lose.
      const r = health([villa()], [charge()], [payment()], [expense()]);
      const ageing = r.components.find(c => c.key === 'ageing');
      T.check('no arrears is a full ageing score, and is said out loud', ageing && ageing.score === 100, JSON.stringify(ageing));
      T.check('and it says so in words', ageing.detail.includes('nothing is outstanding'), ageing.detail);
    }

    /* ---------------- currencies never mix ---------------- */
    {
      const units = [villa()];
      const charges = [charge({ currency: 'JMD' })];
      const payments = [payment({ currency: 'JMD' })];
      const expenses = [expense({ currency: 'USD', amount: 900000 })];

      const jmd = health(units, charges, payments, expenses, 'JMD');
      // The huge USD cost must not reach the JMD grade at all.
      T.check(
        'a cost in the other currency never reaches this currency’s grade',
        jmd.components.find(c => c.key === 'coverage') === undefined,
        JSON.stringify(jmd.components)
      );
      const cash = jmd.components.find(c => c.key === 'cash');
      T.check('nor its cash position', cash.detail.includes('0.00 spent'), cash.detail);
    }

    /* ---------------- the boundaries ---------------- */
    {
      T.check('the grade boundaries are stated in one place', gradeFor(100) === 'A' && gradeFor(85) === 'A');
      T.check('and step down in order', gradeFor(84.99) === 'B' && gradeFor(69) === 'C' && gradeFor(54) === 'D' && gradeFor(0) === 'E');
      T.check('a perfect property grades A', health([villa()], [charge({ amount: 200000 })], [payment({ amount: 200000 })], [expense({ amount: 20000 })]).grade === 'A');
      T.check(
        'and one collecting nothing while spending heavily does not',
        ['D', 'E'].includes(health([villa()], [charge()], [], [expense({ amount: 500000 })]).grade),
        health([villa()], [charge()], [], [expense({ amount: 500000 })]).grade
      );
    }

    /* ---------------- nothing here is ever NaN ---------------- */
    {
      const cases = [
        health([], [], [], []),
        health([villa()], [], [], [expense()]),
        health([villa()], [charge()], [], []),
        health([villa({ monthlyMaintenance: 0 })], [charge()], [payment()], [expense()])
      ];
      T.check(
        'no case produces a non-finite score',
        cases.every(r => r === null || (Number.isFinite(r.score) && r.components.every(c => Number.isFinite(c.score) && Number.isFinite(c.weight)))),
        JSON.stringify(cases.map(c => c && c.score))
      );
    }

    /* ------------------------------------------------------------------ *
     * Switching it off
     *
     * Ro asked to be able to turn the grade off. The setting is stored as
     * `hidePropertyHealth` — the negative — deliberately: databases already
     * exist that were written before this field, and a missing value must mean
     * *shown*, or upgrading would silently remove the card from the dashboard
     * of every live installation.
     * ------------------------------------------------------------------ */
    {
      const srv = await startServer({ port, adminPassword: 'Health-Pass-1234!', projectRoot });
      try {
        const c = makeClient(srv.baseUrl);
        await activateAdmin(c, 'Health-Pass-1234!', 'Health-New-1234!');

        const fresh = (await c.get('/api/db')).body.settings;
        T.check(
          'a database that has never been told about this shows the grade',
          fresh.hidePropertyHealth !== true,
          String(fresh.hidePropertyHealth)
        );

        const off = await c.post('/api/settings', { hidePropertyHealth: true });
        T.check('it can be switched off', off.status === 200, String(off.status));
        T.check('and stays off when the records are read back', (await c.get('/api/db')).body.settings.hidePropertyHealth === true);

        const on = await c.post('/api/settings', { hidePropertyHealth: false });
        T.check('and switched on again', on.status === 200 && (await c.get('/api/db')).body.settings.hidePropertyHealth === false);

        // Saving anything else on the General panel must not disturb it.
        await c.post('/api/settings', { hidePropertyHealth: true });
        await c.post('/api/settings', { fxRateJmdPerUsd: 158.5 });
        T.check(
          'saving an unrelated setting leaves the choice alone',
          (await c.get('/api/db')).body.settings.hidePropertyHealth === true
        );

        // Only a real boolean turns it off — a stray string must not.
        await c.post('/api/settings', { hidePropertyHealth: 'no' });
        T.check(
          'and only a genuine yes turns it off, never a stray value',
          (await c.get('/api/db')).body.settings.hidePropertyHealth === false,
          String((await c.get('/api/db')).body.settings.hidePropertyHealth)
        );
      } finally {
        await srv.stop();
      }
    }

    return T.done();
  } finally {
    cleanup();
  }
}
