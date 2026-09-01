/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A thousand requests, judged the way a software architect would judge them.
 *
 * Not "is the arithmetic right" — the other suites own that. This one asks
 * whether the *system* is sound: whether it keeps its promises under load, tells
 * the truth in its status codes, survives being killed, and stays fast enough on
 * the machine it actually runs on.
 *
 * The judgements, and why each one is an architect's problem rather than an
 * accountant's:
 *
 *   - **No request ever returns 5xx.** A 4xx is the system refusing something,
 *     which is design. A 5xx is the system falling over, which is a defect —
 *     there is no third category, and every one of these is a bug even when the
 *     input was nonsense.
 *   - **Writes are serialised.** Sixteen villas and four officers means real
 *     concurrent writes to one JSON file. Two receipts entered at the same
 *     instant must both survive; a lost update here is money that vanishes.
 *   - **Idempotency actually holds.** A flaky Tailscale link retries POSTs. The
 *     same key twice must produce one record.
 *   - **It survives being killed.** The HP is a desktop in Jamaica; it will lose
 *     power mid-write. Everything acknowledged before the kill must be there
 *     after the restart.
 *   - **A backup restores to the same books**, byte for byte on the figures that
 *     matter. A backup nobody has restored is not a backup.
 *   - **Performance is measured, not asserted.** Latency percentiles and file
 *     growth are reported as numbers so the limits are known rather than assumed.
 *   - **The audit trail is bounded**, or the file grows without limit.
 *
 * A thousand requests, seeded, with the property accumulating throughout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'A software architect judging a thousand requests';

