/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Billing happens whether or not anybody is watching.
 *
 * Ro, 2026-11-18: *"Since you've conferred with me that we dont physically
 * action the levy or the rent, ensure that it operates the way it should without
 * you or i thinking that there's an actual button we see and click."*
 *
 * Before this, every recurring charge in the system existed because a person
 * pressed a button on the Notifications Hub. A skipped month for the maintenance
 * levy was invisible: no screen checked the levy month by month, so the arrears,
 * the projection and the owner statements all agreed that nothing had been owed.
 *
 * The rules this holds the application to:
 *
 *   1. On starting up, the application bills every month the register says is
 *      owed and the ledger does not hold — the levy included, with no tenancy
 *      behind it and nobody at a screen.
 *   2. It says so in the Compliance Log, as the application and not as a person.
 *   3. Running again changes nothing. A month already billed is left alone, and
 *      no month is ever billed twice.
 *   4. An implausibly long backlog is NOT billed. It is reported and left for a
 *      person, because silently raising years of arrears is worse than waiting.
 *   5. A villa whose levy has never been billed is not back-filled to the start
 *      of the books. This application cannot know what such a villa owed.
 *   6. A closed month is never billed into.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, localToday } from './harness.mjs';

export const title = 'Automatic billing: the months post themselves';

const TODAY = localToday();
const PASS = 'Str0ng-Pass!2026';

