/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Applying a move-in advance at move-out never rewrites an earlier month.
 *
 * QA simulation, 2026-11-19. A tenant moves in on 15 September paying first and
 * last month (J$160,000), then October and November. At move-out the advance is
 * applied to the final month. `settledFromRent` dated every levy credit the day
 * the RENT arrived, so the 160,000 receipt — which pays September and, through
 * the queue, October — credited October's levy on 15 September: September's ISPO
 * levy paid and strata income jumped J$20,000 -> J$40,000, and November's credit
 * vanished. Once September-October were closed, the move-out itself was refused
 * (409): moving the advance charge out of September changed a sealed month.
 *
 * Fixed: a credit is dated no earlier than the due date of the levy it settles
 * (and no later than today), and an advance whose own month is closed is not
 * moved; it records the month it pays for (`paysForMonth`) instead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Move-out advance: levy credits stay in their own month, closed months untouched';

async function loadFinance(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-advance-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: { contents: `export * as fin from './src/lib/finance';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { fin: mod.fin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const SEP = ['2026-09-01', '2026-09-30'];
const OCT = ['2026-10-01', '2026-10-31'];
const NOV = ['2026-11-01', '2026-11-30'];

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Advance-1234!', projectRoot });
  const T = reporter(title);
  const { fin: F, cleanup } = await loadFinance(projectRoot);
  const setupFailures = [];
  const must = (what, r) => {
    if (!r || r.status >= 400) setupFailures.push(`${what}: ${r?.status} ${JSON.stringify(r?.body)}`);
    return r;
  };

  /* -------- the pure rule, with the date pinned (tests never read the clock) -------- */
  {
    const ch = (id, cat, month, amount, extra = {}) => ({ id, unitId: 'u', unitNumber: 'U', category: cat, periodMonth: month, dueDate: `${month}-01`, amount, currency: 'JMD', status: 'open', payerName: 'T', createdAt: '', createdBy: '', ...extra });
    const rent = (id, month) => ch(id, 'Rent', month, 80000, { rentPortion: 60000, maintenancePortion: 20000 });
    const pay = (id, date, amount) => ({ id, receiptNo: id, payerName: 'T', unitId: 'u', unitNumber: 'U', category: 'Rent', amount, currency: 'JMD', date, method: 'Cash', status: 'completed', staffMember: 'x' });
    const charges = [rent('r9', '2026-09'), rent('r10', '2026-10'), rent('r12', '2026-12'), ch('m9', 'Maintenance', '2026-09', 20000), ch('m10', 'Maintenance', '2026-10', 20000), ch('m12', 'Maintenance', '2026-12', 20000)];
    const d = F.settledFromRent(charges, [pay('p1', '2026-09-15', 160000), pay('p2', '2026-11-10', 80000)], '2026-11-19');
    const at = d.map(x => `${x.amount}@${x.date}`).sort();
    T.check('rent paid in September for September and October credits each levy in its own month', at.includes('20000@2026-09-15') && at.includes('20000@2026-10-01'), JSON.stringify(at));
    T.check('a levy not yet due is credited today, never in the future', at.includes('20000@2026-11-19') && d.every(x => x.date <= '2026-11-19'), JSON.stringify(at));
    T.check('every derived id is unique', new Set(d.map(x => x.id)).size === d.length, JSON.stringify(d.map(x => x.id)));
    T.check('the total credited is unchanged by the dating (60,000)', d.reduce((s, x) => s + x.amount, 0) === 60000);
  }

  const levy = async (c, from, to) => {
    const d = (await c.get('/api/db')).body;
    const settled = [...d.payments, ...F.settledFromRent(d.charges, d.payments)];
    return {
      ispo: F.ispoOperations(d.expenses, settled, d.units, 'JMD', from, to).maintenanceOnOwnVillas,
      strata: F.operatingStatement(settled, d.expenses, d.units, 'JMD', from, to, { book: 'strata' }).totalIncome,
      derived: F.settledFromRent(d.charges, d.payments)
    };
  };

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Advance-1234!', 'AdvanceNew-9876!');
    must('books begin', await c.post('/api/settings', { booksBeginOn: '2026-09-01' }));
    const let_ = (number, tenant) => ({ number, ownerName: 'ISPO', tenantName: tenant, tenantChangeIntent: 'changeover', tenantMovedInOn: '2026-09-15', status: 'long-term', monthlyRent: 80000, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    // C15 moves out while every month is open; C14 after September-October are closed.
    must('C15 let', await c.put('/api/units/unit-15', let_('C15', 'Tenant C15')));
    must('C14 let', await c.put('/api/units/unit-14', let_('C14', 'Tenant C14')));
    for (const m of ['2026-09', '2026-10', '2026-11']) must(`post ${m}`, await c.post('/api/charges/post-month', { monthString: m }));
    for (const [unitId, tenant] of [['unit-15', 'Tenant C15'], ['unit-14', 'Tenant C14']]) {
      must(`${unitId} first+last`, await recordAndConfirmPayment(c, { unitId, category: 'Rent', amount: 160000, currency: 'JMD', payerName: tenant, method: 'Bank Transfer', date: '2026-09-15' }));
      for (const d of ['2026-10-01', '2026-11-01']) must(`${unitId} ${d}`, await recordAndConfirmPayment(c, { unitId, category: 'Rent', amount: 80000, currency: 'JMD', payerName: tenant, method: 'Bank Transfer', date: d }));
    }
    const moveOut = number => c.put(`/api/units/unit-${number.slice(1)}`, { number, ownerName: 'ISPO', tenantName: '', status: 'vacant', monthlyRent: 0, monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', tenantChangeIntent: 'moved-out' });
    const onUnit = (x, unitId) => x.derived.filter(p => p.unitId === unitId);
    const sum = list => list.reduce((s, p) => s + p.amount, 0);
    const inMonth = (list, [a, b]) => sum(list.filter(p => p.date >= a && p.date <= b));

    const before = { sep: await levy(c, ...SEP), oct: await levy(c, ...OCT), nov: await levy(c, ...NOV) };
    T.check('before any move-out: each villa credits J$20,000 levy in each of Sep, Oct, Nov', ['unit-15', 'unit-14'].every(u => [SEP, OCT, NOV].every(m => inMonth(onUnit(before.sep, u), m) === 20000)), JSON.stringify(before.sep.derived.map(p => `${p.unitId} ${p.amount}@${p.date}`)));

    /* -------- open months: the advance moves to the final month -------- */
    const open = await moveOut('C15');
    T.check('C15 moves out with every month open', open.status === 200, JSON.stringify(open.body));
    const afterOpen = await levy(c, ...SEP);
    const c15 = onUnit(afterOpen, 'unit-15');
    T.check('C15: September levy credit stays J$20,000 (was J$40,000)', inMonth(c15, SEP) === 20000, JSON.stringify(c15.map(p => `${p.amount}@${p.date}`)));
    T.check('C15: October keeps its J$20,000, dated when October\'s levy fell due', inMonth(c15, OCT) === 20000 && c15.some(p => p.date === '2026-10-01'), JSON.stringify(c15.map(p => `${p.amount}@${p.date}`)));
    T.check('C15: November\'s levy is credited out of the advance (it used to vanish)', inMonth(c15, NOV) === 20000, JSON.stringify(c15.map(p => `${p.amount}@${p.date}`)));

    /* -------- closed months: the move-out succeeds and changes nothing in them -------- */
    const close = await c.post('/api/periods/close', { through: '2026-10', confirmWithFaults: true });
    T.check('September-October close', close.status === 200, JSON.stringify(close.body));
    const sealed = { sep: await levy(c, ...SEP), oct: await levy(c, ...OCT) };
    const dbBefore = (await c.get('/api/db')).body;
    const advance = dbBefore.charges.find(x => x.unitId === 'unit-14' && x.kind === 'advance-final-month');

    const closed = await moveOut('C14');
    T.check('C14 moves out although its move-in month is closed (it was refused 409)', closed.status === 200, JSON.stringify(closed.body));
    const dbAfter = (await c.get('/api/db')).body;
    const integrity = (await c.get('/api/integrity')).body;
    T.check('the closed period still matches what was closed', !integrity.findings.some(f => f.code === 'closed-period-changed'), JSON.stringify(integrity.findings.map(f => f.code)));
    const adv = dbAfter.charges.find(x => x.id === advance?.id);
    T.check('the advance stays billed where it was, and records the month it pays for', adv && adv.periodMonth === advance.periodMonth && adv.dueDate === advance.dueDate && adv.paysForMonth === '2026-11', JSON.stringify(adv));
    const novFinal = dbAfter.charges.find(x => x.unitId === 'unit-14' && x.category === 'Rent' && x.periodMonth === '2026-11' && x.kind !== 'advance-final-month');
    T.check("the final month's own rent is voided as prepaid", novFinal?.status === 'void', JSON.stringify(novFinal));
    const sepAfter = await levy(c, ...SEP);
    const octAfter = await levy(c, ...OCT);
    T.check('September ISPO levy paid is unchanged by the closed-month move-out', sepAfter.ispo === sealed.sep.ispo, `${sealed.sep.ispo} -> ${sepAfter.ispo}`);
    T.check('September strata income is unchanged', sepAfter.strata === sealed.sep.strata, `${sealed.sep.strata} -> ${sepAfter.strata}`);
    T.check('October ISPO levy paid and strata income are unchanged', octAfter.ispo === sealed.oct.ispo && octAfter.strata === sealed.oct.strata, JSON.stringify({ before: [sealed.oct.ispo, sealed.oct.strata], after: [octAfter.ispo, octAfter.strata] }));
    const c14 = onUnit(sepAfter, 'unit-14');
    T.check('C14: Sep, Oct, Nov each J$20,000 after the move-out', inMonth(c14, SEP) === 20000 && inMonth(c14, OCT) === 20000 && inMonth(c14, NOV) === 20000, JSON.stringify(c14.map(p => `${p.amount}@${p.date}`)));
    T.check('C14: November\'s credit comes from the advance, dated when November\'s levy fell due', c14.some(p => p.date === '2026-11-01' && p.amount === 20000));
    T.check('setup completed without a refused call', setupFailures.length === 0, setupFailures.join(' | '));
  } finally {
    await srv.stop();
    cleanup();
  }
  return T.done();
}
