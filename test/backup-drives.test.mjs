/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Finding the drive somebody plugged in, and following it when it moves.
 *
 * The backup target used to be a folder path typed in by hand. That works right
 * up to the moment Windows hands the stick a different letter — it comes up as E:
 * today and F: next week because something else was plugged in first — at which
 * point the saved path stops matching and the off-machine copy quietly stops
 * being made. Recorded as a failure, but only noticed by somebody who goes
 * looking, which is nobody until the day they need the backup.
 *
 * So the chosen folder is marked with a small file carrying an id, and when the
 * saved path stops answering the marker is searched for across the attached
 * drives. The same stick is recognised wherever it turns up.
 *
 * The letter reassignment itself cannot be staged on this machine, so the moving
 * drive is simulated the only honest way available: the folder is physically
 * moved somewhere else and the server is asked to find it again — which is
 * exactly the situation the code has to handle.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Finding and following the backup drive';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-drives-'));
  // Stands in for the mount point a USB stick appears at.
  const stick = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stick-'));
  const movedStick = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stick-moved-'));
  let srv = await startServer({ port, adminPassword: 'Drives-1234!', projectRoot, dataDir });

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Drives-1234!', 'DrivesNew-9876!');

    /* ---------------------------------------------------------------- *
     * What is plugged in
     * ---------------------------------------------------------------- */

    const listed = await c.get('/api/backup/drives');
    T.check('the attached drives can be listed', listed.status === 200 && Array.isArray(listed.body?.drives));
    T.check('each drive is offered as a named folder, not a bare root', (listed.body.drives || []).every(d => d.path && d.label));
    T.check('and says whether it can be written to', (listed.body.drives || []).every(d => typeof d.writable === 'boolean'));

    const junior = makeClient(srv.baseUrl);
    await c.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    await junior.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    T.check('a junior officer cannot enumerate the server’s drives', (await junior.get('/api/backup/drives')).status === 403);

    /* ---------------------------------------------------------------- *
     * Choosing one marks it, so it can be recognised again
     * ---------------------------------------------------------------- */

    const target = path.join(stick, 'Villaggio-Backups');
    const saved = await c.post('/api/settings', { backupDir: target });
    T.check('a drive can be chosen as the backup target', saved.status === 200);

    await c.post('/api/backup/run', {});
    T.check('a real backup lands on it', fs.readdirSync(target).some(f => f.startsWith('db-') && f.endsWith('.json')));

    const marker = path.join(target, '.villaggio-backup.json');
    T.check('the folder is marked so the drive can be identified later', fs.existsSync(marker));
    const markerBody = JSON.parse(fs.readFileSync(marker, 'utf8'));
    T.check('the marker carries an id', typeof markerBody.id === 'string' && markerBody.id.length > 0);
    T.check('and names the property, so it is obvious what wrote it', /Villaggio/i.test(markerBody.property || ''));

    const settings = (await c.get('/api/db')).body.settings;
    T.check('the id is remembered against the property', settings.backupMarkerId === markerBody.id);
    T.check('and the chosen folder is remembered', settings.backupDir === target);

    /* ---------------------------------------------------------------- *
     * The drive comes back somewhere else
     * ---------------------------------------------------------------- */

    await srv.stop();

    // The stick is unplugged and returns on another letter: same folder and
    // marker, different place entirely.
    const newTarget = path.join(movedStick, 'Villaggio-Backups');
    fs.mkdirSync(newTarget, { recursive: true });
    for (const file of fs.readdirSync(target)) fs.copyFileSync(path.join(target, file), path.join(newTarget, file));
    fs.rmSync(stick, { recursive: true, force: true });
    T.check('the old location is genuinely gone', !fs.existsSync(target));

    // The relocation search looks across mount points; point it at the stand-in.
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir, env: { VDS_DRIVE_ROOTS: movedStick } });
    const c2 = makeClient(srv.baseUrl);
    await c2.post('/api/auth/login', { username: 'admin', password: 'DrivesNew-9876!' }, { captureCookie: true });

    const run2 = await c2.post('/api/backup/run', {});
    T.check('a backup still runs with the drive in its new place', run2.status === 200);

    const wrote = fs.readdirSync(newTarget).filter(f => f.startsWith('db-') && f.endsWith('.json'));
    T.check('and the copy reaches the drive where it actually is', wrote.length > 0, `${wrote.length} files`);

    const after = (await c2.get('/api/db')).body.settings;
    T.check('the new location is written down', after.backupDir === newTarget, `${after.backupDir}`);
    T.check('the id it is recognised by does not change', after.backupMarkerId === markerBody.id);
    T.check(
      'and following the drive is on the audit trail',
      (await c2.get('/api/db')).body.auditLogs.some(a => /Followed the backup drive/i.test(a.action))
    );

    /* ---------------------------------------------------------------- *
     * A drive that is genuinely not here
     * ---------------------------------------------------------------- */

    await c2.post('/api/settings', { backupDir: path.join(os.tmpdir(), 'vds-never-plugged-in', 'Villaggio-Backups') });
    const orphan = await c2.post('/api/backup/run', {});
    T.check('a backup with the drive absent still succeeds overall', orphan.status === 200);
    const status = await c2.get('/api/backup/status');
    T.check('the local copy is still made', status.body?.todayBackedUp === true);
    T.check('and the server is still healthy afterwards', (await c2.get('/api/health')).status === 200);

    return T.done();
  } finally {
    await srv.stop();
    for (const dir of [dataDir, stick, movedStick]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
