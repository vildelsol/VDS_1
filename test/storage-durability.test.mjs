/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Storage durability: one server per data folder, a write that survives a power
 * cut, and a restore whose safety copy cannot miss a write.
 *
 *  1. Lock. A second copy of the app on the same data folder used to start and
 *     keep its own in-memory books, overwriting the first one's receipts. It must
 *     now refuse, with a clear message and a non-zero exit. A lock left by a dead
 *     process is taken over; one held by a live process we may not signal (EPERM,
 *     the normal case for a service on Windows) is respected.
 *  2. fsync. writeAtomic flushes the temp file before the rename and the folder
 *     after it; a folder that cannot be flushed (Windows: EPERM/EISDIR/EINVAL)
 *     does not fail the write.
 *  3. Restore. The safety copy is taken inside the restore's transaction, so a
 *     write queued ahead of the restore is in the copy rather than lost.
 *
 * 2 and 3 load server/db.ts directly (bundled with esbuild into a temp folder)
 * in a child process, so fs can be watched and the transaction queue held open.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, reporter, sleep } from './harness.mjs';

export const title = 'Storage durability (lock, fsync, restore safety copy)';

function runServerOnce(projectRoot, port, dataDir) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/server.cjs'], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port), VDS_DATA_DIR: dataDir, VDS_ADMIN_PASSWORD: 'LockTest-1234!', VDS_BACKUP_DIR: '', VDS_DRIVE_ROOTS: '', VDS_DRIVE_ROOTS_ONLY: '1', VDS_AUTO_POST: 'off' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, log });
    });
  });
}

const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(String(r.stdout));
};

