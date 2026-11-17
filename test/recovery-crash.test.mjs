/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovery attack 2: kill -9 in the middle of a burst of writes.
 *
 * Twelve rounds: fire a burst of concurrent receipts, SIGKILL the server at a
 * random moment, restart on the SAME data directory, and check that db.json is
 * valid JSON, every receipt the server acknowledged (HTTP 200) is on disk, receipt
 * numbers are unique and the counter is not behind them, the integrity endpoint is
 * clean and no write was half applied (the audit trail and the payments agree).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit, sleep } from './harness.mjs';

export const title = 'Recovery: kill -9 during writes';
const ROUNDS = 12;

function pidOnPort(port) {
  try { return Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]); } catch { return 0; }
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  // Needs POSIX permissions / signals / disk images; the Windows build runner cannot exercise it faithfully.
  if (process.platform === 'win32') {
    console.log('  info: NOT RUN on Windows (POSIX permissions, SIGKILL semantics and disk images)');
    return T.done();
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-crash-'));
  const dbPath = path.join(dataDir, 'db.json');
  let srv = await startServer({ port, adminPassword: 'Crash-1234!', projectRoot, dataDir });
  const acked = new Map(); // id -> receiptNo
  const ackedNos = new Set();
  let problems = [];
  try {
    let admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Crash-1234!', 'CrashNew-9876!');
    await makeLongTermUnit(admin, 'unit-1');
    await admin.post('/api/charges/post-month', { monthString: '2026-09' });
    let lastCookie = admin.getCookie();

    for (let round = 1; round <= ROUNDS; round++) {
      const pid = pidOnPort(port);
      const burst = [];
      for (let i = 0; i < 30; i++) {
        burst.push(
          admin.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 100 + round * 31 + i, currency: 'JMD', date: '2026-10-01', payerName: 'Burst', method: 'Cash', advancePayment: true, receivedNow: true })
            .then(r => { if (r.status === 200 && r.body?.payment?.id) { acked.set(r.body.payment.id, r.body.payment.receiptNo); ackedNos.add(r.body.payment.receiptNo); } return r.status; })
            .catch(() => 'conn')
        );
      }
      await sleep(15 + Math.floor(Math.random() * 250));
      try { process.kill(pid, 'SIGKILL'); } catch { problems.push(`round ${round}: could not find server pid`); }
      await Promise.all(burst);
      await sleep(300);

      // The file as the dead process left it.
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (e) { problems.push(`round ${round}: db.json is not valid JSON after SIGKILL (${e.message})`); }
      const leftovers = fs.readdirSync(dataDir).filter(f => f.endsWith('.tmp'));
      if (parsed) {
        const have = new Map(parsed.payments.map(p => [p.id, p]));
        const lost = [...acked].filter(([id]) => !have.has(id));
        if (lost.length) problems.push(`round ${round}: ${lost.length} acknowledged receipt(s) missing from db.json: ${lost.map(l => l[1]).join(',')}`);
        const nos = parsed.payments.map(p => p.receiptNo).filter(Boolean);
        if (new Set(nos).size !== nos.length) problems.push(`round ${round}: duplicate receipt numbers on disk`);
        const maxNo = Math.max(0, ...nos.map(n => Number(/(\d+)$/.exec(n)[1])));
        if (parsed.counters.receiptSeq < maxNo) problems.push(`round ${round}: counter ${parsed.counters.receiptSeq} is behind highest receipt ${maxNo}`);
        const audited = parsed.auditLogs.filter(a => /^Received/.test(a.action)).length;
        const live = parsed.payments.filter(p => p.status === 'completed').length;
        if (audited !== live) problems.push(`round ${round}: ${live} receipts but ${audited} audit entries (half-applied write)`);
      }
      if (leftovers.length) console.log(`  info: round ${round}: stale temp file(s) left in data dir: ${leftovers.join(', ')}`);

      // Restart on the same data.
      try {
        srv = await startServer({ port, adminPassword: 'Crash-1234!', projectRoot, dataDir });
      } catch (e) { problems.push(`round ${round}: server did not restart: ${String(e.message).slice(0, 300)}`); break; }
      admin = makeClient(srv.baseUrl);
      const login = await admin.post('/api/auth/login', { username: 'admin', password: 'CrashNew-9876!' }, { captureCookie: true });
      if (login.status !== 200) { problems.push(`round ${round}: admin cannot sign in after crash (${login.status})`); break; }
      const integ = (await admin.get('/api/integrity')).body;
      if (!integ.ok) problems.push(`round ${round}: integrity not clean after restart: ${JSON.stringify(integ.findings).slice(0, 200)}`);
      const d = (await admin.get('/api/db')).body;
      for (const [id, no] of acked) if (!d.payments.some(p => p.id === id && p.receiptNo === no)) { problems.push(`round ${round}: API lacks acknowledged receipt ${no}`); break; }
    }
    T.check(`${ROUNDS} SIGKILL rounds: db.json always valid, no acknowledged receipt lost, no duplicate numbers, counter never behind, integrity clean, audit agrees`, problems.length === 0, problems.slice(0, 6).join(' | '));
    T.check('a meaningful number of writes were acknowledged across the rounds', acked.size >= ROUNDS, `${acked.size} acknowledged`);
    console.log(`  info: ${acked.size} receipts acknowledged across ${ROUNDS} kills`);
    const idem = path.join(dataDir, 'idempotency.json');
    if (fs.existsSync(idem)) { let ok = true; try { JSON.parse(fs.readFileSync(idem, 'utf8')); } catch { ok = false; } T.check('idempotency.json is valid after kills', ok); }
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}