/** YYYY-MM, `back` months before the current one. */
function monthBack(back) {
  const [y, m] = TODAY.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function loadCalendar(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-cal-'));
  const outfile = path.join(dir, 'cal.mjs');
  await build({
    stdin: { contents: `export * as cal from './src/lib/billingCalendar';`, resolveDir: projectRoot, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { cal: mod.cal, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const levyCharges = (db, unitId) =>
  db.charges.filter(c => c.unitId === unitId && c.category === 'Maintenance' && c.status === 'open' && !c.kind && !c.oneOffType);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { cal, cleanup } = await loadCalendar(projectRoot);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-autobill-'));

  const sessionOn = async (extraEnv = {}) => {
    const s = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir, env: extraEnv });
    const c = makeClient(s.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
    return { s, c };
  };

  try {
    /* ---------------------------------------------------------------- *
     * Set the property up with automatic billing OFF, and deliberately
     * leave the most recent months unbilled.
     * ---------------------------------------------------------------- */
    const first = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir });
    let c = makeClient(first.baseUrl);
    await activateAdmin(c, 'admin123', PASS);

    const oldest = monthBack(2);
    const thisMonth = monthBack(0);

    await c.put('/api/units/unit-3', {
      number: '3',
      ownerName: 'Owner Three',
      status: 'owner-occupied',
      monthlyMaintenance: 15000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    const seeded = await c.post('/api/charges/post-month', { monthString: oldest });

    /*
     * A villa whose levy has never been billed at all, added after that month was
     * posted. It is here to prove rule 5 against the locked decision that a month
     * is a month for the WHOLE property: the calendar never reaches back on this
     * villa's own account, but once a month is being billed, every villa that owes
     * a levy is billed for it. So it must pick up the months the run posts and
     * nothing older.
     */
    await c.put('/api/units/unit-5', {
      number: '5',
      ownerName: 'Owner Five',
      status: 'owner-occupied',
      monthlyMaintenance: 9000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    T.check('setup: the oldest month was billed by hand', seeded.status === 200 && seeded.body.created > 0, JSON.stringify(seeded.body));

    let db = (await c.get('/api/db')).body;
    const billedAtSetup = levyCharges(db, 'unit-3').map(x => x.periodMonth).sort();
    T.check(
      'setup: automatic billing stayed out of it, only the month posted by hand exists',
      billedAtSetup.length === 1 && billedAtSetup[0] === oldest,
      billedAtSetup.join(',')
    );
    const seededId = levyCharges(db, 'unit-3')[0].id;
    const chargesAtSetup = db.charges.length;
    await first.stop();

    /* ---------------------------------------------------------------- *
     * Rule 1, 2: start it with automatic billing on and touch nothing.
     * ---------------------------------------------------------------- */
    let live = await sessionOn({ VDS_AUTO_POST: 'on' });
    c = live.c;
    db = (await c.get('/api/db')).body;

    const after = levyCharges(db, 'unit-3').map(x => x.periodMonth).sort();
    T.check(
      'Rule 1 — the levy posted itself for every month up to this one, with nobody at a screen',
      after.length === 3 && after[0] === oldest && after[2] === thisMonth,
      after.join(',')
    );

    const raised = db.charges.filter(x => x.createdBy === 'System');
    T.check('Rule 1b — the charges it raised are attributed to System', raised.length > 0, `${raised.length} raised`);

    const autoEntries = (db.auditLogs || []).filter(a => /Posted recurring charges for .* \(automatically\)/.test(a.action || ''));
    T.check(
      'Rule 2 — the Compliance Log says the application billed, and for which months',
      autoEntries.length === 2 && autoEntries.every(a => a.user === 'System'),
      autoEntries.map(a => a.action).join(' | ')
    );

    T.check(
      'Rule 3a — the month already billed by hand was left exactly as it was',
      levyCharges(db, 'unit-3').some(x => x.id === seededId && x.periodMonth === oldest),
      'the hand-posted charge was replaced or removed'
    );

    const newVilla = levyCharges(db, 'unit-5').map(x => x.periodMonth).sort();
    T.check(
      'Rule 5 — a villa never billed before picks up the months the run posts, and nothing older',
      newVilla.join(',') === [monthBack(1), monthBack(0)].join(','),
      newVilla.join(',')
    );

    const perMonth = {};
    for (const x of db.charges) {
      if (x.status !== 'open' || x.kind || x.oneOffType) continue;
      const k = `${x.unitId}|${x.category}|${x.periodMonth}`;
      perMonth[k] = (perMonth[k] || 0) + 1;
    }
    const doubled = Object.entries(perMonth).filter(([, n]) => n > 1);
    T.check('Rule 3b — no account carries the same month twice', doubled.length === 0, doubled.map(([k]) => k).join(','));
    const chargesAfterFirstRun = db.charges.length;
    T.check('the run actually raised charges', chargesAfterFirstRun > chargesAtSetup, `${chargesAtSetup} then ${chargesAfterFirstRun}`);
    await live.s.stop();

    /* ---------------------------------------------------------------- *
     * Rule 3: starting again changes nothing.
     * ---------------------------------------------------------------- */
    live = await sessionOn({ VDS_AUTO_POST: 'on' });
    c = live.c;
    db = (await c.get('/api/db')).body;
    T.check(
      'Rule 3c — a second run with nothing owed raises nothing at all',
      db.charges.length === chargesAfterFirstRun,
      `${chargesAfterFirstRun} then ${db.charges.length}`
    );
    await live.s.stop();

    /* ---------------------------------------------------------------- *
     * Rule 4: an implausible backlog is reported, not billed.
     * ---------------------------------------------------------------- */
    const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-autocap-'));
    const capSetup = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir: capDir });
    const cc = makeClient(capSetup.baseUrl);
    await activateAdmin(cc, 'admin123', PASS);
    await cc.put('/api/units/unit-3', {
      number: '3',
      ownerName: 'Owner Three',
      status: 'owner-occupied',
      monthlyMaintenance: 15000,
      currency: 'JMD',
      maintCurrency: 'JMD',
      maintDueDay: 1
    });
    await cc.post('/api/charges/post-month', { monthString: monthBack(4) });
    const capBefore = (await cc.get('/api/db')).body.charges.length;
    await capSetup.stop();

    const capped = await startServer({
      port,
      adminPassword: 'admin123',
      projectRoot,
      dataDir: capDir,
      env: { VDS_AUTO_POST: 'on', VDS_AUTO_POST_MAX_MONTHS: '2' }
    });
    const cc2 = makeClient(capped.baseUrl);
    await cc2.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
    const capDb = (await cc2.get('/api/db')).body;
    T.check(
      'Rule 4a — four unbilled months against a cap of two raises nothing',
      capDb.charges.length === capBefore,
      `${capBefore} then ${capDb.charges.length}`
    );
    T.check(
      'Rule 4b — and the Compliance Log says it held back, so the silence is visible',
      (capDb.auditLogs || []).some(a => a.action === 'Automatic billing held back'),
      'no entry'
    );
    await capped.stop();
    fs.rmSync(capDir, { recursive: true, force: true });

    /* ---------------------------------------------------------------- *
     * The calendar itself: the rules that decide what is owed.
     * ---------------------------------------------------------------- */
    const unit = {
      id: 'u1',
      number: '1',
      ownerName: 'O',
      status: 'owner-occupied',
      monthlyRent: 0,
      monthlyMaintenance: 20000,
      currency: 'JMD',
      maintCurrency: 'JMD'
    };
    const charge = month => ({
      id: `c-${month}`,
      unitId: 'u1',
      unitNumber: '1',
      category: 'Maintenance',
      periodMonth: month,
      dueDate: `${month}-01`,
      amount: 20000,
      currency: 'JMD',
      status: 'open',
      payerName: 'O',
      createdAt: '',
      createdBy: 'x'
    });

    const neverBilled = cal.billingBacklog([unit], [], [], `${TODAY}`);
    T.check(
      'Rule 5b — on its own account, a never-billed villa owes this month and no history',
      neverBilled.length === 1 && neverBilled[0].month === monthBack(0),
      neverBilled.map(g => g.month).join(',')
    );

    const gap = cal.billingBacklog([unit], [], [charge(monthBack(3))], `${TODAY}`);
    T.check(
      'the calendar reports every month between the first levy ever billed and this one',
      gap.length === 3 && gap.map(g => g.month).join(',') === [monthBack(2), monthBack(1), monthBack(0)].join(','),
      gap.map(g => g.month).join(',')
    );

    const closed = cal.billingBacklog([unit], [], [charge(monthBack(3))], `${TODAY}`, undefined, monthBack(1));
    T.check(
      'Rule 6 — a closed month is never offered for billing',
      closed.length === 1 && closed[0].month === monthBack(0),
      closed.map(g => g.month).join(',')
    );

    const oneOff = cal.billingBacklog(
      [unit],
      [],
      [charge(monthBack(3)), { ...charge(monthBack(0)), id: 'late-fee', oneOffType: 'late-fee' }],
      `${TODAY}`
    );
    T.check(
      'a late fee in a month does not make the calendar think the levy was raised',
      oneOff.some(g => g.month === monthBack(0)),
      oneOff.map(g => g.month).join(',')
    );

    const unavailable = cal.billingBacklog([{ ...unit, status: 'unavailable' }], [], [charge(monthBack(3))], `${TODAY}`);
    T.check('a villa out of service owes no levy', unavailable.length === 0, unavailable.map(g => g.month).join(','));

    /* ---------------------------------------------------------------- *
     * The Hub keeps a visible backstop for whatever this fails to raise.
     * ---------------------------------------------------------------- */
    const hub = fs.readFileSync(path.join(projectRoot, 'src/components/NotificationsTab.tsx'), 'utf8');
    T.check(
      'the Hub still reports levy months that were never raised',
      /Maintenance not yet billed/.test(hub) && /billingBacklog/.test(hub),
      'the backstop card is gone'
    );
  } finally {
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return T.done();
}
