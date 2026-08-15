/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit entitlement, and whether the levy follows it.
 *
 * Contributions must be levied on proprietors in proportion to their unit
 * entitlement — the share attaching to each lot on the registered strata plan.
 * Before this the register held `monthlyMaintenance` as a typed-in figure with
 * nothing behind it, so the corporation could not show that one villa's levy bore
 * the right relationship to another's. That is precisely what a proprietor asks
 * at an annual general meeting, and "because somebody typed it" is not an answer.
 *
 * Two rules matter more than the arithmetic:
 *
 *   - **A lot with no entitlement recorded is excluded, never treated as zero.**
 *     Treating an unrecorded figure as nothing would quietly redistribute that
 *     lot's whole share across its neighbours and look like a finding.
 *   - **Currencies are pooled separately.** A villa billed for maintenance in USD
 *     is not in the same pool as one billed in JMD, and adding them would invent
 *     a discrepancy that does not exist.
 *
 * Like the statements suite, this bundles the real `src/lib/finance.ts` rather
 * than re-implementing it, so a mirror of the logic cannot pass while the
 * application is wrong. See STRATA_COMPLIANCE.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Unit entitlement';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-entitlement-'));
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

const lot = (over = {}) => ({
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
  monthlyMaintenance: 10000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  meterNumber: '',
  notes: '',
  ...over
});

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Entitle-1234!', projectRoot });
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Entitle-1234!', 'EntitleNew-9876!');

    /* ---------------- the arithmetic ---------------- */

    // Three lots, entitlements 100 / 100 / 200. The third carries half the plan.
    const even = [
      lot({ id: 'unit-1', number: '1', entitlement: 100, monthlyMaintenance: 10000 }),
      lot({ id: 'unit-2', number: '2', entitlement: 100, monthlyMaintenance: 10000 }),
      lot({ id: 'unit-3', number: '3', entitlement: 200, monthlyMaintenance: 20000 })
    ];

    T.check('aggregate entitlement is the sum of the lots', mod.totalEntitlement(even) === 400, String(mod.totalEntitlement(even)));
    T.check('a lot carrying a quarter of the plan reads as a quarter', mod.entitlementShare(even[0], even) === 0.25, String(mod.entitlementShare(even[0], even)));
    T.check('and one carrying half reads as half', mod.entitlementShare(even[2], even) === 0.5, String(mod.entitlementShare(even[2], even)));

    const fair = mod.levyProportionality(even);
    T.check('a levy struck strictly by entitlement shows no variance', fair.every(r => r.variance === 0), fair.map(r => r.variance).join(','));
    T.check('and nothing is flagged', mod.disproportionateLevies(even).length === 0);

    /* ---------------- the finding it exists to surface ---------------- */

    // The same three lots, but the big one has been billed as if it were small.
    // Nothing in the old register could show this; it is exactly the question a
    // proprietor asks at an AGM.
    const skewed = [
      lot({ id: 'unit-1', number: '1', entitlement: 100, monthlyMaintenance: 13333 }),
      lot({ id: 'unit-2', number: '2', entitlement: 100, monthlyMaintenance: 13333 }),
      lot({ id: 'unit-3', number: '3', entitlement: 200, monthlyMaintenance: 13334 })
    ];
    const flagged = mod.disproportionateLevies(skewed);
    T.check('a levy split evenly across unequal lots is flagged', flagged.length === 3, `${flagged.length} flagged`);

    const big = flagged.find(r => r.unit.id === 'unit-3');
    T.check('the large lot is shown as underpaying its share', big.variance < 0, String(big.variance));
    T.check(
      'and the figure it would carry if struck by entitlement is stated',
      big.proportionate === 20000,
      String(big.proportionate)
    );
    const small = flagged.find(r => r.unit.id === 'unit-1');
    T.check('the small lots are shown as carrying more than their share', small.variance > 0, String(small.variance));
    T.check(
      'the worst discrepancy is reported first, so the AGM question is at the top',
      Math.abs(flagged[0].variance) >= Math.abs(flagged[flagged.length - 1].variance)
    );

    // Rounding to sensible money is not unfairness.
    const rounded = [
      lot({ id: 'unit-1', number: '1', entitlement: 100, monthlyMaintenance: 10000 }),
      lot({ id: 'unit-2', number: '2', entitlement: 100, monthlyMaintenance: 10001 })
    ];
    T.check('a rounding difference of a dollar is not reported as unfair', mod.disproportionateLevies(rounded).length === 0);

    /* ---------------- a lot with no entitlement is not a lot worth nothing ---------------- */

    const partial = [
      lot({ id: 'unit-1', number: '1', entitlement: 100, monthlyMaintenance: 10000 }),
      lot({ id: 'unit-2', number: '2', entitlement: 100, monthlyMaintenance: 10000 }),
      lot({ id: 'unit-3', number: '3', monthlyMaintenance: 10000 }) // never recorded
    ];
    T.check('a lot with no entitlement is left out of the total', mod.totalEntitlement(partial) === 200, String(mod.totalEntitlement(partial)));
    T.check('its share is unknown rather than zero', mod.entitlementShare(partial[2], partial) === null, String(mod.entitlementShare(partial[2], partial)));
    T.check(
      'and it does not drag its neighbours into a false discrepancy',
      mod.disproportionateLevies(partial).length === 0,
      mod.disproportionateLevies(partial).map(r => r.unit.number).join(',')
    );

    T.check('with nothing recorded anywhere, a share is unknown, not zero', mod.entitlementShare(lot({ entitlement: 100 }), [lot()]) === null);

    /* ---------------- currencies are pooled separately ---------------- */

    const mixed = [
      lot({ id: 'unit-1', number: '1', entitlement: 100, monthlyMaintenance: 10000, maintCurrency: 'JMD' }),
      lot({ id: 'unit-2', number: '2', entitlement: 100, monthlyMaintenance: 10000, maintCurrency: 'JMD' }),
      lot({ id: 'unit-3', number: '3', entitlement: 100, monthlyMaintenance: 130, maintCurrency: 'USD' })
    ];
    const pooled = mod.levyProportionality(mixed);
    T.check('each lot is compared in the currency it is billed in', pooled.every(r => r.currency === (r.unit.maintCurrency || r.unit.currency)));
    T.check(
      'a lone USD lot is proportionate within its own pool, not against JMD figures',
      pooled.find(r => r.unit.id === 'unit-3').variance === 0,
      String(pooled.find(r => r.unit.id === 'unit-3').variance)
    );
    T.check('and mixing the two invents no discrepancy', mod.disproportionateLevies(mixed).length === 0);

    /* ---------------- what the register will accept ---------------- */

    const save = (over = {}) =>
      c.put('/api/units/unit-1', {
        number: '1',
        ownerName: 'Alba Reid',
        status: 'owner-occupied',
        monthlyRent: 0,
        monthlyMaintenance: 18000,
        currency: 'JMD',
        maintCurrency: 'JMD',
        ...over
      });

    const stored = await save({ entitlement: 125.5, strataLotNumber: 'SP-1042-7' });
    T.check('an entitlement is recorded against the lot', stored.body?.unit?.entitlement === 125.5, String(stored.body?.unit?.entitlement));
    T.check(
      'so is the strata lot number the Commission asks for',
      stored.body?.unit?.strataLotNumber === 'SP-1042-7',
      String(stored.body?.unit?.strataLotNumber)
    );

    T.check('zero is refused — it is not a share', (await save({ entitlement: 0 })).status === 400);
    T.check('so is a negative entitlement', (await save({ entitlement: -5 })).status === 400);
    T.check('so is something that is not a number', (await save({ entitlement: 'a quarter' })).status === 400);
    T.check('and an implausible figure is questioned', (await save({ entitlement: 99_000_000 })).status === 400);

    const untouched = await save({ monthlyMaintenance: 19000 });
    T.check(
      'an edit that does not mention entitlement leaves it alone',
      untouched.body?.unit?.entitlement === 125.5,
      String(untouched.body?.unit?.entitlement)
    );

    const cleared = await save({ entitlement: '' });
    T.check('clearing it is possible, and deliberate', cleared.body?.unit?.entitlement === undefined, String(cleared.body?.unit?.entitlement));

    /* ---------------- it is on the record ---------------- */

    await save({ entitlement: 200 });
    const db = (await c.get('/api/db')).body;
    T.check(
      'changing an entitlement is written to the audit trail',
      db.auditLogs.some(l => /unit entitlement changed/i.test(String(l.newValue) + String(l.action))),
      'no audit entry mentions the entitlement'
    );
  } finally {
    cleanup();
    await srv.stop();
  }

  return T.done();
}