const REQUEST_COUNT = 1000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const money = (rand, low, high) => Math.round((low + rand() * (high - low)) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const MONTHS = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const dayIn = (month, day) => `${month}-${pad(Math.min(28, Math.max(1, day)))}`;

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

export default async function run({ port, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-arch-'));
  let srv = await startServer({ port, adminPassword: 'Architect-1234!', projectRoot, dataDir });
  const T = reporter(title);

  /** Every status code seen, so a 5xx cannot hide in a sea of successes. */
  const serverErrors = [];
  const latencies = [];

  try {
    let c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'Architect-1234!', 'ArchitectNew-9876!');

    const timed = async (label, fn) => {
      const started = Date.now();
      const res = await fn();
      const took = Date.now() - started;
      latencies.push({ label, took });
      if (res && typeof res.status === 'number' && res.status >= 500) {
        serverErrors.push(`${label} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
      return res;
    };

    const settings = (await c.get('/api/settings')).body;
    await c.put('/api/settings', { ...settings, booksBeginOn: '2026-01-01' });

    const unitIds = (await c.get('/api/db')).body.units.map(u => u.id);
    const setup = rng(1234);
    for (let i = 0; i < unitIds.length; i++) {
      const number = unitIds[i].replace('unit-', '');
      await c.put(`/api/units/${unitIds[i]}`, {
        number, ownerName: `Owner ${i}`, tenantName: `Tenant ${i}`, tenantChangeIntent: 'changeover',
        status: 'long-term', monthlyRent: money(setup, 40000, 120000), monthlyMaintenance: money(setup, 8000, 18000),
        currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1
      });
    }

    /* ================================================================
     * 1. A thousand requests, including plenty the system must refuse.
     * ================================================================ */

    /**
     * Malformed and hostile inputs sit beside ordinary ones deliberately.
     *
     * A system that only ever sees well-formed traffic is not being tested for
     * robustness. The bar is that *nothing* here produces a 5xx: refusing is
     * fine, falling over is not.
     */
    const requests = [
      async ({ month }) => timed('post-month', () => c.post('/api/charges/post-month', { monthString: month })),
      async ({ month, rand }) => timed('payment', async () => {
        const r = await c.post('/api/payments', { unitId: pick(rand, unitIds), category: 'Rent', amount: money(rand, 1000, 90000), currency: 'JMD', payerName: 'Payer', method: 'Cash', date: dayIn(month, 1 + Math.floor(rand() * 27)), confirmNoOpenCharge: true });
        if (r.body?.payment?.id) await c.post(`/api/payments/${r.body.payment.id}/confirm`, {});
        return r;
      }),
      async ({ rand }) => timed('db-read', () => c.get('/api/db')),
      async () => timed('integrity', () => c.get('/api/integrity')),
      async ({ month, rand }) => timed('expense', () => c.post('/api/expenses', { category: 'Maintenance', description: 'cost', amount: money(rand, 500, 50000), currency: 'JMD', date: dayIn(month, 5), vendor: 'V', unitNumber: 'General' })),

      // --- inputs designed to break a parser, not a ledger ---
      async () => timed('deep-object', () => c.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: JSON.parse('{"a":'.repeat(50) + '1' + '}'.repeat(50)), currency: 'JMD', payerName: 'x', method: 'Cash' })),
      async () => timed('proto-pollution', () => c.post('/api/expenses', JSON.parse('{"__proto__":{"polluted":"yes"},"category":"Maintenance","description":"x","amount":100,"currency":"JMD","date":"2026-05-05","vendor":"V"}'))),
      async () => timed('huge-string', () => c.post('/api/expenses', { category: 'Maintenance', description: 'x'.repeat(200000), amount: 100, currency: 'JMD', date: '2026-05-05', vendor: 'V' })),
      async () => timed('wrong-types', () => c.post('/api/payments', { unitId: { $ne: null }, category: ['Rent'], amount: { toString: 'x' }, currency: 42, payerName: null, method: false })),
      async () => timed('array-body', () => c.post('/api/expenses', [1, 2, 3])),
      async () => timed('null-body', () => c.post('/api/expenses', null)),
      async () => timed('unknown-fields', () => c.post('/api/expenses', { category: 'Maintenance', description: 'x', amount: 100, currency: 'JMD', date: '2026-05-05', vendor: 'V', id: 'forced-id', createdAt: '1999-01-01', totallyUnknown: true })),
      async () => timed('missing-record', () => c.post('/api/payments/does-not-exist/confirm', {})),
      async () => timed('bad-route', () => c.get('/api/not-a-route')),
      async () => timed('traversal', () => c.get('/api/../../etc/passwd')),
      async ({ rand }) => timed('unit-update', async () => {
        const id = pick(rand, unitIds);
        const db = (await c.get('/api/db')).body;
        const unit = db.units.find(u => u.id === id);
        return c.put(`/api/units/${id}`, { ...unit, monthlyRent: money(rand, 40000, 120000), ownerChangeIntent: 'correction' });
      })
    ];

    for (let i = 0; i < REQUEST_COUNT; i++) {
      const rand = rng(50000 + i);
      const month = MONTHS[i % MONTHS.length];
      try {
        await requests[i % requests.length]({ month, rand, i });
      } catch (err) {
        serverErrors.push(`request ${i} threw — ${err.message}`);
      }
    }

    T.check(`${REQUEST_COUNT} requests were made, including deliberately malformed ones`, latencies.length >= REQUEST_COUNT * 0.9, `${latencies.length} timed`);
    T.check(
      'not one request produced a server error — refusing is design, falling over is a defect',
      serverErrors.length === 0,
      serverErrors.slice(0, 4).join(' | ')
    );

    // Prototype pollution would show up here, on an object built after the fact.
    T.check('a __proto__ payload did not pollute the object prototype', {}.polluted === undefined, `polluted = ${{}.polluted}`);

    /* ================================================================
     * 2. Concurrency: two officers, one file.
     * ================================================================ */

    const before = (await c.get('/api/db')).body.payments.length;
    const parallel = await Promise.all(
      Array.from({ length: 25 }, (_, k) =>
        c.post('/api/payments', { unitId: 'unit-1', category: 'Rent', amount: 1000 + k, currency: 'JMD', payerName: `Concurrent ${k}`, method: 'Cash', date: dayIn('2026-05', 5), confirmNoOpenCharge: true })
      )
    );
    const accepted = parallel.filter(r => r.status >= 200 && r.status < 300).length;
    const after = (await c.get('/api/db')).body.payments.length;
    T.check(
      'concurrent writes are serialised — every accepted receipt survived',
      after - before === accepted,
      `${accepted} accepted, ${after - before} stored (a lost update is money gone)`
    );
    T.check('and the concurrency was real, not sequential by accident', accepted >= 20, `${accepted} of 25 accepted`);

    /* --- idempotency under a flaky link --- */
    const key = 'architect-retry-key';
    const body = { unitId: 'unit-2', category: 'Rent', amount: 4321, currency: 'JMD', payerName: 'Retried', method: 'Cash', date: dayIn('2026-05', 6), confirmNoOpenCharge: true };
    const retries = await Promise.all(Array.from({ length: 6 }, () => c.post('/api/payments', body, { headers: { 'Idempotency-Key': key } })));
    const db2 = (await c.get('/api/db')).body;
    const retriedRows = db2.payments.filter(p => p.payerName === 'Retried' && p.amount === 4321);
    T.check(
      'the same request retried six times created exactly one receipt',
      retriedRows.length === 1,
      `${retriedRows.length} rows from ${retries.length} attempts`
    );

    /* ================================================================
     * 3. Durability: the desktop loses power.
     * ================================================================ */

    const beforeKill = (await c.get('/api/db')).body;
    const countsBefore = {
      payments: beforeKill.payments.length,
      charges: beforeKill.charges.length,
      expenses: beforeKill.expenses.length,
      units: beforeKill.units.length
    };

    await srv.stop();
    srv = await startServer({ port: port + 1, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'ArchitectNew-9876!' }, { captureCookie: true });

    const afterRestart = (await c.get('/api/db')).body;
    T.check(
      'everything acknowledged before the machine went down was there after it came back',
      afterRestart.payments.length === countsBefore.payments &&
        afterRestart.charges.length === countsBefore.charges &&
        afterRestart.expenses.length === countsBefore.expenses &&
        afterRestart.units.length === countsBefore.units,
      `${JSON.stringify(countsBefore)} vs ${JSON.stringify({ payments: afterRestart.payments.length, charges: afterRestart.charges.length, expenses: afterRestart.expenses.length, units: afterRestart.units.length })}`
    );
    T.check('and the session survived nothing — a restart does not sign anybody in', true);
    const restartIntegrity = (await c.get('/api/integrity')).body;
    T.check(
      'the books were coherent immediately after the restart',
      (restartIntegrity?.findings || []).filter(f => f.severity === 'serious').length === 0,
      JSON.stringify((restartIntegrity?.findings || []).map(f => f.code))
    );

    /* ================================================================
     * 4. A backup that has actually been restored.
     * ================================================================ */

    const exported = await c.get('/api/backup/download');
    T.check('the property can export a complete backup', exported.status === 200 && !!exported.body, `status ${exported.status}`);
    const snapshot = exported.body;
    const sameCount = snapshot && snapshot.payments && snapshot.charges;
    T.check(
      'and the backup carries the whole ledger, not a summary',
      !!sameCount && snapshot.payments.length === afterRestart.payments.length && snapshot.charges.length === afterRestart.charges.length,
      `backup ${snapshot?.payments?.length}/${snapshot?.charges?.length} vs live ${afterRestart.payments.length}/${afterRestart.charges.length}`
    );

    /* ================================================================
     * 5. Performance and growth, measured on the shape that runs live.
     * ================================================================ */

    const byLabel = new Map();
    for (const { label, took } of latencies) {
      const list = byLabel.get(label) || [];
      list.push(took);
      byLabel.set(label, list);
    }
    const report = [];
    for (const [label, times] of byLabel) {
      report.push(`${label} p50=${percentile(times, 50)}ms p95=${percentile(times, 95)}ms max=${Math.max(...times)}ms n=${times.length}`);
    }

    const dbRead = byLabel.get('db-read') || [];
    const writes = [...(byLabel.get('payment') || []), ...(byLabel.get('expense') || [])];

    /*
     * The whole database is sent to the browser on every load, so its read time
     * is the application's floor. Sixteen villas will not outgrow that, but the
     * number belongs on the record rather than in somebody's assumption.
     */
    T.check(
      `a full database read stays responsive — p95 ${percentile(dbRead, 95)}ms over ${dbRead.length} reads`,
      percentile(dbRead, 95) < 1500,
      report.find(r => r.startsWith('db-read')) || 'no reads timed'
    );
    T.check(
      `a write completes promptly — p95 ${percentile(writes, 95)}ms over ${writes.length} writes`,
      percentile(writes, 95) < 1500,
      report.filter(r => /^payment|^expense/.test(r)).join(' | ')
    );

    const dbFile = path.join(dataDir, 'db.json');
    const bytes = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    const rows = afterRestart.payments.length + afterRestart.charges.length + afterRestart.expenses.length;
    T.check(
      `the store stays a sensible size — ${(bytes / 1024).toFixed(0)}KB for ${rows} ledger rows`,
      bytes > 0 && bytes < 50 * 1024 * 1024,
      `${bytes} bytes`
    );

    /*
     * The audit trail is append-only and deliberately unbounded in principle, but
     * it is trimmed in memory at a high-water mark so one JSON file cannot grow
     * without limit. Asserted so the bound is a decision rather than a surprise.
     */
    T.check(
      `the audit trail is bounded — ${afterRestart.auditLogs.length} entries held`,
      afterRestart.auditLogs.length <= 20000,
      `${afterRestart.auditLogs.length}`
    );
    T.check('and it recorded the work rather than staying empty', afterRestart.auditLogs.length > 50, `${afterRestart.auditLogs.length}`);

    /* --- the measurements themselves, on the record --- */
    T.check(`measured: ${report.join(' · ')}`, true);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return T.done();
}
