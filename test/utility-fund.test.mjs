/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A utility bill paid on one of ISPO's villas is ISPO's cost.
 *
 * Ro, 2026-11-19, asked whose cost the J$40,000 electricity bill on a let villa
 * was: "ISPO's cost". The expense form defaults every cost to the strata fund,
 * so the bill had landed on the proprietors' books, the operating statement and
 * the monthly report to owners. Three things are asserted:
 *
 *   1. A new utility on an ISPO villa is saved on ISPO's book whatever fund the
 *      form sent; on a proprietor's villa the choice is left alone; a utility
 *      with no villa, and a non-utility cost on an ISPO villa, are left alone.
 *   2. Bills already on file are moved once, on upgrade, with an audit entry.
 *   3. The move happens by schema version, not on every start, so a database
 *      already upgraded is never rewritten again.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Utilities on an ISPO villa are ISPO’s cost';

const unitBody = (number, status) => ({
  number,
  ownerName: status === 'owner-occupied' ? 'A Proprietor' : 'ISPO',
  status,
  monthlyRent: 0,
  monthlyMaintenance: 20000,
  currency: 'JMD'
});

const expense = (extra) => ({
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

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-utility-fund-'));
  let srv = await startServer({ port, adminPassword: 'Util-1234!', projectRoot, dataDir });
  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Util-1234!', 'UtilNew-9876!');

    const u1 = await c.put('/api/units/unit-1', unitBody('1', 'vacant'));
    const u2 = await c.put('/api/units/unit-2', unitBody('2', 'owner-occupied'));
    T.check('setup: villa 1 is ISPO’s and villa 2 a proprietor’s', u1.status === 200 && u2.status === 200, `${u1.status} ${u2.status}`);

    const onIspo = await c.post('/api/expenses', expense({ unitId: 'unit-1' }));
    const onOwner = await c.post('/api/expenses', expense({ unitId: 'unit-2' }));
    const general = await c.post('/api/expenses', expense({ unitNumber: 'General' }));
    const repair = await c.post('/api/expenses', expense({ unitId: 'unit-1', category: 'Contractors', description: 'Pipe' }));
    for (const [name, r] of [['ISPO villa', onIspo], ['proprietor villa', onOwner], ['general', general], ['repair', repair]]) {
      if (r.status >= 400) T.check(`setup: ${name} cost saved`, false, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }

    let db = (await c.get('/api/db')).body;
    const find = (vendorUnit, cat = 'Utilities') => db.expenses.find(e => e.unitId === vendorUnit && e.category === cat);
    T.check('a utility on an ISPO villa is saved on ISPO’s book, though the form sent strata', find('unit-1')?.fund === 'ispo', JSON.stringify(find('unit-1')));
    T.check('a utility on a proprietor’s villa keeps the fund it was given', (find('unit-2')?.fund || 'strata') === 'strata', JSON.stringify(find('unit-2')));
    T.check(
      'a utility on no villa keeps the fund it was given',
      (db.expenses.find(e => !e.unitId && e.category === 'Utilities')?.fund || 'strata') === 'strata'
    );
    T.check('a cost that is not a utility on an ISPO villa keeps the fund it was given', (find('unit-1', 'Contractors')?.fund || 'strata') === 'strata', JSON.stringify(find('unit-1', 'Contractors')));

    /* ---------------- the bills already on file ---------------- */

    await srv.stop();
    srv = null;
    const dbPath = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.schemaVersion = 3;
    for (const e of raw.expenses) e.fund = 'strata';
    const ispoUtilityId = raw.expenses.find(e => e.unitId === 'unit-1' && e.category === 'Utilities').id;
    fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));

    srv = await startServer({ port: port + 1, adminPassword: 'Util-1234!', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    const login = await c.post('/api/auth/login', { username: 'admin', password: 'UtilNew-9876!' }, { captureCookie: true });
    T.check('setup: signed back in after the upgrade', login.status === 200, String(login.status));
    db = (await c.get('/api/db')).body;
    T.check('upgrading moves an ISPO villa’s utility bill already on file to ISPO’s book', find('unit-1')?.fund === 'ispo', JSON.stringify(find('unit-1')));
    T.check('and leaves the proprietor’s utility bill where it was', (find('unit-2')?.fund || 'strata') === 'strata');
    T.check('and the repair', (find('unit-1', 'Contractors')?.fund || 'strata') === 'strata');
    T.check(
      'the move is written to the audit trail against that bill',
      (db.auditLogs || []).some(a => a.recordId === ispoUtilityId && /ISPO's book/.test(a.details || a.detail || a.newValue || JSON.stringify(a))),
      'no audit entry names the moved bill'
    );

    /* ---------------- once, by version ---------------- */

    await srv.stop();
    srv = null;
    const again = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    T.check('the upgraded database records the new schema version', again.schemaVersion === 4, String(again.schemaVersion));
    again.expenses.find(e => e.id === ispoUtilityId).fund = 'strata';
    fs.writeFileSync(dbPath, JSON.stringify(again, null, 2));
    srv = await startServer({ port: port + 2, adminPassword: 'Util-1234!', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'UtilNew-9876!' }, { captureCookie: true });
    db = (await c.get('/api/db')).body;
    T.check(
      'a database already on schema 4 is never rewritten on a later start',
      (db.expenses.find(e => e.id === ispoUtilityId)?.fund || 'strata') === 'strata',
      JSON.stringify(db.expenses.find(e => e.id === ispoUtilityId))
    );
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
