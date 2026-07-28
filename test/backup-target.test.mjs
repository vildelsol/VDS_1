/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backing up to a second folder chosen inside the application — the external
 * drive case. The point of the feature is that a copy of the records leaves the
 * machine holding them, so this checks for a real file in a real other folder,
 * not merely that the setting was accepted.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Off-machine backup target';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-fake-drive-'));
  const srv = await startServer({ port, adminPassword: 'BackupTest-1234!', projectRoot });

  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'BackupTest-1234!', 'BackupNew-9876!');

    // --- starts off with nothing off-machine ---
    let status = (await c.get('/api/backup/status')).body;
    T.check('no off-machine folder is configured to begin with', status.externalBackupDir === null, String(status.externalBackupDir));

    // --- a folder can be tested before committing to it ---
    const goodCheck = await c.post('/api/backup/check-folder', { dir: drive });
    T.check('a writable folder tests as usable', goodCheck.body?.ok === true, goodCheck.body?.message);

    // --- saving it writes a real copy to that folder ---
    await c.post('/api/settings', { backupDir: drive });
    await c.post('/api/backup/run');

    const copied = fs.readdirSync(drive).filter(f => f.startsWith('db-') && f.endsWith('.json'));
    T.check('a dated copy is written to the chosen folder', copied.length === 1, copied.join(', '));
    T.check(
      'and it is a readable database, not a truncated file',
      (() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(drive, copied[0]), 'utf-8'));
          return Array.isArray(parsed.units) && parsed.units.length > 0;
        } catch {
          return false;
        }
      })()
    );
    T.check('no half-written .partial file is left behind', !fs.readdirSync(drive).some(f => f.endsWith('.partial')));

    status = (await c.get('/api/backup/status')).body;
    T.check('the status reports the folder', status.externalBackupDir === drive, String(status.externalBackupDir));
    T.check("and reports today's copy reached it", status.todayBackedUpExternally === true);
    T.check('and reports it as app-configured rather than environment-set', status.externalBackupFromEnv === false);

    // --- an unplugged drive must not break the app or lose the setting ---
    fs.rmSync(drive, { recursive: true, force: true });
    const afterUnplug = await c.post('/api/backup/run');
    T.check('a backup run with the folder gone still succeeds overall', afterUnplug.status === 200, `status ${afterUnplug.status}`);
    T.check(
      'and the local copy is still written',
      (afterUnplug.body?.written || []).some(w => w.location === 'local'),
      JSON.stringify(afterUnplug.body?.written || [])
    );
    status = (await c.get('/api/backup/status')).body;
    T.check('the folder setting is remembered so it need not be re-typed', status.externalBackupDir === drive);

    // --- and it can be turned off again ---
    await c.post('/api/settings', { backupDir: '' });
    status = (await c.get('/api/backup/status')).body;
    T.check('clearing the folder turns the off-machine copy off', status.externalBackupDir === null, String(status.externalBackupDir));
  } finally {
    await srv.stop();
    try {
      fs.rmSync(drive, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
  return T.done();
}
