/**
 * Kill -9 the server in the middle of a burst of writes, restart on the same data directory,
 * and check the books are whole: parseable, invariants hold, every payment has exactly one
 * creation audit entry and every creation audit entry has its payment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, activateAdmin, reporter, sleep } from './harness.mjs';
import { seedUnit, rent, invariants } from './concurrency-util.mjs';

export const title = 'Concurrency: hard kill mid-burst';

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-crash-'));
  const T = reporter(title);
  if (process.platform === 'win32') {
    console.log('  info: NOT RUN on Windows (SIGKILL semantics)');
    return T.done();
  }
  let srv = await startServer({ port, adminPassword: 'Crash-1234!', projectRoot, dataDir });
  try {
    let c = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
    await activateAdmin(c, 'Crash-1234!', 'CrashNew-9876!');
    await seedUnit(c);
    for (let round = 0; round < 3; round++) {
      const burst = Array.from({ length: 80 }, (_, i) => c.post('/api/payments', rent({ amount: 10 + i + round * 100, receivedNow: true, advancePayment: true, confirmDuplicate: true })).catch(() => null));
      await sleep(25 + round * 15);
      await killServer(port);
      await Promise.allSettled(burst);
      srv = await startServer({ port, adminPassword: 'Crash-1234!', projectRoot, dataDir });
      c = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
      await c.post('/api/auth/login', { username: 'admin', password: 'CrashNew-9876!' }, { captureCookie: true });
      const d = (await c.get('/api/db')).body;
      T.check(`round ${round}: server restarted and db is readable (${d.payments?.length} payments)`, Array.isArray(d.payments));
      const v = invariants(d);
      T.check(`round ${round}: invariants hold after kill -9`, v.length === 0, v.join('; '));
      const created = d.auditLogs.filter(a => a.recordType === 'Payment' && /^Received /.test(a.action));
      const ids = new Set(d.payments.map(p => p.id));
      T.check(`round ${round}: every payment has exactly one creation audit entry`, d.payments.every(p => created.filter(a => a.recordId === p.id).length === 1));
      T.check(`round ${round}: no audit entry without a payment`, created.every(a => ids.has(a.recordId)));
      const leftovers = fs.readdirSync(dataDir).filter(f => /\.tmp$|\.partial$/.test(f));
      T.check(`round ${round}: no half-written temp file left behind`, leftovers.length === 0, leftovers.join(','));
    }
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return T.done();
}

import { execSync } from 'node:child_process';
function killServer(port) {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`).toString().trim().split('\n').filter(Boolean);
    for (const p of pids) process.kill(Number(p), 'SIGKILL');
  } catch { /* nothing listening */ }
  return sleep(300);
}
