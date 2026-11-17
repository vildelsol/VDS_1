/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 4: read-only and full disks.
 *
 * The user must get an accurate error and never a false success. Three cases:
 * the data folder becomes read-only; the backup folder becomes read-only (does
 * "Back up now" say so?); the disk fills up (a real 4 MB disk image is mounted,
 * macOS only, skipped elsewhere). After each, the on-disk file must still hold
 * exactly the receipts the server acknowledged, and writing must resume once the
 * fault is cleared with the next receipt number and no gap.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Recovery: read-only and full disks';

const receipt = (c, amount) =>
  c.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount, currency: 'JMD', date: '2026-10-01', payerName: 'D', method: 'Cash', advancePayment: true, receivedNow: true });
const nums = dataDir => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).payments.map(p => p.receiptNo).filter(Boolean);

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  // Needs POSIX permissions / signals / disk images; the Windows build runner cannot exercise it faithfully.
  if (process.platform === 'win32') {
    console.log('  info: NOT RUN on Windows (POSIX permissions, SIGKILL semantics and disk images)');
    return T.done();
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-disk-'));
  let srv = await startServer({ port, adminPassword: 'Disk-1234!', projectRoot, dataDir });
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Disk-1234!', 'DiskNew-9876!');
    await makeLongTermUnit(c, 'unit-1');
    await c.post('/api/charges/post-month', { monthString: '2026-09' });
    const r1 = await receipt(c, 1001);
    T.check('baseline receipt issued', r1.status === 200 && r1.body?.payment?.receiptNo === 'REC-2026-0001');

    /* ---- 1. data folder read-only ---- */
    fs.chmodSync(dataDir, 0o555);
    const ro = await receipt(c, 1002);
    const roChange = await c.post('/api/settings', { trn: 'RO-TEST' });
    fs.chmodSync(dataDir, 0o755);
    T.check('read-only data folder: a receipt is NOT reported as saved', ro.status >= 400, `status ${ro.status} ${JSON.stringify(ro.body).slice(0, 200)}`);
    T.check('read-only data folder: a settings change is NOT reported as saved', roChange.status >= 400, `status ${roChange.status}`);
    T.check('read-only data folder: the error tells the user the records could not be saved (not a generic or misleading message)', /could not be saved|disk|permission|read-only|not saved/i.test(String(ro.body?.error || '')), JSON.stringify(ro.body).slice(0, 200));
    T.check('read-only data folder: the error does not leak the server file path', !/\/var\/|\/tmp\/|vds-disk/.test(JSON.stringify(ro.body)), JSON.stringify(ro.body).slice(0, 200));
    T.check('server is still alive and the failed receipt is not visible', (await c.get('/api/db')).body.payments.length === 1);
    const r2 = await receipt(c, 1003);
    T.check('after the fault clears the next receipt is REC-2026-0002 (no gap, no reuse)', r2.status === 200 && r2.body?.payment?.receiptNo === 'REC-2026-0002', `${r2.status} ${r2.body?.payment?.receiptNo}`);

    /* ---- 2. backup folder read-only: does "Back up now" tell the truth? ---- */
    const bdir = path.join(dataDir, 'db-backups');
    for (const f of fs.readdirSync(bdir)) fs.rmSync(path.join(bdir, f), { force: true });
    fs.chmodSync(bdir, 0o555);
    const bk = await c.post('/api/backup/run', {});
    const st = (await c.get('/api/backup/status')).body;
    fs.chmodSync(bdir, 0o755);
    const wrote = fs.readdirSync(bdir).filter(f => /^db-/.test(f)).length;
    T.check('read-only backup folder: no backup file exists (positive control for the test)', wrote === 0, String(wrote));
    T.check('read-only backup folder: "Back up now" does not answer success when nothing was written', !(bk.status === 200 && bk.body?.success === true && (bk.body?.written || []).length === 0), `status ${bk.status} success=${bk.body?.success} written=${JSON.stringify(bk.body?.written)}`);
    T.check('read-only backup folder: backup status shows an error for the local copy', JSON.stringify(st).match(/error/i) && /EACCES|denied|permission|could not/i.test(JSON.stringify(st)), JSON.stringify({ ...st, backups: undefined }).slice(0, 300));

    /* ---- 3. disk full ---- */
    let vol = '';
    let img = '';
    try {
      img = path.join(os.tmpdir(), `vds-tiny-${process.pid}.dmg`);
      execFileSync('hdiutil', ['create', '-size', '6m', '-fs', 'HFS+', '-volname', `vdstiny${process.pid}`, '-attach', img], { stdio: 'pipe' });
      vol = `/Volumes/vdstiny${process.pid}`;
    } catch { console.log('  info: NOT RUN: cannot create a small disk image here (hdiutil unavailable); full-disk case skipped'); }
    if (vol && fs.existsSync(vol)) {
      const tinyData = path.join(vol, 'data');
      fs.mkdirSync(tinyData);
      fs.copyFileSync(path.join(dataDir, 'db.json'), path.join(tinyData, 'db.json'));
      await srv.stop();
      const srv2 = await startServer({ port, adminPassword: 'Disk-1234!', projectRoot, dataDir: tinyData });
      const c2 = makeClient(srv2.baseUrl);
      try {
        await c2.post('/api/auth/login', { username: 'admin', password: 'DiskNew-9876!' }, { captureCookie: true });
        const dbSize = fs.statSync(path.join(tinyData, 'db.json')).size;
        // Leave room for roughly one more copy of the database, then fill the rest.
        const free = Number(execFileSync('df', ['-k', vol], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/)[3]) * 1024;
        const filler = Math.max(0, free - Math.floor(dbSize * 1.6));
        fs.writeFileSync(path.join(vol, 'filler.bin'), Buffer.alloc(filler));
        const acked = [];
        let firstFail = null;
        for (let i = 0; i < 40 && !firstFail; i++) {
          const r = await receipt(c2, 2000 + i);
          if (r.status === 200) acked.push(r.body.payment.receiptNo); else firstFail = r;
        }
        T.check('full disk: the server eventually refuses a write with an error status rather than success', !!firstFail, `${acked.length} receipts acknowledged and no failure`);
        T.check('full disk: the error is accurate (names the disk / not saved)', !firstFail || /space|disk|full|could not be saved|not saved/i.test(String(firstFail.body?.error || '')), JSON.stringify(firstFail?.body).slice(0, 200));
        let parsedOk = true; let onDisk = [];
        try { onDisk = nums(tinyData); } catch { parsedOk = false; }
        T.check('full disk: db.json is still valid JSON afterwards', parsedOk);
        T.check('full disk: every acknowledged receipt is in db.json (no false success)', acked.every(n => onDisk.includes(n)), `acked ${acked.length}, on disk ${onDisk.length}`);
        const stale = fs.readdirSync(tinyData).filter(f => f.endsWith('.tmp')).map(f => `${f}:${fs.statSync(path.join(tinyData, f)).size}`);
        console.log(`  info: temp files left on the full disk after the failed write: ${stale.join(', ') || 'none'}`);
        fs.rmSync(path.join(vol, 'filler.bin'));
        const after = await receipt(c2, 9999);
        T.check('after space is freed, writing resumes and the next number follows the last acknowledged one', after.status === 200 && Number(/(\d+)$/.exec(after.body.payment.receiptNo)[1]) === 2 + acked.length + 1, `${after.status} ${after.body?.payment?.receiptNo} acked=${acked.length}`);
      } finally {
        await srv2.stop();
        try { execFileSync('hdiutil', ['detach', vol, '-force'], { stdio: 'pipe' }); } catch { /* best effort */ }
        fs.rmSync(img, { force: true });
      }
      srv = { stop: async () => {} };
    }
  } finally {
    try { fs.chmodSync(dataDir, 0o755); fs.chmodSync(path.join(dataDir, 'db-backups'), 0o755); } catch { /* ok */ }
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
