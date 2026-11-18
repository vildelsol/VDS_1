/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 3: a damaged db.json and a damaged backup.
 *
 * Asks, for each kind of damage, whether the user gets a clear error or silent
 * data loss, whether the damaged file is left alone, and whether there is a
 * recovery path from the last good copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, recordAndConfirmPayment, makeLongTermUnit } from './harness.mjs';
import { tryBoot, todayStamp } from './recovery-lib.mjs';

export const title = 'Recovery: corrupt db.json and corrupt backups';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-corr-'));
  const dbPath = path.join(dataDir, 'db.json');
  const stamp = todayStamp();
  const goodBackup = path.join(dataDir, 'db-backups', `db-${stamp}.json`);
  try {
    // A real property with a payment, one clean stop (writes a daily backup at boot and the db at stop).
    let srv = await startServer({ port, adminPassword: 'Recov-1234!', projectRoot, dataDir });
    let admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Recov-1234!', 'RecovNew-9876!');
    await makeLongTermUnit(admin, 'unit-1');
    /*
     * The second receipt is the OWNER-OCCUPIED villa's levy, paid by its owner.
     * It used to be a levy receipt on unit-1, the let villa — but that villa's
     * contribution comes out of the tenant's rent, which has just been paid in
     * full, so a cash levy beside it is the same obligation twice and the server
     * refuses it. Owner-occupied is where an owner really does pay the levy
     * directly, and this test only needs a second receipt to exist.
     */
    await admin.put('/api/units/unit-3', {
      number: '3', ownerName: 'Owner Three', status: 'owner-occupied',
      monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1
    });
    await admin.post('/api/charges/post-month', { monthString: '2026-09' });
    await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Rent', amount: 50000, currency: 'JMD', date: '2026-09-02', payerName: 'P', method: 'Cash' });
    await admin.post('/api/backup/run', {});
    await recordAndConfirmPayment(admin, { unitId: 'unit-3', category: 'Maintenance', amount: 10000, currency: 'JMD', date: '2026-09-03', payerName: 'Owner Three', method: 'Cash' });
    await srv.stop();
    // harness removed nothing: dataDir was supplied by us.
    const goodBackupText = fs.readFileSync(goodBackup, 'utf8');
    const good = fs.readFileSync(dbPath, 'utf8');
    const goodObj = JSON.parse(good);
    T.check('setup: a good backup exists and db.json is ahead of it by one receipt', fs.existsSync(goodBackup) && JSON.parse(fs.readFileSync(goodBackup, 'utf8')).payments.length === goodObj.payments.length - 1);

    /* ---- 1. truncated db.json ---- */
    fs.writeFileSync(dbPath, good.slice(0, Math.floor(good.length / 2)));
    const truncatedBytes = fs.readFileSync(dbPath);
    let b = await tryBoot({ port, projectRoot, dataDir });
    T.check('truncated db.json: server refuses to start with a clear message', !b.up && /could not be parsed|NOT been overwritten/.test(b.log()), `up=${b.up} exit=${b.exitCode} log=${b.log().slice(0, 300).replace(/\n/g, ' ')}`);
    await b.stop();
    T.check('truncated db.json is left byte-for-byte untouched (not replaced by an empty database)', Buffer.compare(fs.readFileSync(dbPath), truncatedBytes) === 0);
    T.check('startup failure tells the user which backup to use (names the newest backup file or its folder)', /db-backups/.test(b.log()), '');
    T.check('the good backup was not clobbered by the failed boot', fs.existsSync(goodBackup));

    /* ---- 2. zero-length db.json ---- */
    fs.writeFileSync(dbPath, '');
    b = await tryBoot({ port, projectRoot, dataDir });
    T.check('zero-length db.json: refuses to start rather than creating a fresh empty database', !b.up, `up=${b.up}`);
    await b.stop();
    T.check('zero-length db.json is not overwritten', fs.readFileSync(dbPath, 'utf8') === '');

    /* ---- 3. db.json that is valid JSON but not a database ---- */
    for (const [label, content] of [['{}', '{}'], ['an empty list', '[]'], ['null', 'null'], ['payments not a list', JSON.stringify({ ...goodObj, payments: 'oops' })]]) {
      fs.writeFileSync(dbPath, content);
      b = await tryBoot({ port, projectRoot, dataDir });
      let silent = false;
      if (b.up) {
        const c = makeClient(b.baseUrl);
        const l = await c.post('/api/auth/login', { username: 'admin', password: 'Recov-1234!' }, { captureCookie: true });
        silent = l.status === 200;
      }
      T.check(`db.json containing ${label}: does not silently start as a brand new empty property`, !silent, `server came up and accepted a fresh admin login; db.json now ${fs.statSync(dbPath).size} bytes`);
      await b.stop();
    }

    /* ---- 4. db.json deleted while backups exist ---- */
    fs.rmSync(dbPath);
    fs.writeFileSync(path.join(dataDir, 'idempotency.json'), '[]');
    b = await tryBoot({ port, projectRoot, dataDir });
    let freshSilently = false;
    if (b.up) {
      const c = makeClient(b.baseUrl);
      freshSilently = (await c.post('/api/auth/login', { username: 'admin', password: 'Recov-1234!' }, { captureCookie: true })).status === 200;
      T.check('db.json missing but db-backups holds records: server does not silently start an empty property without saying backups exist', !freshSilently || /backup/i.test(b.log().replace(/db-backups/g, '')), `fresh empty database created silently; log: ${b.log().slice(0, 200).replace(/\n/g, ' ')}`);
      await c.post('/api/auth/change-password', { currentPassword: 'Recov-1234!', newPassword: 'RecovFresh-9876!' });
      const run1 = await c.post('/api/backup/run', {});
      const todays = JSON.parse(fs.readFileSync(goodBackup, 'utf8'));
      T.check('"Back up now" on that empty database does not overwrite today\'s only good backup', todays.payments.length > 0, `today's backup now holds ${todays.payments.length} payments (run status ${run1.status})`);
    }
    await b.stop();
    fs.rmSync(dbPath, { force: true });

    /* ---- 5. recovery path: put the newest backup in place by hand, as the error message says ---- */
    fs.writeFileSync(dbPath, goodBackupText); // what the user does with the last good backup, as the startup error instructs
    srv = await startServer({ port, adminPassword: 'Recov-1234!', projectRoot, dataDir });
    admin = makeClient(srv.baseUrl);
    const rl = await admin.post('/api/auth/login', { username: 'admin', password: 'RecovNew-9876!' }, { captureCookie: true });
    T.check('manual recovery from the newest backup works: staff passwords survive', rl.status === 200, String(rl.status));
    const rec = (await admin.get('/api/db')).body;
    T.check('and the records are back (the backup lacks only the later receipt)', rec.payments.length === goodObj.payments.length - 1, `${rec.payments.length}`);
    T.check('integrity clean after manual recovery', (await admin.get('/api/integrity')).body.ok === true);
    await admin.post('/api/backup/run', {});

    /* ---- 6. corrupt backup files through the restore route ---- */
    const bdir = path.join(dataDir, 'db-backups');
    const before = (await admin.get('/api/db')).body;
    const tries = [
      ['truncated JSON', '2026-01-01', JSON.stringify(goodObj).slice(0, 4000)],
      ['empty file', '2026-01-02', ''],
      ['binary garbage', '2026-01-03', Buffer.from([0, 255, 254, 1, 2, 3, 200]).toString('latin1')],
      ['no units', '2026-01-04', JSON.stringify({ ...goodObj, units: [] })],
      ['payments not a list', '2026-01-05', JSON.stringify({ ...goodObj, payments: { a: 1 } })]
    ];
    for (const [label, day, content] of tries) {
      fs.writeFileSync(path.join(bdir, `db-${day}.json`), content);
      const r = await admin.post('/api/backup/restore', { source: 'backup', file: `db-${day}.json`, location: 'local', confirm: 'RESTORE' });
      const after = (await admin.get('/api/db')).body;
      T.check(`restoring a ${label} backup: refused with a message, nothing changed`, r.status === 400 && typeof r.body?.error === 'string' && after.payments.length === before.payments.length, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      T.check(`  ...and the message for a ${label} backup is understandable to a non-programmer (no raw parser text)`, !/Unexpected|JSON|token|position/i.test(r.body?.error || ''), r.body?.error);
    }
    // Semantically damaged but structurally valid rows.
    const nonsense = JSON.parse(JSON.stringify(goodObj));
    nonsense.payments[0].amount = 'fifty thousand';
    nonsense.payments.push({ ...nonsense.payments[0], id: nonsense.payments[0].id }); // duplicate id and receipt number
    fs.writeFileSync(path.join(bdir, 'db-2026-01-06.json'), JSON.stringify(nonsense));
    const rn = await admin.post('/api/backup/restore', { source: 'backup', file: 'db-2026-01-06.json', location: 'local', confirm: 'RESTORE' });
    const nowDb = (await admin.get('/api/db')).body;
    T.check('a backup with a non-numeric amount and a duplicated receipt is refused before it replaces good records', rn.status === 400 || nowDb.payments.every(p => typeof p.amount === 'number'), `status ${rn.status}; live payments[0].amount is now ${JSON.stringify(nowDb.payments[0]?.amount)}; integrity.ok=${rn.body?.integrity?.ok}`);
    const pay = await recordAndConfirmPayment(admin, { unitId: 'unit-1', category: 'Rent', amount: 100, currency: 'JMD', date: '2026-09-04', payerName: 'P', method: 'Cash', advancePayment: true });
    T.check('after restoring the semantically damaged file the application can still take a payment', pay.status === 200 || rn.status === 400, `payment status ${pay.status} ${JSON.stringify(pay.body).slice(0, 150)}`);
    await srv.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
