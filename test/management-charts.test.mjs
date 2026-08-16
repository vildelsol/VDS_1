/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The figures behind the management charts.
 *
 * Two things are being defended here.
 *
 * **Arrears ageing must agree with the statutory return.** The board chart and
 * Form 13B now bucket debt through one function, `ageAccountArrears`. The
 * invariant it inherits is the form's: only the *uncovered remainder* of a
 * part-paid charge is aged, so the four columns total the outstanding balance
 * exactly. A chart that ages debt differently from the return filed on the same
 * data is a chart that will be quoted against the corporation.
 *
 * **Occupancy must be historical.** `isOccupied` reads `unit.status`, a current
 * flag with no history — asking it about last March returns today's answer. The
 * series is therefore reconstructed from tenancy and booking dates, and the
 * tests pin the consequences of that: an ended tenancy still occupied its villa
 * back then, and a calendar block is not a guest.
 *
 * Uses the real `src/lib/finance.ts` rather than a copy of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Management charts (ageing & occupancy)';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-charts-'));
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

/** A fixed reporting date, so ageing is arithmetic rather than a moving target. */
const AS_OF = '2026-03-31';

/** A due date exactly `days` before the reporting date. */
function due(days) {
  const d = new Date(Date.UTC(2026, 2, 31));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const villa = (over = {}) => ({
  id: 'unit-1',
  number: '1',
  ownerName: 'Owner',
  ownerEmail: '',
  ownerPhone: '',
  tenantName: '',
  tenantEmail: '',
  tenantPhone: '',
  status: 'long-term',
  monthlyRent: 50000,
  monthlyMaintenance: 10000,
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
  periodMonth: '2026-01',
  dueDate: due(15),
  amount: 10000,
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
  amount: 10000,
  currency: 'JMD',
  date: due(10),
  status: 'completed',
  payerName: 'Owner',
  method: 'Cash',
  receiptNo: 'R1',
  ...over
});

const tenancy = (over = {}) => ({
  id: `t-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-1',
  unitNumber: '1',
  tenantName: 'Tenant',
  tenantEmail: '',
  tenantPhone: '',
  emergencyName: '',
  emergencyPhone: '',
  emergencyEmail: '',
  monthlyRent: 50000,
  currency: 'JMD',
  rentDueDay: 1,
  startedOn: '2026-01-01',
  status: 'active',
  recordedBy: 'test',
  recordedAt: '',
  ...over
});

const booking = (over = {}) => ({
  id: `b-${Math.random().toString(16).slice(2)}`,
  unitId: 'unit-2',
  unitNumber: '2',
  guestName: 'Guest',
  checkIn: '2026-03-10',
  checkOut: '2026-03-20',
  status: 'confirmed',
  source: 'Direct',
  amount: 1000,
  currency: 'USD',
  depositPaid: 0,
  balanceDue: 0,
  ...over
});

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadFinance(projectRoot);
  try {
    /* ---------------- ageing agrees with the return ---------------- */

    const units = [villa({ monthlyRent: 0 })];

    const aged = mod.arrearsAgeing(
      units,
      [
        charge({ dueDate: due(10), amount: 1000 }), // within 30
        charge({ dueDate: due(45), amount: 2000 }), // 31–60
        charge({ dueDate: due(75), amount: 3000 }), // 61–90
        charge({ dueDate: due(200), amount: 4000 }) // over 90
      ],
      [],
      AS_OF
    );
    const jmd = aged.find(a => a.currency === 'JMD');
    T.check('debt lands in the bucket matching its age', !!jmd && jmd.buckets.d30 === 1000 && jmd.buckets.d60 === 2000 && jmd.buckets.d90 === 3000 && jmd.buckets.over90 === 4000, JSON.stringify(jmd?.buckets));
    T.check('and the buckets total the outstanding balance', jmd?.buckets.total === 10000, String(jmd?.buckets.total));

    // The invariant the statutory return is built on, restated for the chart.
    const partial = mod.arrearsAgeing(
      units,
      [charge({ dueDate: due(200), amount: 10000 })],
      [payment({ amount: 6000, date: due(5) })],
      AS_OF
    );
    const partialJmd = partial.find(a => a.currency === 'JMD');
    T.check(
      'a part-paid charge ages only the remainder it still owes',
      partialJmd?.buckets.over90 === 4000 && partialJmd?.buckets.total === 4000,
      JSON.stringify(partialJmd?.buckets)
    );

    // The chart and the return must never disagree about the same debt.
    const viaForm = mod.form13BContributions(units, [charge({ dueDate: due(200), amount: 10000 })], [payment({ amount: 6000, date: due(5) })], AS_OF);
    T.check(
      'and the chart buckets that debt exactly as Form 13B does',
      viaForm.totalsByCurrency[0]?.buckets.over90 === partialJmd?.buckets.over90,
      `form ${viaForm.totalsByCurrency[0]?.buckets.over90} vs chart ${partialJmd?.buckets.over90}`
    );

    T.check('a settled account contributes no ageing at all', mod.arrearsAgeing(units, [charge({ amount: 10000 })], [payment({ amount: 10000 })], AS_OF).length === 0);
    T.check('and neither does an account in credit', mod.arrearsAgeing(units, [charge({ amount: 10000 })], [payment({ amount: 15000 })], AS_OF).length === 0);

    /* ---------------- rent is aged too, unlike the 13B ---------------- */

    const rentUnits = [villa({ monthlyRent: 50000, monthlyMaintenance: 0 })];
    const rentAged = mod.arrearsAgeing(rentUnits, [charge({ category: 'Rent', currency: 'JMD', amount: 50000, dueDate: due(40) })], [], AS_OF);
    T.check(
      'unpaid rent ages into the management view, which the maintenance-only return excludes',
      rentAged.find(a => a.currency === 'JMD')?.buckets.d60 === 50000,
      JSON.stringify(rentAged)
    );

    /* ---------------- currencies stay apart ---------------- */

    const mixed = mod.arrearsAgeing(
      [villa({ id: 'unit-1', number: '1', monthlyRent: 0, maintCurrency: 'JMD' }), villa({ id: 'unit-2', number: '2', monthlyRent: 0, maintCurrency: 'USD' })],
      [
        charge({ unitId: 'unit-1', unitNumber: '1', currency: 'JMD', amount: 10000, dueDate: due(10) }),
        charge({ unitId: 'unit-2', unitNumber: '2', currency: 'USD', amount: 500, dueDate: due(10) })
      ],
      [],
      AS_OF
    );
    T.check('each currency is aged on its own and never combined', mixed.length === 2 && mixed.every(m => m.buckets.total > 0), JSON.stringify(mixed));

    /* ---------------- occupancy is read from dates, not status ---------------- */

    const twoVillas = [villa({ id: 'unit-1', number: '1' }), villa({ id: 'unit-2', number: '2', status: 'short-term' })];

    const during = mod.occupiedUnitIdsOn(twoVillas, [tenancy({ startedOn: '2026-01-01' })], [], '2026-02-15');
    T.check('a villa under tenancy is occupied on a day inside the term', during.has('unit-1'), [...during].join(','));

    const before = mod.occupiedUnitIdsOn(twoVillas, [tenancy({ startedOn: '2026-01-01' })], [], '2025-12-31');
    T.check('and is not occupied the day before the tenancy began', !before.has('unit-1'), [...before].join(','));

    // The point of reading dates rather than `status`: history stays true.
    const ended = [tenancy({ startedOn: '2026-01-01', endedOn: '2026-02-01', status: 'ended' })];
    T.check('an ended tenancy still occupied its villa while it ran', mod.occupiedUnitIdsOn(twoVillas, ended, [], '2026-01-15').has('unit-1'));
    T.check('and stopped occupying it on the day it ended', !mod.occupiedUnitIdsOn(twoVillas, ended, [], '2026-02-01').has('unit-1'));

    /* ---------------- guests count, calendar holds do not ---------------- */

    T.check('a guest in residence occupies the villa that night', mod.occupiedUnitIdsOn(twoVillas, [], [booking()], '2026-03-12').has('unit-2'));
    T.check('the departure night is already free', !mod.occupiedUnitIdsOn(twoVillas, [], [booking()], '2026-03-20').has('unit-2'));
    T.check('a cancelled stay never occupied anything', !mod.occupiedUnitIdsOn(twoVillas, [], [booking({ status: 'cancelled' })], '2026-03-12').has('unit-2'));
    T.check(
      'a calendar block is not a guest and is not counted as occupancy',
      !mod.occupiedUnitIdsOn(twoVillas, [], [booking({ source: 'Blocked' })], '2026-03-12').has('unit-2'),
      'Blocked'
    );
    T.check('nor is an Unavailable hold', !mod.occupiedUnitIdsOn(twoVillas, [], [booking({ source: 'Unavailable' })], '2026-03-12').has('unit-2'));

    /* ---------------- the documented limitation, pinned ---------------- */

    /*
     * An owner-occupied villa is physically occupied and files neither a tenancy
     * nor a booking, so it is not counted here. That is a deliberate consequence
     * of reading occupancy from dated records rather than from `unit.status`,
     * and it is stated on the chart itself.
     *
     * Pinned so the day someone decides let-occupancy should include owner
     * occupiers, they change this test on purpose rather than discovering the
     * figure moved. The two measures differ by exactly the owner-occupied lots.
     */
    const withOwnerOccupier = [villa({ id: 'unit-1', number: '1' }), villa({ id: 'unit-9', number: '9', status: 'owner-occupied' })];
    const letOnly = mod.occupiedUnitIdsOn(withOwnerOccupier, [tenancy({ unitId: 'unit-1' })], [], '2026-02-15');
    T.check('an owner-occupied villa is not counted as let, having neither tenancy nor booking', !letOnly.has('unit-9'), [...letOnly].join(','));
    T.check('so let occupancy and physical occupancy differ by the owner-occupied lots', letOnly.size === 1 && mod.isOccupied(withOwnerOccupier[1]) === true);

    /* ---------------- a record for a villa off the register ---------------- */

    T.check(
      'a tenancy pointing at a villa no longer on the register cannot inflate occupancy',
      mod.occupiedUnitIdsOn([villa({ id: 'unit-1', number: '1' })], [tenancy({ unitId: 'ghost' })], [], '2026-02-15').size === 0
    );

    /* ---------------- the migration cutover ---------------- */

    /*
     * A property moving onto this system in September brings tenants who have
     * been in place for years. Their tenancies carry their real start dates,
     * because that is the truth and lease dates depend on it — but no charge
     * exists here for any month before the cutover, since those were billed in
     * whatever system came before.
     *
     * Without a cutover date the unbilled-months check reads that absence as
     * dozens of months of rent nobody billed, per tenant, and buries every real
     * alert on the first day of use. With one, it stays silent about the period
     * it was not keeping — and stays loud about everything after it.
     */
    const migrated = [villa({ id: 'unit-1', number: '1', monthlyRent: 50000 })];
    const longStanding = [tenancy({ unitId: 'unit-1', startedOn: '2024-01-01' })];

    const withoutCutover = mod.unbilledOccupancy(migrated, longStanding, [], '2026-03-31');
    T.check(
      'without a cutover, every month back to the tenancy start is called unbilled',
      withoutCutover[0]?.months.length > 20,
      `${withoutCutover[0]?.months.length ?? 0} months flagged`
    );

    const withCutover = mod.unbilledOccupancy(migrated, longStanding, [], '2026-03-31', '2026-01-01');
    T.check(
      'with a cutover, the months before it are not the application\'s to call unbilled',
      withCutover[0]?.months.every(m => m >= '2026-01'),
      JSON.stringify(withCutover[0]?.months)
    );
    T.check(
      'and the months after it are still reported',
      withCutover[0]?.months.length === 3,
      `${withCutover[0]?.months.length ?? 0} months (expected Jan, Feb, Mar)`
    );

    // The cutover must not become a way to hide a month that really was missed.
    const billedJan = [charge({ unitId: 'unit-1', category: 'Rent', periodMonth: '2026-01', currency: 'JMD', amount: 50000 })];
    const stillMissing = mod.unbilledOccupancy(migrated, longStanding, billedJan, '2026-03-31', '2026-01-01');
    T.check(
      'a month after the cutover that was genuinely never billed is still reported',
      stillMissing[0]?.months.includes('2026-02'),
      JSON.stringify(stillMissing[0]?.months)
    );

    /* ---------------- the series ---------------- */

    const series = mod.occupancySeries(twoVillas, [tenancy({ startedOn: '2026-01-01' })], [], ['2026-01', '2026-02'], AS_OF);
    T.check('the series samples one month per entry', series.length === 2, `${series.length} entries`);
    T.check('and reports occupancy as a share of the whole register', series[0].occupied === 1 && series[0].total === 2 && series[0].rate === 50, JSON.stringify(series[0]));

    // A month end past the reporting date would otherwise read as an empty month.
    const capped = mod.occupancySeries(twoVillas, [tenancy({ startedOn: '2026-01-01' })], [], ['2026-03'], '2026-03-15');
    T.check('a part-elapsed month is sampled at the reporting date, not its month end', capped[0].occupied === 1, JSON.stringify(capped[0]));

    const empty = mod.occupancySeries([], [], [], ['2026-01'], AS_OF);
    T.check('an empty register reports no rate rather than dividing by zero', empty[0].rate === null, JSON.stringify(empty[0]));
  } finally {
    cleanup();
  }

  return T.done();
}
