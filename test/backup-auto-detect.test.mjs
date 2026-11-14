/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plug in an external drive and the server starts backing up to it, with no
 * browser open (Ro, 2026-11-13). A "drive" here is a temporary folder named in
 * VDS_DRIVE_ROOTS; creating or removing it is plugging in or pulling out.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, sleep } from './harness.mjs';

export const title = 'External drive is detected and used automatically';

const PW = 'AutoDrive-1234!';

async function until(fn, ms = 9000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-drives-'));
  const A = path.join(base, 'StickA');
  const B = path.join(base, 'StickB');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-auto-'));
  const env = { VDS_DRIVE_ROOTS: [A, B].join(path.delimiter), VDS_DRIVE_WATCH_MS: '600' };
  const backupsIn = dir => {
    try {
      return fs.readdirSync(path.join(dir, 'Villaggio-Backups')).filter(f => !f.startsWith('.'));
    } catch {
      return [];
    }
  };

  let srv;
  try {
    srv = await startServer({ port, adminPassword: PW, projectRoot, dataDir, env });
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, PW, PW + 'x');
    const dir = async () => (await c.get('/api/backup/status')).body?.externalBackupDir || '';

    await sleep(1800);
    T.check('with no drive attached nothing is chosen', (await dir()) === '');

    // Plug in one stick.
    fs.mkdirSync(A);
    const adopted = await until(async () => (await dir()) === path.join(A, 'Villaggio-Backups'));
    T.check('one stick plugged in: its folder is saved as the backup location', adopted, `backupDir=${await dir()}`);
    T.check('a backup was written to it straight away', await until(() => backupsIn(A).length > 0));
    const audit = (await c.get('/api/db')).body.auditLogs.some(l => /external drive/i.test(l.action || ''));
    T.check('the choice is on the audit trail', audit);

    // A second stick must not steal the location.
    fs.mkdirSync(B);
    await sleep(2200);
    T.check('a second stick does not replace a working location', (await dir()) === path.join(A, 'Villaggio-Backups'));
    T.check('and nothing was written to it', backupsIn(B).length === 0);

    // Pull the first stick out, and the second is now the only one.
    fs.rmSync(A, { recursive: true, force: true });
    const moved = await until(async () => (await dir()) === path.join(B, 'Villaggio-Backups'));
    T.check('first stick gone, one other connected: backups follow to it', moved, `backupDir=${await dir()}`);
    T.check('and a backup lands there', await until(() => backupsIn(B).length > 0));
    await srv.stop();
    srv = null;

    // Two sticks at once, nothing set: ambiguous, so nobody is guessed.
    const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-auto2-'));
    fs.mkdirSync(A);
    fs.rmSync(path.join(B, 'Villaggio-Backups'), { recursive: true, force: true });
    srv = await startServer({ port, adminPassword: PW, projectRoot, dataDir: data2, env });
    const c2 = makeClient(srv.baseUrl);
    await activateAdmin(c2, PW, PW + 'x');
    await sleep(2500);
    const amb = (await c2.get('/api/backup/status')).body?.externalBackupDir || '';
    T.check('two sticks at once and none chosen: left for a person to decide', amb === '', `backupDir=${amb}`);
    await srv.stop();
    srv = null;
    fs.rmSync(data2, { recursive: true, force: true });

    // Positive control for the pin: with VDS_BACKUP_DIR set the watcher stays out.
    fs.rmSync(B, { recursive: true, force: true });
    const data3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-auto3-'));
    srv = await startServer({ port, adminPassword: PW, projectRoot, dataDir: data3, env: { ...env, VDS_BACKUP_DIR: path.join(base, 'Pinned') } });
    const c3 = makeClient(srv.baseUrl);
    await activateAdmin(c3, PW, PW + 'x');
    await sleep(2500);
    T.check('a location pinned by the administrator is never replaced by a detected drive', ((await c3.get('/api/backup/status')).body?.externalBackupDir || '') === path.join(base, 'Pinned'));
    await srv.stop();
    srv = null;
    fs.rmSync(data3, { recursive: true, force: true });
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
