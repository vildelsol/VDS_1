/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ecosystem hunt, round 2 (QA 2026-11-21): the whole property as one ecosystem.
 *
 *  1. A restore must never leave sealed months editable. The restored database
 *     adopts the file's own close and seal; a restore that would roll the close
 *     back is refused unless confirmed with a reason; and a write that moves money
 *     in a sealed month is refused by comparing against the stored fingerprint on
 *     every write, not only through "new findings".
 *  2. Owner statements follow dated ownership.
 *  3. The Board Pack's net cash movement uses the Dashboard's cost set.
 *  4. The Annual Report's monthly table is what was billed that month.
 *  5. The Operations Statement and the Monthly Report agree on utility recoveries,
 *     and the note on individual villas is never a negative sum over 0 items.
 *  6. A pending cost dated in a closed month is refused like a paid one.
 *
 * Every refusal has a positive control that is allowed. Money text has dots
 * ("J$90,000.00"), so nothing here matches with [^.]* across it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export const title = 'Ecosystem hunt 2 (restore vs closed months, dated owner statements, board pack, annual months, utility recoveries)';

async function loadModules(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-eco2-'));
  const outfile = path.join(dir, 'bundle.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export * as fin from './src/lib/finance';
        export { remember, forgetScreenState } from './src/lib/screenState';
        export { default as BoardPack } from './src/components/BoardPack';
        export { default as OwnerStatements } from './src/components/OwnerStatements';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const textOf = html =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

/* ---------------- hand-built records for the report tests ---------------- */

const unit = (id, number, over = {}) => ({
  id,
  number,
  ownerName: `Owner ${number}`,
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
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});
const levy = (unitRec, month, amount, payerName) => ({
  id: `ch-${unitRec.id}-${month}`,
  unitId: unitRec.id,
  unitNumber: unitRec.number,
  category: 'Maintenance',
  amount,
  currency: 'JMD',
  dueDate: `${month}-01`,
  periodMonth: month,
  status: 'open',
  payerName: payerName || unitRec.ownerName,
  description: 'levy'
});
const pay = (id, unitRec, category, amount, currency, date) => ({
  id,
  receiptNo: `REC-${id}`,
  payerName: 'Someone',
  unitId: unitRec.id,
  unitNumber: unitRec.number,
  category,
  amount,
  currency,
  date,
  method: 'Cash',
  reference: '',
  notes: '',
  staffMember: 'x',
  status: 'completed'
});
const cost = (id, over = {}) => ({
  id,
  category: 'Maintenance',
  vendor: `Vendor ${id}`,
  description: `Cost ${id}`,
  unitId: '',
  unitNumber: 'General',
  amount: 1000,
  currency: 'JMD',
  date: '2025-03-05',
  datePaid: '2025-03-05',
  status: 'paid',
  reference: '',
  notes: '',
  ...over
});

const own = (id, u, name, startedOn, endedOn) => ({
  id,
  unitId: u.id,
  unitNumber: u.number,
  ownerName: name,
  ownerEmail: '',
  ownerPhone: '',
  startedOn,
  ...(endedOn ? { endedOn, status: 'ended' } : { status: 'active' }),
  recordedBy: 'x',
  recordedAt: `2020-01-01T00:00:0${id.length % 10}Z`
});

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await loadModules(projectRoot);
  const { fin, React, renderToStaticMarkup, BoardPack, OwnerStatements, remember, forgetScreenState } = mod;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-eco2-data-'));
  let srv = await startServer({ port, adminPassword: 'Eco2-1234!', projectRoot, dataDir });
  try {
    /* ================================================================
     * 1. Restore vs closed months
     * ================================================================ */
    const c = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await activateAdmin(c, 'Eco2-1234!', 'Eco2New-9876!');
    await makeLongTermUnit(c);
    for (const m of ['2026-05', '2026-06']) await c.post('/api/charges/post-month', { monthString: m });
    const get = async () => (await c.get('/api/db')).body;
    const may = await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Maintenance', amount: 10000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: '2026-05-10' });
    T.check('setup: a May receipt is confirmed', may.status === 200, JSON.stringify(may.body).slice(0, 150));
    T.check('setup: books closed through May', (await c.post('/api/periods/close', { through: '2026-05' })).status === 200);
    const bk1 = await c.post('/api/backup/run', {});
    const bk1file = bk1.body?.written?.[0]?.file;
    const bkDir = path.join(dataDir, 'db-backups');
    // Backups are named by day, so a second one the same day overwrites the first: keep each under its own name.
    fs.copyFileSync(path.join(bkDir, bk1file), path.join(bkDir, 'db-2026-01-01.json'));
    const file1 = JSON.parse(fs.readFileSync(path.join(bkDir, 'db-2026-01-01.json'), 'utf8'));
    T.check('setup: the first backup carries its own seal (closed through May)', file1.settings.closedThrough === '2026-05' && !!file1.settings.closeFingerprint);

    const june = await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Maintenance', amount: 10000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: '2026-06-10' });
    T.check('setup: a June receipt is confirmed', june.status === 200, JSON.stringify(june.body).slice(0, 150));
    T.check('setup: books closed through June', (await c.post('/api/periods/close', { through: '2026-06' })).status === 200);
    const juneId = (await get()).payments.find(p => p.date === '2026-06-10').id;
    const mayId = (await get()).payments.find(p => p.date === '2026-05-10').id;
    const ctl = await c.post(`/api/payments/${juneId}/reverse`, { reversalReason: 'control: closed month' });
    T.check('control: before the restore, voiding a June receipt in a closed month is refused', ctl.status === 409, String(ctl.status));

    const restoreBody = extra => ({ source: 'backup', file: 'db-2026-01-01.json', location: 'local', confirm: 'RESTORE', ...extra });
    const dry = await c.post('/api/backup/restore', { ...restoreBody(), dryRun: true });
    T.check('a dry run says the restore would roll the closed months back', dry.status === 200 && dry.body?.closedMonthsRolledBack?.live === '2026-06' && dry.body?.closedMonthsRolledBack?.file === '2026-05', JSON.stringify(dry.body?.closedMonthsRolledBack));
    const refused = await c.post('/api/backup/restore', restoreBody());
    T.check('a restore that reopens a month the live books closed is refused (409 restore-reopens-closed-months)', refused.status === 409 && refused.body?.code === 'restore-reopens-closed-months', `${refused.status} ${refused.body?.code}`);
    const afterRefuse = await get();
    T.check('and the refusal changed nothing: still closed through June, the June receipt still there', afterRefuse.settings.closedThrough === '2026-06' && afterRefuse.payments.some(p => p.id === juneId));
    const noReason = await c.post('/api/backup/restore', restoreBody({ confirmRollbackClosedMonths: true }));
    T.check('confirming the roll back without a reason is refused too', noReason.status === 400 && (await get()).settings.closedThrough === '2026-06', `${noReason.status}`);

    const done = await c.post('/api/backup/restore', restoreBody({ confirmRollbackClosedMonths: true, rollbackReason: 'test: restore an older state on purpose' }));
    T.check('confirmed with a reason, the restore goes ahead', done.status === 200, JSON.stringify(done.body).slice(0, 200));
    const restored = await get();
    T.check('the restored database adopts the file\'s own close (May) and its seal', restored.settings.closedThrough === '2026-05' && restored.settings.closeFingerprint === file1.settings.closeFingerprint, `${restored.settings.closedThrough}`);
    T.check('no June money is left, and nothing contradicts the seal (closed-period-changed is gone)', !restored.payments.some(p => p.date.startsWith('2026-06')) && done.body?.integrity?.findings?.every(f => f.code !== 'closed-period-changed') === true, JSON.stringify(done.body?.integrity?.findings?.map(f => f.code)));
    T.check('the roll back is audited with its reason', restored.auditLogs.some(a => /rolled the closed months back from 2026-06 to 2026-05: test: restore an older state on purpose/.test(a.action)));
    const stillClosed = await c.post(`/api/payments/${mayId}/reverse`, { reversalReason: 'void a receipt in closed May after the restore' });
    T.check('after the restore, voiding a receipt in the (still) closed May is refused', stillClosed.status === 409, `${stillClosed.status}`);
    const newInMay = await c.post('/api/payments', { unitId: 'unit-1', category: 'Maintenance', amount: 5000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: '2026-05-20', receivedNow: true });
    const newInMayConfirmed = newInMay.status === 200 && newInMay.body?.payment?.id ? await c.post(`/api/payments/${newInMay.body.payment.id}/confirm`, {}) : newInMay;
    T.check('and a new receipt dated in closed May is refused', newInMayConfirmed.status === 409, `${newInMay.status}/${newInMayConfirmed.status}`);
    const openJune = await recordAndConfirmPayment(c, { unitId: 'unit-1', category: 'Maintenance', amount: 10000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', date: '2026-06-12' });
    T.check('control: a receipt dated in June, no longer closed, is accepted', openJune.status === 200, `${openJune.status} ${JSON.stringify(openJune.body).slice(0, 120)}`);

    // A file whose close is LATER than the live one: the restored books are sealed as the file says, no confirmation needed.
    T.check('setup: close June again', (await c.post('/api/periods/close', { through: '2026-06' })).status === 200);
    const bk2 = await c.post('/api/backup/run', {});
    fs.copyFileSync(path.join(bkDir, bk2.body.written[0].file), path.join(bkDir, 'db-2026-01-02.json'));
    const file2 = JSON.parse(fs.readFileSync(path.join(bkDir, 'db-2026-01-02.json'), 'utf8'));
    T.check('setup: reopen back to May (live close is now earlier than the file\'s)', (await c.post('/api/periods/reopen', { reason: 'test: reopen to May', through: '2026-05' })).status === 200);
    const later = await c.post('/api/backup/restore', { source: 'backup', file: 'db-2026-01-02.json', location: 'local', confirm: 'RESTORE' });
    const laterDb = await get();
    T.check('restoring a file closed LATER than the live books adopts that close and seal, with no contradiction', later.status === 200 && laterDb.settings.closedThrough === '2026-06' && laterDb.settings.closeFingerprint === file2.settings.closeFingerprint && later.body?.integrity?.findings?.every(f => f.code !== 'closed-period-changed') === true, `${later.status} ${laterDb.settings.closedThrough}`);
    const juneIdAgain = laterDb.payments.find(p => p.date === '2026-06-12')?.id;
    const juneBlocked = await c.post(`/api/payments/${juneIdAgain}/reverse`, { reversalReason: 'void a receipt in closed June after restore' });
    T.check('and June, now sealed by the restore, cannot be edited', juneBlocked.status === 409, `${juneBlocked.status}`);

    // A file whose own seal does not match its records: the seal is recomputed to the restored records, and said so.
    const tampered = JSON.parse(JSON.stringify(file2));
    tampered.settings.closeFingerprint = 'v2:0000000000000000';
    fs.writeFileSync(path.join(bkDir, 'db-2026-01-03.json'), JSON.stringify(tampered));
    // Edited after it was made, so its signature no longer matches: restored only on confirmation with a reason.
    const resealed = await c.post('/api/backup/restore', { source: 'backup', file: 'db-2026-01-03.json', location: 'local', confirm: 'RESTORE', confirmUnsigned: true, reason: 'test: restoring a hand-edited copy' });
    const resealedDb = await get();
    T.check('a backup whose seal does not match its own records is restored with the seal recomputed (no standing contradiction)', resealed.status === 200 && resealedDb.settings.closeFingerprint === file2.settings.closeFingerprint && resealed.body?.integrity?.findings?.every(f => f.code !== 'closed-period-changed') === true, `${resealed.status} ${resealedDb.settings.closeFingerprint}`);
    T.check('and the audit line says the seal was recomputed', resealedDb.auditLogs.some(a => /close seal in the backup did not match its own records and was recomputed/.test(a.newValue || '')));

    /* ---- the write guard compares against the sealed fingerprint on every write ---- */
    // Change a closed-month receipt by hand in db.json: the books now carry a closed-period-changed fault that is KNOWN.
    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const hand = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const victim = hand.payments.find(p => p.date === '2026-05-10');
    const spare = hand.payments.find(p => p.date === '2026-06-12');
    victim.amount = 9999;
    fs.writeFileSync(dbPath, JSON.stringify(hand));
    srv = await startServer({ port, adminPassword: 'Eco2New-9876!', projectRoot, dataDir });
    const c2 = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await c2.post('/api/auth/login', { username: 'admin', password: 'Eco2New-9876!' }, { captureCookie: true });
    T.check('setup: the hand edit shows as a known closed-period-changed fault', (await c2.get('/api/integrity')).body?.findings?.some(f => f.code === 'closed-period-changed') === true);
    const knownFault = await c2.post(`/api/payments/${spare.id}/reverse`, { reversalReason: 'void a closed June receipt while a fault is already known' });
    T.check('with a closed-month fault already known, a write that moves more closed-month money is still refused', knownFault.status === 409, `${knownFault.status} ${knownFault.body?.code}`);
    const openWrite = await c2.post('/api/expenses', { category: 'Supplies', vendor: 'Hardware Depot', description: 'Brushes', unitNumber: 'General', amount: 800, currency: 'JMD', status: 'paid', date: '2026-07-02', datePaid: '2026-07-02' });
    T.check('control: a write in an open month goes through despite that known fault', openWrite.status === 200, `${openWrite.status} ${JSON.stringify(openWrite.body).slice(0, 150)}`);

    /* ================================================================
     * 6. A pending cost dated in a closed month
     * ================================================================ */
    const exp = (over = {}) => ({ category: 'Supplies', vendor: 'Hardware Depot', description: 'Paint', unitNumber: 'General', amount: 1200, currency: 'JMD', status: 'pending', date: '2026-07-05', dueDate: '2026-07-20', ...over });
    // Repair the hand edit so the books can close further, then close July.
    await srv.stop();
    const fixed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    fixed.payments.find(p => p.date === '2026-05-10').amount = 10000;
    fs.writeFileSync(dbPath, JSON.stringify(fixed));
    srv = await startServer({ port, adminPassword: 'Eco2New-9876!', projectRoot, dataDir });
    const c3 = makeClient(srv.baseUrl, { autoOverrideReason: false });
    await c3.post('/api/auth/login', { username: 'admin', password: 'Eco2New-9876!' }, { captureCookie: true });
    const openPending = await c3.post('/api/expenses', exp());
    T.check('control: a pending cost dated July (open then) is recorded', openPending.status === 200, `${openPending.status} ${JSON.stringify(openPending.body).slice(0, 120)}`);
    const owedBefore = await c3.post('/api/expenses', exp({ description: 'Owed from July', date: '2026-07-06', dueDate: '2026-07-20' }));
    T.check('setup: a pending July cost (still open) is recorded before the close', owedBefore.status === 200, `${owedBefore.status}`);
    const closeJuly = await c3.post('/api/periods/close', { through: '2026-07', confirmWithFaults: true });
    T.check('setup: close through July', closeJuly.status === 200, `${closeJuly.status} ${JSON.stringify(closeJuly.body)}`);
    const pendingClosed = await c3.post('/api/expenses', exp({ description: 'Late July bill', date: '2026-07-28', dueDate: '2026-07-30' }));
    T.check('a pending cost dated in a closed month is refused (409 period-closed)', pendingClosed.status === 409 && pendingClosed.body?.code === 'period-closed', `${pendingClosed.status} ${pendingClosed.body?.code}`);
    const paidClosed = await c3.post('/api/expenses', exp({ status: 'paid', datePaid: '2026-07-28', date: '2026-07-28' }));
    T.check('control: a paid cost dated in a closed month is refused as before', paidClosed.status === 409 && paidClosed.body?.code === 'period-closed', `${paidClosed.status}`);
    const owed = owedBefore.body.expense;
    const edit = await c3.put(`/api/expenses/${owed.id}`, { ...owed, description: 'Owed from June, reworded' });
    T.check('editing a pending cost that sits in a closed month is refused', edit.status === 409 && edit.body?.code === 'period-closed', `${edit.status} ${edit.body?.code}`);
    const voidIt = await c3.post(`/api/expenses/${owed.id}/void`, { reason: 'test: take back the pending cost', voidReason: 'test: take back the pending cost' });
    T.check('taking a pending cost in a closed month back is refused', voidIt.status === 409 && voidIt.body?.code === 'period-closed', `${voidIt.status} ${voidIt.body?.code}`);
    const settle = await c3.put(`/api/expenses/${owed.id}`, { ...owed, status: 'paid', datePaid: '2026-08-03', paymentMethod: 'Cash' });
    T.check('control: paying that old pending cost in an open month is allowed (it must stay payable)', settle.status === 200, `${settle.status} ${JSON.stringify(settle.body).slice(0, 150)}`);

    /* ================================================================
     * 2. Owner statements follow dated ownership
     * ================================================================ */
    const { ownerStatements, groupStatementsByOwner } = fin;
    const A4 = unit('a4', 'A4', { ownerName: 'ISPO' });
    const B7 = unit('b7', 'B7', { ownerName: 'B7 Second Owner' });
    const C1 = unit('c1', 'C1', { ownerName: 'Carol Cole' });
    const units = [A4, B7, C1];
    const charges = [];
    for (const m of ['2026-12', '2027-01']) charges.push(levy(A4, m, 20000, 'ISPO'));
    for (const m of ['2027-02', '2027-03']) charges.push(levy(A4, m, 20000, 'New Proprietor A4'));
    charges.push(levy(B7, '2027-02', 20000, 'Proprietor B7'), levy(B7, '2027-03', 20000, 'B7 Second Owner'));
    charges.push(levy(C1, '2027-02', 20000), levy(C1, '2027-03', 20000));
    const ownerships = [
      own('o-a4-1', A4, 'ISPO', '', '2027-01-10'),
      own('o-a4-2', A4, 'New Proprietor A4', '2027-01-10', '2027-04-10'),
      own('o-a4-3', A4, 'ISPO', '2027-04-10'),
      own('o-b7-1', B7, 'Proprietor B7', '', '2027-02-12'),
      own('o-b7-2', B7, 'B7 Second Owner', '2027-02-12')
    ];
    const S = (list, ...rest) => ownerStatements(units, charges, [], [], [], '2027-02-01', '2027-03-31', list);
    const stmts = S(ownerships);
    const a4 = stmts.filter(s => s.unit.number === 'A4' && s.currency === 'JMD');
    const a4New = a4.find(s => s.unit.ownerName === 'New Proprietor A4');
    const a4Old = a4.find(s => s.unit.ownerName === 'ISPO');
    T.check('A4: the Feb-Mar statement is addressed to the owner of that period, not to today\'s owner', !!a4New && a4New.maintenanceBilled === 40000, JSON.stringify(a4.map(s => [s.unit.ownerName, s.maintenanceBilled])));
    T.check('A4: the buyer is shown only their own debt (Feb and Mar), not the seller\'s December and January', a4New?.maintenanceOutstanding === 40000, String(a4New?.maintenanceOutstanding));
    T.check('A4: the former owner who still owes receives a statement for that debt (Dec and Jan), with no period charges on it', a4Old?.maintenanceOutstanding === 40000 && a4Old?.maintenanceBilled === 0 && a4Old.from === '2027-02-01' && a4Old.to === '2027-03-31', JSON.stringify(a4Old && [a4Old.maintenanceOutstanding, a4Old.maintenanceBilled]));
    const b7 = stmts.filter(s => s.unit.number === 'B7' && s.currency === 'JMD').sort((x, y) => x.from.localeCompare(y.from));
    T.check('B7: a villa sold within the period yields one statement per owner', b7.length === 2 && b7[0].unit.ownerName === 'Proprietor B7' && b7[1].unit.ownerName === 'B7 Second Owner', JSON.stringify(b7.map(s => [s.unit.ownerName, s.from, s.to])));
    T.check('B7: each covers their own days (to the day before the sale; from the sale day)', b7[0]?.from === '2027-02-01' && b7[0]?.to === '2027-02-11' && b7[1]?.from === '2027-02-12' && b7[1]?.to === '2027-03-31');
    T.check('B7: each carries only their own charge, and arrears stay with the owner who ran them up', b7[0]?.maintenanceBilled === 20000 && b7[1]?.maintenanceBilled === 20000 && b7[0]?.maintenanceOutstanding === 20000 && b7[1]?.maintenanceOutstanding === 20000, JSON.stringify(b7.map(s => [s.maintenanceBilled, s.maintenanceOutstanding])));
    const groups = groupStatementsByOwner(stmts);
    T.check('grouping by owner puts each statement under the right proprietor', groups.some(g => g.owner === 'Proprietor B7' && g.statements.length === 1) && groups.some(g => g.owner === 'B7 Second Owner' && g.statements.length === 1) && groups.some(g => g.owner === 'New Proprietor A4'));
    const c1 = stmts.filter(s => s.unit.number === 'C1');
    T.check('control: a villa with no ownership history gives the single statement it always did', c1.length === 1 && c1[0].unit.ownerName === 'Carol Cole' && c1[0].maintenanceBilled === 40000);
    const legacy = S(undefined);
    T.check('control: without the history the old behaviour holds (one statement per villa, addressed to today\'s owner), so the history is what changes it', legacy.filter(s => s.unit.number === 'B7').length === 1 && legacy.find(s => s.unit.number === 'B7').unit.ownerName === 'B7 Second Owner');
    const oneRecord = ownerStatements(units, charges, [], [], [], '2027-02-01', '2027-03-31', [own('o-c1', C1, 'Carol Cole', '')]);
    T.check('control: a single ownership record changes nothing', oneRecord.filter(s => s.unit.number === 'C1').length === 1);

    // The screen is given the history and prints the same.
    forgetScreenState();
    remember('owner-statements.preset', 'custom');
    remember('owner-statements.custom', { from: '2027-02-01', to: '2027-03-31' });
    const session = { id: 'u', name: 'Admin', username: 'admin', role: 'ADMINISTRATOR', permissions: {} };
    const screen = textOf(renderToStaticMarkup(React.createElement(OwnerStatements, { units, charges, payments: [], expenses: [], utilities: [], ownerships, settings: {}, session })));
    T.check('the screen lists the former owner, the buyer and both owners of the sold villa as separate proprietors', /ISPO/.test(screen) && /New Proprietor A4/.test(screen) && /Proprietor B7/.test(screen) && /B7 Second Owner/.test(screen), screen.slice(0, 300));
    forgetScreenState();
    remember('owner-statements.preset', 'custom');
    remember('owner-statements.custom', { from: '2027-02-01', to: '2027-03-31' });
    const screenNoHistory = textOf(renderToStaticMarkup(React.createElement(OwnerStatements, { units, charges, payments: [], expenses: [], utilities: [], settings: {}, session })));
    T.check('control: the same screen without the history does not know the former owner (so the prop is what carries it)', !/New Proprietor A4/.test(screenNoHistory));
    forgetScreenState();

    /* ================================================================
     * 3. Board Pack net cash movement = Dashboard's cost set
     * ================================================================ */
    const B1 = unit('b1', 'B1', { ownerName: 'Bea One' });
    const A9 = unit('a9', 'A9', { ownerName: 'ISPO', status: 'long-term', monthlyRent: 50000 });
    const march = [
      pay('p1', B1, 'Maintenance', 20000, 'JMD', '2025-03-10'),
      pay('p2', A9, 'Rent', 50000, 'JMD', '2025-03-10'),
      pay('p3', B1, 'Utility', 6000, 'JMD', '2025-03-12'),
      pay('p4', A9, 'Booking', 300, 'USD', '2025-03-11')
    ];
    const marchCosts = [
      cost('e1', { amount: 40000 }),
      cost('e2', { amount: 18000, category: 'Other', fund: 'ispo', datePaid: '2025-03-06' }),
      cost('e3', { amount: 200, currency: 'USD', category: 'Security', fund: 'ispo', datePaid: '2025-03-07' }),
      cost('e4', { amount: 10000, category: 'Utilities', datePaid: '2025-03-08' })
    ];
    const bpUnits = [B1, A9];
    const boardText = textOf(
      renderToStaticMarkup(
        React.createElement(BoardPack, { units: bpUnits, charges: [], payments: march, expenses: marchCosts, tenancies: [], bookings: [], settings: {}, from: '2025-03-01', to: '2025-03-31', generatedBy: 'x', onClose() {} })
      )
    );
    const cell = (label, n) => {
      const re = new RegExp(`${label}\\s+((?:-?(?:J\\$|US\\$|\\$)[0-9,]+\\.[0-9]{2}\\s*)+)`);
      const m = re.exec(boardText);
      return m ? m[1].trim().split(/\s+/)[n] : undefined;
    };
    T.check('Board Pack: JMD paid out counts both books and nets the utility recovery (40,000 + 18,000 + 10,000 - 6,000)', cell('Paid out', 0) === 'J$62,000.00', `${cell('Paid out', 0)} | ${boardText.slice(boardText.indexOf('Measure'), boardText.indexOf('Measure') + 400)}`);
    T.check('Board Pack: USD paid out is the US$200 ISPO paid, not $0', /Paid out\s+J\$62,000\.00\s+(?:US)?\$200\.00/.test(boardText), boardText.slice(boardText.indexOf('Paid out'), boardText.indexOf('Paid out') + 80));
    T.check('Board Pack: net cash movement is received less that paid out (70,000 - 62,000 JMD; 300 - 200 USD)', /Net cash movement\s+J\$8,000\.00\s+(?:US)?\$100\.00/.test(boardText), boardText.slice(boardText.indexOf('Net cash'), boardText.indexOf('Net cash') + 80));
    // The Dashboard's own rule, computed straight from the finance helpers.
    const dashSpent = fin.expensesInPeriod(fin.withUtilityRecoveries(marchCosts, march), 'JMD', '2025-03-01', '2025-03-31');
    T.check('control: that is exactly the Dashboard\'s spent figure (withUtilityRecoveries over every cost)', dashSpent === 62000, String(dashSpent));
    const strataOnly = fin.expensesInPeriod(fin.strataExpenses(fin.withUtilityRecoveries(marchCosts, march)), 'JMD', '2025-03-01', '2025-03-31');
    T.check('control: the old pack figure (corporation costs only) is different, so the check can fail', strataOnly === 44000);

    /* ================================================================
     * 4. Annual Report monthly table = what was billed that month
     * ================================================================ */
    const U1 = unit('u1', 'U1', { monthlyMaintenance: 27000 });
    const U2 = unit('u2', 'U2', { monthlyMaintenance: 27000 });
    const yearCharges = [];
    for (let m = 3; m <= 12; m++) {
      const month = `2025-${String(m).padStart(2, '0')}`;
      const amt = m <= 8 ? 20000 : 27000;
      yearCharges.push(levy(U1, month, amt), levy(U2, month, amt));
    }
    const yearCosts = [cost('y1', { amount: 45000, date: '2025-03-10', datePaid: '2025-03-10' })];
    const rep = fin.annualOwnersReport([U1, U2], yearCharges, [], yearCosts, 'JMD', 2025, { booksBeginOn: '2025-03-01' });
    const incomeOf = m => rep.months.find(x => x.month === m)?.income;
    T.check('Annual: each month\'s income is what was billed that month (Mar-Aug 40,000, Sep-Dec 54,000, Jan-Feb outside the books 0)', incomeOf('2025-03') === 40000 && incomeOf('2025-08') === 40000 && incomeOf('2025-09') === 54000 && incomeOf('2025-12') === 54000 && incomeOf('2025-01') === 0 && incomeOf('2025-02') === 0, JSON.stringify(rep.months.map(m => m.income)));
    T.check('Annual: the months column adds up to contributionsAnnual (456,000)', rep.months.reduce((s, m) => s + m.income, 0) === rep.contributionsAnnual && rep.contributionsAnnual === 456000, `${rep.months.reduce((s, m) => s + m.income, 0)} vs ${rep.contributionsAnnual}`);
    T.check('Annual: March, billed 40,000 against 45,000 of cost, is a month over (it was hidden by today\'s 54,000)', rep.monthsOver.includes('2025-03') && rep.months.find(m => m.month === '2025-03').shortfall === 5000, JSON.stringify(rep.monthsOver));
    T.check('Annual: monthsCovered counts the nine other recorded months', rep.monthsCovered === 9, String(rep.monthsCovered));
    const scheduled = unit('s1', 'S1', { monthlyMaintenance: 27000, maintenanceSchedule: [{ effectiveFrom: '2025-01', amount: 20000 }, { effectiveFrom: '2025-09', amount: 27000 }] });
    const repS = fin.annualOwnersReport([scheduled], [], [], [], 'JMD', 2025);
    T.check('Annual: with no charges, each month follows the dated levy for that month and still adds up', repS.months[0].income === 20000 && repS.months[7].income === 20000 && repS.months[8].income === 27000 && repS.months.reduce((s, m) => s + m.income, 0) === repS.contributionsAnnual && repS.contributionsAnnual === 8 * 20000 + 4 * 27000, `${repS.months.map(m => m.income)}`);
    const flat = fin.annualOwnersReport([unit('f1', 'F1')], [], [], [], 'JMD', 2025);
    T.check('control: with no charges and no schedule the flat fee still applies to every month (unchanged)', flat.months.every(m => m.income === 20000) && flat.contributionsAnnual === 240000);

    /* ================================================================
     * 5. Operations Statement and Monthly Report agree on utility recoveries
     * ================================================================ */
    const ops = fin.operationsStatement(marchCosts, march, 'JMD', '2025-03-01', '2025-03-31');
    const mon = fin.monthlyOwnersReport(bpUnits, [], march, marchCosts, 'JMD', '2025-03');
    /*
     * Reversed 2026-11-21 (owner's rule): a utility bill tied to a villa, and the recovery of it, is that villa
     * owner's own cost, never a common cost. Both documents leave the recovery out, so they agree on the gross
     * common costs (40,000 + 10,000), and still agree with each other.
     */
    T.check('Ops vs Monthly: the same costs paid for the same month (common costs 40,000 + 10,000; the villa recovery is not netted)', ops.costsPaid === 50000 && mon.costsPaid === 50000, `${ops.costsPaid} vs ${mon.costsPaid}`);
    T.check('Ops vs Monthly: the same surplus (20,000 received - 50,000)', ops.surplus === -30000 && mon.surplus === -30000, `${ops.surplus} vs ${mon.surplus}`);
    const utilGroup = ops.groups.find(g => g.category === 'Utilities');
    T.check('Ops: the villa recovery is not a line at all, and no villa is named to the other owners', utilGroup?.lines.length === 1 && utilGroup.lines[0].id === 'e4' && !JSON.stringify(ops).includes('B1') && !JSON.stringify(ops).includes('recovered'), JSON.stringify(utilGroup));
    T.check('Ops: the recovery is not left in the villa memo either', ops.villaRecharged === 0 && ops.villaRechargedCount === 0, `${ops.villaRecharged}/${ops.villaRechargedCount}`);
    const noRecovery = fin.operationsStatement(marchCosts, march.filter(p => p.category !== 'Utility'), 'JMD', '2025-03-01', '2025-03-31');
    T.check('control: with or without the recovery receipt the common cost is the same 50,000 (the receipt no longer moves it)', noRecovery.costsPaid === 50000);
    // A bill paid in February for a villa, recovered in March: both are the villa owner's own, so neither is a common cost.
    const febBill = cost('f1', { amount: 10000, category: 'Utilities', unitId: 'b1', unitNumber: 'B1', date: '2025-02-20', datePaid: '2025-02-20' });
    const monLate = fin.monthlyOwnersReport(bpUnits, [], march.filter(p => p.id === 'p3'), [febBill], 'JMD', '2025-03');
    const note = fin.individualVillasNote(monLate);
    T.check('Monthly: a villa utility bill and its later recovery are not common costs, so there is nothing to note', monLate.costsPaid === 0 && note === null, String(note));
    const opsLate = fin.operationsStatement([febBill], march.filter(p => p.id === 'p3'), 'JMD', '2025-03-01', '2025-03-31');
    T.check('Ops vs Monthly: the same month agrees too (no common cost either side)', opsLate.costsPaid === 0 && monLate.costsPaid === 0, `${opsLate.costsPaid} vs ${monLate.costsPaid}`);
    const normal = fin.individualVillasNote({ currency: 'JMD', onIndividualVillas: 4500, onIndividualVillasCount: 2 });
    T.check('control: an ordinary spend on villas keeps its wording ("across 2 items")', /J\$4,500\.00 across 2 items was spent on individual villas/.test(normal || ''), String(normal));
  } finally {
    await srv.stop();
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