/* A child script that bundles db.ts and runs one scenario, printing JSON. */
const UNIT_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const scenario = process.argv[2];
const calls = [];
const realOpen = fs.openSync, realFsync = fs.fsyncSync, realRename = fs.renameSync, realClose = fs.closeSync;
const fdPath = new Map();
fs.openSync = function (p, ...rest) { const fd = realOpen.call(fs, p, ...rest); fdPath.set(fd, String(p)); calls.push(['open', String(p)]); return fd; };
fs.fsyncSync = function (fd) {
  const p = fdPath.get(fd) || '?';
  calls.push(['fsync', p]);
  if (scenario === 'fsync-dir-eperm' && p === process.env.VDS_DATA_DIR) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
  return realFsync.call(fs, fd);
};
fs.renameSync = function (a, b) { calls.push(['rename', String(a), String(b)]); return realRename.call(fs, a, b); };
const db = require(process.env.DB_BUNDLE);
(async () => {
  if (scenario.startsWith('fsync')) {
    db.getDb();
    calls.length = 0;
    await db.transaction(d => { d.settings.propertyName = 'fsync probe'; });
    const onDisk = JSON.parse(fs.readFileSync(db.DB_FILE, 'utf-8')).settings.propertyName;
    console.log(JSON.stringify({ calls, onDisk, dbFile: db.DB_FILE, dir: process.env.VDS_DATA_DIR }));
  } else if (scenario === 'restore') {
    db.getDb();
    let release;
    const gate = new Promise(r => (release = r));
    // A write already in the queue ahead of the restore, still working when the restore is asked for.
    const write = db.transaction(async d => { await gate; d.settings.propertyName = 'written-before-restore'; });
    const restore = db.restoreTransaction((d, copy) => { d.settings.propertyName = 'restored'; return copy; }, { skipGuard: true });
    await new Promise(r => setTimeout(r, 50));
    release();
    await write;
    const copy = await restore;
    const saved = JSON.parse(fs.readFileSync(copy, 'utf-8'));
    console.log(JSON.stringify({ copyName: saved.settings.propertyName, now: JSON.parse(fs.readFileSync(db.DB_FILE, 'utf-8')).settings.propertyName }));
  }
})().catch(e => { console.log(JSON.stringify({ error: e.message })); });
`;

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-durable-'));
  try {
    /* ---------------- 1. single-instance lock ---------------- */
    const dataDir = path.join(scratch, 'data');
    fs.mkdirSync(dataDir);
    const lockFile = path.join(dataDir, 'vds.lock');
    let srv = await startServer({ port, adminPassword: 'LockTest-1234!', projectRoot, dataDir });
    const held = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf-8')) : null;
    T.check('the running server holds a lock file naming its pid and start time', !!held && Number.isInteger(held.pid) && !!held.startedAt, JSON.stringify(held));

    const second = await runServerOnce(projectRoot, port + 1000, dataDir);
    T.check('a second copy on the same data folder exits non-zero (3)', second.code === 3, `code=${second.code} log=${second.log.slice(0, 300)}`);
    T.check(
      'and says why, naming the running process',
      second.log.includes('Refusing to start. Another copy of the app is already running on this data folder') && second.log.includes(`process ${held && held.pid}`),
      second.log.slice(0, 300)
    );
    T.check('the first server still answers after the refused start', (await fetch(srv.baseUrl + '/api/health')).ok);
    T.check('the refused copy left the first one\'s lock in place', fs.existsSync(lockFile) && JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid === held.pid);

    await srv.stop();
    if (process.platform !== 'win32') {
      T.check('a clean stop (SIGTERM) releases the lock', !fs.existsSync(lockFile));
    } else {
      // Windows has no SIGTERM: kill() is TerminateProcess and no exit handler runs, so
      // the lock is left behind. What matters is that the next start is not blocked by it.
      T.check('on Windows a stop leaves the lock naming a process that has gone', !fs.existsSync(lockFile) || !JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid || JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid === held.pid);
    }

    srv = await startServer({ port, adminPassword: 'LockTest-1234!', projectRoot, dataDir });
    T.check('the same folder starts again after a clean stop', (await fetch(srv.baseUrl + '/api/health')).ok);
    await srv.stop();

    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid(), startedAt: '2026-01-01T00:00:00.000Z' }));
    srv = await startServer({ port, adminPassword: 'LockTest-1234!', projectRoot, dataDir });
    T.check('a lock left by a dead process is taken over', (await fetch(srv.baseUrl + '/api/health')).ok);
    await srv.stop();

    /*
     * Pid reuse. Windows hands an old pid to another program quickly, so a lock left
     * by a stopped app can name a process that is alive and has nothing to do with
     * us. This test process stands in for it: it is alive and it is not a server.
     */
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' }));
    const fresh = await runServerOnce(projectRoot, port + 1000, dataDir);
    T.check('a lock naming a live process, touched just now, is respected', fresh.code === 3 && fresh.log.includes(`process ${process.pid},`), `code=${fresh.code} ${fresh.log.slice(0, 200)}`);
    fs.utimesSync(lockFile, past, past);
    let reused = null;
    try {
      reused = await startServer({ port, adminPassword: 'LockTest-1234!', projectRoot, dataDir, env: { VDS_LOCK_HEARTBEAT_MS: '200' } });
    } catch (err) {
      reused = null;
      T.check('a lock naming a live process but untouched for ten minutes is taken over (pid reused)', false, String(err && err.message).slice(0, 200));
    }
    if (reused) {
      T.check('a lock naming a live process but untouched for ten minutes is taken over (pid reused)', (await fetch(reused.baseUrl + '/api/health')).ok);
      const taken = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      T.check('and the lock now names the new server', taken.pid !== process.pid, JSON.stringify(taken));

      // The holder keeps its lock fresh, so a running copy never looks abandoned.
      fs.utimesSync(lockFile, past, past);
      await new Promise(r => setTimeout(r, 1200));
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      T.check('the running server touches its lock (heartbeat)', age < 1000, `${Math.round(age)} ms old`);
      await reused.stop();
    }
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

    if (process.platform !== 'win32') {
      // pid 1 exists and cannot be signalled by us: process.kill answers EPERM, which means alive.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, startedAt: '2026-01-01T00:00:00.000Z' }));
      const eperm = await runServerOnce(projectRoot, port + 1000, dataDir);
      T.check('a lock held by a process we may not signal (EPERM) is respected', eperm.code === 3 && eperm.log.includes('process 1,'), `code=${eperm.code} ${eperm.log.slice(0, 200)}`);
      fs.unlinkSync(lockFile);
    }

    /* ---------------- 2 and 3: db.ts in-process ---------------- */
    const bundle = path.join(scratch, 'db.cjs');
    const esbuild = spawnSync(process.execPath, ['-e', `require('esbuild').buildSync({ entryPoints: [${JSON.stringify(path.join(projectRoot, 'server', 'db.ts'))}], bundle: true, platform: 'node', format: 'cjs', outfile: ${JSON.stringify(bundle)}, logLevel: 'error' })`], { encoding: 'utf-8', cwd: projectRoot });
    T.check('server/db.ts bundles for the in-process checks', esbuild.status === 0, esbuild.stderr);
    const script = path.join(scratch, 'unit.cjs');
    fs.writeFileSync(script, UNIT_SCRIPT);
    const unit = scenario => {
      const dir = fs.mkdtempSync(path.join(scratch, `u-${scenario}-`));
      const r = spawnSync(process.execPath, [script, scenario], { encoding: 'utf-8', env: { ...process.env, VDS_DATA_DIR: dir, DB_BUNDLE: bundle, VDS_BACKUP_DIR: '', VDS_DRIVE_ROOTS: '', VDS_DRIVE_ROOTS_ONLY: '1' } });
      const line = (r.stdout || '').trim().split('\n').pop();
      try {
        return JSON.parse(line);
      } catch {
        return { error: `no result: ${r.stdout} ${r.stderr}` };
      }
    };

    const f = unit('fsync');
    const seq = (f.calls || []).map(c => (c[0] === 'rename' ? 'rename' : `${c[0]}:${c[1] === f.dir ? 'DIR' : c[1].endsWith('.tmp') ? 'TMP' : c[1]}`));
    const iTmpSync = seq.indexOf('fsync:TMP');
    const iRename = seq.indexOf('rename');
    const iDirSync = seq.lastIndexOf('fsync:DIR');
    T.check('writeAtomic fsyncs the temp file before the rename', iTmpSync >= 0 && iTmpSync < iRename, seq.join(' ') || f.error);
    T.check('writeAtomic fsyncs the data folder after the rename', iRename >= 0 && iDirSync > iRename, seq.join(' ') || f.error);
    T.check('and the write landed', f.onDisk === 'fsync probe', JSON.stringify(f).slice(0, 200));

    const w = unit('fsync-dir-eperm');
    T.check('a folder that cannot be fsynced (Windows EPERM) does not fail the write', !w.error && w.onDisk === 'fsync probe', JSON.stringify(w).slice(0, 300));

    const r = unit('restore');
    T.check('the restore safety copy includes a write queued ahead of the restore', r.copyName === 'written-before-restore', JSON.stringify(r));
    T.check('and the restore still replaced the records', r.now === 'restored', JSON.stringify(r));
  } finally {
    await sleep(50);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return T.done();
}
