/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The maintenance levy, dated (src/lib/feeSchedule.ts).
 *
 * Ro, 2026-11-18: the levy rises from J$20,000 to J$27,000 on 1 January 2027;
 * the two US-dollar villas stay at US$125. Before this a villa held one levy
 * figure, a charge took whatever it was when raised, and the projection
 * forecast January to May at the old figure.
 *
 * Holds the application to:
 *   1. The literal case: December bills J$20,000, January J$27,000 (calendar,
 *      rent split), the USD villa US$125 throughout. Pure, pinned dates.
 *   2. Manual Post month and automatic billing bill each month at the levy in
 *      force for it (relative months: the server will not post the future).
 *   3. The projection reads each forecast month's levy.
 *   4. Posted charges are never changed; a change into a posted or closed month,
 *      a bad month, amount or currency, and a duplicate are refused by code.
 *   5. A villa with no schedule behaves exactly as before.
 *   6. Every add and remove is in the audit trail with old and new values.
 *   7. Integrity reports a charge that disagrees with the schedule (warning).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday, makeLongTermUnit } from './harness.mjs';

export const title = 'Fee schedule: the levy follows its effective date';

const PASS = 'Str0ng-Pass!2026';
const TODAY = localToday();

function monthShift(delta) {
  const [y, m] = TODAY.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function loadLib(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fee-'));
  const outfile = path.join(dir, 'lib.mjs');
  await build({
    stdin: {
      contents:
        "export * as fee from './src/lib/feeSchedule'; export * as cal from './src/lib/billingCalendar'; " +
        "export * as fin from './src/lib/finance'; export * as proj from './src/lib/projection';",
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
  return { ...mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const unit = over => ({
  id: 'u1',
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

const ordinary = (db, unitId, category) =>
  db.charges.filter(c => c.unitId === unitId && c.category === category && c.status === 'open' && !c.kind && !c.oneOffType);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { fee, cal, fin, proj, cleanup } = await loadLib(projectRoot);
  const dirs = [];

  try {
    /* ------------------------------------------------------------ *
     * 1. The literal case, pure and pinned.
     * ------------------------------------------------------------ */
    const jmd = unit({ id: 'u3', number: '3', maintenanceSchedule: [{ effectiveFrom: '2027-01', amount: 27000, currency: 'JMD' }] });
    const usd = unit({ id: 'u4', number: '4', monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD' });
    const let1 = unit({
      id: 'u1',
      number: '1',
      status: 'long-term',
      tenantName: 'Tenant',
      monthlyRent: 75000,
      maintenanceSchedule: [{ effectiveFrom: '2027-01', amount: 27000, currency: 'JMD' }]
    });
    T.check('levy: December 2026 at J$20,000', fee.levyForMonth(jmd, '2026-12') === 20000, String(fee.levyForMonth(jmd, '2026-12')));
    T.check('levy: January 2027 at J$27,000', fee.levyForMonth(jmd, '2027-01') === 27000, String(fee.levyForMonth(jmd, '2027-01')));
    T.check('levy: May 2027 still J$27,000', fee.levyForMonth(jmd, '2027-05') === 27000);
    T.check('chargeAmount for a month reads the schedule', fin.chargeAmount(jmd, 'Maintenance', '2026-12') === 20000 && fin.chargeAmount(jmd, 'Maintenance', '2027-01') === 27000);

    const nov = { id: 'c-nov', unitId: 'u3', unitNumber: '3', category: 'Maintenance', periodMonth: '2026-11', dueDate: '2026-11-01', amount: 20000, currency: 'JMD', status: 'open', payerName: 'Owner', createdAt: '2026-11-01T00:00:00Z', createdBy: 'x' };
    const novUsd = { ...nov, id: 'c-nov-usd', unitId: 'u4', unitNumber: '4', amount: 125, currency: 'USD' };
    const backlog = cal.billingBacklog([jmd, usd], [], [nov, novUsd], '2027-01-15');
    const at = (u, m) => backlog.find(b => b.unit.id === u && b.month === m && b.category === 'Maintenance')?.amount;
    T.check('calendar: December owed at J$20,000 even when billed in January', at('u3', '2026-12') === 20000, JSON.stringify(backlog.map(b => [b.unit.id, b.month, b.amount])));
    T.check('calendar: January owed at J$27,000', at('u3', '2027-01') === 27000);
    T.check('calendar: the USD villa stays US$125 both months', at('u4', '2026-12') === 125 && at('u4', '2027-01') === 125);

    const dec = fin.rentBreakdown(let1, 75000, 'JMD', '2026-12');
    const jan = fin.rentBreakdown(let1, 75000, 'JMD', '2027-01');
    T.check('rent split: December takes J$20,000 out of J$75,000', dec.total === 75000 && dec.maintenance === 20000 && dec.rent === 55000, JSON.stringify(dec));
    T.check('rent split: January takes J$27,000, the tenant still pays J$75,000', jan.total === 75000 && jan.maintenance === 27000 && jan.rent === 48000, JSON.stringify(jan));

    // Legacy: no schedule means the standing figure, every month, to the cent.
    const legacy = unit({ id: 'u9', monthlyMaintenance: 18500.5 });
    T.check(
      'legacy: a villa with no schedule bills its standing figure in every month',
      ['2020-01', '2026-12', '2027-01', '2031-07'].every(m => fin.chargeAmount(legacy, 'Maintenance', m) === 18500.5) && fin.chargeAmount(legacy, 'Maintenance') === 18500.5
    );
    T.check('legacy: no schedule field is invented', !('maintenanceSchedule' in legacy) && fee.levySchedule(legacy).length === 0);
    T.check('a change in another currency is never billed', fee.levyForMonth(unit({ maintenanceSchedule: [{ effectiveFrom: '2027-01', amount: 27000, currency: 'USD' }] }), '2027-02') === 20000);

    /* ------------------------------------------------------------ *
     * 3. The projection reads each forecast month (relative months).
     * ------------------------------------------------------------ */
    const window = { from: `${monthShift(-3)}-01`, to: `${monthShift(-1)}-28`, months: 3 };
    const riseNext = unit({ id: 'p1', maintenanceSchedule: [{ effectiveFrom: monthShift(1), amount: 27000, currency: 'JMD' }] });
    const riseLater = unit({ id: 'p2', maintenanceSchedule: [{ effectiveFrom: monthShift(3), amount: 27000, currency: 'JMD' }] });
    const p1 = proj.buildProjection('JMD', [riseNext], [], [], [], window, 5);
    T.check(
      'projection: a rise from next month forecasts every one of the five months at J$27,000',
      p1.forecast.length === 5 && p1.forecast.every(f => f.income === 27000),
      JSON.stringify(p1.forecast.map(f => [f.month, f.income]))
    );
    T.check('projection: horizon income is the sum of the months', p1.horizonIncome === 135000, String(p1.horizonIncome));
    T.check('projection: the current assessment is still the current levy', p1.contractedMonthly === 20000, String(p1.contractedMonthly));
    const p2 = proj.buildProjection('JMD', [riseLater], [], [], [], window, 5);
    T.check(
      'projection: a rise in month 3 forecasts 20,000, 20,000 then 27,000',
      p2.forecast.map(f => f.income).join(',') === '20000,20000,27000,27000,27000',
      p2.forecast.map(f => f.income).join(',')
    );
    T.check('projection: the change is named for the narrative', p2.assessmentChanges.length === 1 && p2.assessmentChanges[0].month === monthShift(3));
    const pl = proj.buildProjection('JMD', [legacy], [], [], [], window, 5);
    T.check(
      'legacy projection: flat at the standing figure, horizon = monthly x months',
      pl.forecast.every(f => f.income === 18500.5) && pl.horizonIncome === 92502.5 && pl.assessmentChanges.length === 0,
      JSON.stringify([pl.horizonIncome, pl.forecast.map(f => f.income)])
    );

    // The owners' annual report for a year with no charges uses each month's levy.
    const yr = Number(monthShift(0).slice(0, 4)) - 1; // a whole past year, no booksBeginOn: 12 months
    const yearRise = unit({ id: 'a1', maintenanceSchedule: [{ effectiveFrom: `${yr}-07`, amount: 27000, currency: 'JMD' }] });
    const ar = fin.annualOwnersReport([yearRise], [], [], [], 'JMD', yr);
    T.check(
      "annual report: a year with no charges assesses 6 x 20,000 + 6 x 27,000",
      ar.contributionsAnnual === 282000,
      String(ar.contributionsAnnual)
    );
    const arLegacy = fin.annualOwnersReport([unit({ id: 'a2' })], [], [], [], 'JMD', yr);
    T.check('legacy annual report: 12 x the standing figure, as before', arLegacy.contributionsAnnual === 240000, String(arLegacy.contributionsAnnual));

    /* ------------------------------------------------------------ *
     * 2, 4, 5, 6. Through the server: manual posting and refusals.
     * ------------------------------------------------------------ */
    const M0 = monthShift(0);
    const M1 = monthShift(-1);
    const M2 = monthShift(-2);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fee-srv-'));
    dirs.push(dataDir);
    let s = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir });
    let c = makeClient(s.baseUrl);
    await activateAdmin(c, 'admin123', PASS);

    const setup = [
      await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'owner-occupied', monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 }),
      await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'owner-occupied', monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 }),
      await makeLongTermUnit(c, 'unit-1', { monthlyRent: 75000, monthlyMaintenance: 20000 })
    ];
    T.check('setup: villas configured', setup.every(r => r.status === 200), setup.map(r => r.status).join(','));
    const posted2 = await c.post('/api/charges/post-month', { monthString: M2 });
    T.check('setup: oldest month posted by hand', posted2.status === 200 && posted2.body.created >= 4, JSON.stringify(posted2.body));
    let db = (await c.get('/api/db')).body;
    const pastSnapshot = JSON.stringify(db.charges.filter(x => x.periodMonth === M2).map(x => [x.id, x.amount, x.rentPortion, x.maintenancePortion, x.status]));

    const code = r => r.body && r.body.code;
    const add = (id, body) => c.post(`/api/units/${id}/fee-schedule`, body);

    let r = await add('unit-3', { effectiveFrom: M2, amount: 27000, currency: 'JMD' });
    T.check('refused: a change dated into a posted month (FEE_MONTH_POSTED)', r.status === 400 && code(r) === 'FEE_MONTH_POSTED', JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: '2027-13', amount: 27000, currency: 'JMD' });
    T.check('refused: a month that is not YYYY-MM (FEE_MONTH_FORMAT)', r.status === 400 && code(r) === 'FEE_MONTH_FORMAT', JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: 'January', amount: 27000, currency: 'JMD' });
    T.check('refused: a month given in words (FEE_MONTH_FORMAT)', r.status === 400 && code(r) === 'FEE_MONTH_FORMAT', JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: M0, amount: 0, currency: 'JMD' });
    T.check('refused: a zero levy (FEE_AMOUNT_INVALID)', r.status === 400 && code(r) === 'FEE_AMOUNT_INVALID', JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: M0, amount: -27000, currency: 'JMD' });
    T.check('refused: a negative levy (FEE_AMOUNT_INVALID)', r.status === 400 && code(r) === 'FEE_AMOUNT_INVALID', JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: M0, amount: 27000, currency: 'USD' });
    T.check('refused: a currency the villa is not levied in (FEE_CURRENCY_MISMATCH)', r.status === 400 && code(r) === 'FEE_CURRENCY_MISMATCH', JSON.stringify(r.body));

    db = (await c.get('/api/db')).body;
    T.check('refusals saved nothing', !db.units.find(u => u.id === 'unit-3').maintenanceSchedule);

    // Positive control, then the duplicate.
    r = await add('unit-3', { effectiveFrom: M0, amount: 27000, currency: 'JMD' });
    T.check('a valid dated change is accepted', r.status === 200, JSON.stringify(r.body));
    r = await add('unit-3', { effectiveFrom: M0, amount: 28000, currency: 'JMD' });
    T.check('refused: a second change for the same month (FEE_DUPLICATE_MONTH)', r.status === 400 && code(r) === 'FEE_DUPLICATE_MONTH', JSON.stringify(r.body));

    db = (await c.get('/api/db')).body;
    const addLine = db.auditLogs.find(a => /Added a dated maintenance change to Villa 3/.test(a.action) || (/Added a dated maintenance change/.test(a.action) && a.recordId === 'unit-3'));
    T.check(
      'audit: the add is logged with the old and new maintenance',
      !!addLine && addLine.previousValue === `maintenance from ${M0}: JMD 20000` && addLine.newValue === `maintenance from ${M0}: JMD 27000`,
      JSON.stringify(addLine)
    );

    // Remove (audited), then enter the rise property-wide.
    r = await c.del(`/api/units/unit-3/fee-schedule/${M0}`);
    T.check('a dated change not yet billed can be removed', r.status === 200, JSON.stringify(r.body));
    db = (await c.get('/api/db')).body;
    const removeLine = db.auditLogs.find(a => /Removed the dated maintenance change/.test(a.action) && a.recordId === 'unit-3');
    T.check(
      'audit: the removal is logged with the old and new maintenance',
      !!removeLine && removeLine.previousValue === `maintenance from ${M0}: JMD 27000` && removeLine.newValue === `maintenance from ${M0}: JMD 20000`,
      JSON.stringify(removeLine)
    );
    r = await c.del(`/api/units/unit-3/fee-schedule/${M0}`);
    T.check('refused: removing a change that is not there (FEE_ENTRY_NOT_FOUND)', r.status === 404 && code(r) === 'FEE_ENTRY_NOT_FOUND', JSON.stringify(r.body));

    r = await c.post('/api/fee-schedule', { effectiveFrom: M0, amount: 27000, currency: 'JMD' });
    T.check(
      'property-wide: the rise is written to every villa levied in J$, and not to the US$ villa',
      r.status === 200 && [...r.body.villas].sort().join(',') === '1,3',
      JSON.stringify(r.body)
    );
    db = (await c.get('/api/db')).body;
    T.check('legacy: the US$ villa carries no schedule at all', !('maintenanceSchedule' in db.units.find(u => u.id === 'unit-4')));
    T.check(
      'audit: one line per villa for the property-wide change',
      db.auditLogs.filter(a => /Added a dated maintenance change/.test(a.action) && a.newValue === `maintenance from ${M0}: JMD 27000`).length === 3,
      String(db.auditLogs.filter(a => /Added a dated maintenance change/.test(a.action)).length)
    );

    // The standing figure is no longer what is billed, so editing it is refused.
    r = await c.put('/api/units/unit-3', { monthlyMaintenance: 30000 });
    T.check('refused: editing the standing levy once a schedule governs (FEE_SCHEDULE_GOVERNS)', r.status === 400 && code(r) === 'FEE_SCHEDULE_GOVERNS', JSON.stringify(r.body));
    r = await c.put('/api/units/unit-3', { monthlyMaintenance: 20000, notes: 'still editable' });
    T.check('an ordinary edit that leaves the levy alone still saves', r.status === 200, JSON.stringify(r.body));
    r = await c.put('/api/units/unit-3', { maintCurrency: 'USD', currencyChangeIntent: 'void-open-charges' });
    T.check('refused: moving the levy currency under a J$ schedule (FEE_CURRENCY_MISMATCH)', r.status === 400 && code(r) === 'FEE_CURRENCY_MISMATCH', JSON.stringify(r.body));

    // Manual posting: the month before the change at 20,000, the change month at 27,000.
    const p1r = await c.post('/api/charges/post-month', { monthString: M1 });
    const p0r = await c.post('/api/charges/post-month', { monthString: M0 });
    T.check('manual posting succeeded', p1r.status === 200 && p0r.status === 200, JSON.stringify([p1r.body, p0r.body]));
    db = (await c.get('/api/db')).body;
    const lev = (id, m) => ordinary(db, id, 'Maintenance').find(x => x.periodMonth === m);
    const rent = m => ordinary(db, 'unit-1', 'Rent').find(x => x.periodMonth === m);
    T.check('manual: the month before the rise billed J$20,000', lev('unit-3', M1)?.amount === 20000, JSON.stringify(lev('unit-3', M1)));
    T.check('manual: the month of the rise billed J$27,000', lev('unit-3', M0)?.amount === 27000, JSON.stringify(lev('unit-3', M0)));
    T.check('manual: the US$ villa billed US$125 both months', lev('unit-4', M1)?.amount === 125 && lev('unit-4', M0)?.amount === 125 && lev('unit-4', M0)?.currency === 'USD');
    T.check(
      'manual: the let villa\'s rent keeps its total and takes the new levy out of it',
      rent(M1)?.amount === 75000 && rent(M1)?.maintenancePortion === 20000 && rent(M0)?.amount === 75000 && rent(M0)?.maintenancePortion === 27000 && rent(M0)?.rentPortion === 48000,
      JSON.stringify([rent(M1), rent(M0)])
    );
    T.check(
      'past charges untouched: the month posted before the schedule is byte-for-byte the same',
      JSON.stringify(db.charges.filter(x => x.periodMonth === M2).map(x => [x.id, x.amount, x.rentPortion, x.maintenancePortion, x.status])) === pastSnapshot
    );

    // Now the month is posted, the change cannot be withdrawn or another dated into it.
    r = await c.del(`/api/units/unit-3/fee-schedule/${M0}`);
    T.check('refused: removing a change whose month is posted (FEE_MONTH_POSTED)', r.status === 400 && code(r) === 'FEE_MONTH_POSTED', JSON.stringify(r.body));
    r = await add('unit-4', { effectiveFrom: M1, amount: 150, currency: 'USD' });
    T.check('refused: a US$ change dated into a posted month (FEE_MONTH_POSTED)', r.status === 400 && code(r) === 'FEE_MONTH_POSTED', JSON.stringify(r.body));

    // A closed month is refused by its own code, ahead of the posted test.
    const closed = await c.post('/api/periods/close', { through: M2, reason: 'month end', confirmWithFaults: true });
    T.check('setup: books closed through the oldest month', closed.status === 200, JSON.stringify(closed.body));
    r = await add('unit-4', { effectiveFrom: M2, amount: 150, currency: 'USD' });
    T.check('refused: a change dated into a closed month (FEE_MONTH_CLOSED)', r.status === 400 && code(r) === 'FEE_MONTH_CLOSED', JSON.stringify(r.body));

    // A future change for the US$ villa is fine, and shows as upcoming.
    r = await add('unit-4', { effectiveFrom: monthShift(2), amount: 150, currency: 'USD' });
    T.check('a future US$ change is accepted', r.status === 200, JSON.stringify(r.body));

    let integ = (await c.get('/api/integrity')).body;
    T.check(
      'integrity: a schedule that agrees with the ledger raises no fee finding',
      !integ.findings.some(f => f.code === 'levy-differs-from-schedule' || f.code === 'fee-schedule-malformed'),
      JSON.stringify(integ.findings.map(f => f.code))
    );
    await s.stop();

    // Integrity: a charge whose levy disagrees with the schedule (edited outside the app).
    const file = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tampered = raw.charges.find(x => x.unitId === 'unit-3' && x.category === 'Maintenance' && x.periodMonth === M0 && x.status === 'open');
    tampered.amount = 26000;
    fs.writeFileSync(file, JSON.stringify(raw));
    s = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir });
    c = makeClient(s.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
    integ = (await c.get('/api/integrity')).body;
    const finding = integ.findings.find(f => f.code === 'levy-differs-from-schedule');
    T.check(
      'integrity: the off-schedule charge is reported, as a warning',
      !!finding && finding.severity === 'warning' && finding.records.some(x => x.includes(tampered.id)),
      JSON.stringify(integ.findings.map(f => [f.code, f.severity]))
    );
    const still = await c.put('/api/units/unit-5', { number: '5', ownerName: 'Owner Five', status: 'owner-occupied', monthlyMaintenance: 9000, currency: 'JMD', maintCurrency: 'JMD' });
    T.check('integrity: the finding does not block other writes', still.status === 200, JSON.stringify(still.body));
    await s.stop();

    /* ------------------------------------------------------------ *
     * 2b. Automatic billing uses the levy in force for each month.
     * ------------------------------------------------------------ */
    const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fee-auto-'));
    dirs.push(autoDir);
    s = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir: autoDir });
    c = makeClient(s.baseUrl);
    await activateAdmin(c, 'admin123', PASS);
    await c.put('/api/units/unit-3', { number: '3', ownerName: 'Owner Three', status: 'owner-occupied', monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1 });
    await c.put('/api/units/unit-4', { number: '4', ownerName: 'Owner Four', status: 'owner-occupied', monthlyMaintenance: 125, currency: 'USD', maintCurrency: 'USD', maintDueDay: 1 });
    const seeded = await c.post('/api/charges/post-month', { monthString: M2 });
    const sched = await c.post('/api/fee-schedule', { effectiveFrom: M0, amount: 27000, currency: 'JMD' });
    T.check('auto setup: oldest month posted and the rise entered', seeded.status === 200 && sched.status === 200, JSON.stringify([seeded.body, sched.body]));
    await s.stop();

    s = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir: autoDir, env: { VDS_AUTO_POST: 'on' } });
    c = makeClient(s.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
    db = (await c.get('/api/db')).body;
    const autoLev = (id, m) => ordinary(db, id, 'Maintenance').find(x => x.periodMonth === m);
    T.check('automatic: the month before the rise billed J$20,000', autoLev('unit-3', M1)?.amount === 20000 && autoLev('unit-3', M1)?.createdBy === 'System', JSON.stringify(autoLev('unit-3', M1)));
    T.check('automatic: the month of the rise billed J$27,000', autoLev('unit-3', M0)?.amount === 27000 && autoLev('unit-3', M0)?.createdBy === 'System', JSON.stringify(autoLev('unit-3', M0)));
    T.check('automatic: the oldest month stays at J$20,000', autoLev('unit-3', M2)?.amount === 20000 && autoLev('unit-3', M2)?.createdBy !== 'System');
    T.check('automatic: the US$ villa billed US$125', autoLev('unit-4', M1)?.amount === 125 && autoLev('unit-4', M0)?.amount === 125);
    await s.stop();
  } catch (err) {
    T.check('fee schedule suite ran to completion', false, String(err && err.stack ? err.stack : err));
  } finally {
    cleanup();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  return T.done();
}
