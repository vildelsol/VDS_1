/**
 * Interrupted requests: abort the connection mid-flight, then check the state is all-or-nothing,
 * the audit log agrees, and a retry with the same Idempotency-Key does not double-apply.
 */
import http from 'node:http';
import { reporter, sleep } from './harness.mjs';
import { boot, seedUnit, rent, invariants, auditFor } from './concurrency-util.mjs';

export const title = 'Concurrency: aborted requests and idempotent retry';

export default async function run({ port, projectRoot }) {
  const { srv, a } = await boot({ port, projectRoot });
  const T = reporter(title);
  const db = async () => (await a.get('/api/db')).body;
  const inv = async label => { const v = invariants(await db()); T.check(`${label}: invariants hold`, v.length === 0, v.join('; ')); };
  const cookie = () => a.getCookie();
  const raw = (method, p, body, key, signal) =>
    fetch(srv.baseUrl + p, { method, signal, headers: { 'Content-Type': 'application/json', Cookie: cookie(), ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) }).then(r => r.status, e => 'aborted');
  /** Send a complete request over a raw socket, wait `waitMs` so the server has parsed it and queued the transaction, then destroy the socket. */
  const rawKill = (method, p, body, key, waitMs) => new Promise(resolve => {
    const data = JSON.stringify(body);
    const u = new URL(srv.baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Cookie: cookie(), ...(key ? { 'Idempotency-Key': key } : {}) } });
    req.on('error', () => {});
    req.end(data);
    setTimeout(() => { req.destroy(); resolve(); }, waitMs);
  });
  try {
    await seedUnit(a);

    // 1. abort mid-flight, no retry: all or nothing, audit agrees
    const results = [];
    for (let i = 0; i < 25; i++) {
      const ac = new AbortController();
      const body = { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 1000 + i };
      const p = raw('POST', '/api/charges', body, `abort-${i}`, ac.signal);
      if (i % 2) ac.abort(); else setTimeout(() => ac.abort(), 1);
      results.push(await p);
    }
    await sleep(800);
    let d = await db();
    let partial = 0, applied = 0;
    for (let i = 0; i < 25; i++) {
      const ch = d.charges.filter(c => c.kind === 'one-off' && c.amount === 1000 + i);
      const au = d.auditLogs.filter(x => /Raised a one-off/.test(x.action) && ch.some(c => c.id === x.recordId));
      if (ch.length > 1 || ch.length !== au.length) partial++;
      if (ch.length === 1) applied++;
    }
    T.check(`abort x25: every aborted charge is fully applied (charge+audit) or absent (applied ${applied}, aborted client-side ${results.filter(r => r === 'aborted').length})`, partial === 0, `${partial} inconsistent`);
    await inv('abort no-retry');

    // 3. kill the connection of a refund mid-flight, then retry plainly
    const adv = (await a.post('/api/payments', rent({ amount: 20000000, receivedNow: true, advancePayment: true, confirmDuplicate: true }))).body.payment;
    await rawKill('POST', `/api/payments/${adv.id}/refund`, { amount: 3000, reason: 'abort refund', method: 'Cash' }, 'rf-1', 30); await sleep(500);
    const retry = await a.post(`/api/payments/${adv.id}/refund`, { amount: 3000, reason: 'abort refund', method: 'Cash' }, { headers: { 'Idempotency-Key': 'rf-1' } });
    d = await db();
    const pr = d.payments.find(p => p.id === adv.id);
    T.check('aborted refund then retry: refunded exactly 3000 once, one audit entry', pr.refundedAmount === 3000 && auditFor(d, adv.id, /Refunded/).length === 1, `${pr.refundedAmount} ${retry.status} ${retry.body?.error}`);
    await inv('abort refund');

    // bloat the books so every transaction takes long enough to leave later requests queued
    for (let k = 0; k < 4; k++) await Promise.all(Array.from({ length: 100 }, (_, j) => a.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 1 + j + k * 100 })));
    const t0 = Date.now(); await a.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 99999 });
    console.log(`  (one transaction now takes ~${Date.now() - t0} ms)`);

    {
      const backlog = Array.from({ length: 120 }, (_, j) => a.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 400 + j }));
      await rawKill('POST', '/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 123456.78 }, 'queued-kill', 30);
      await Promise.all(backlog); await sleep(300);
      const n = (await db()).charges.filter(c => c.amount === 123456.78).length;
      T.check('request destroyed while queued behind a backlog is still applied exactly once (client got no reply)', n === 1, String(n));
    }
    // 2. abort and immediately retry with the SAME key, behind a backlog so the first is still queued
    let dupCharges = 0, dupPayments = 0;
    for (let i = 0; i < 15; i++) {
      const backlog = Array.from({ length: 120 }, (_, j) => a.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 5000 + j + i * 100 }));
      const body = { unitId: 'unit-1', category: 'Rent', oneOffType: 'Other', amount: 9000.5 + i };
      const key = `retry-${i}-${Date.now()}`;
      await rawKill('POST', '/api/charges', body, key, 30);
      const t1 = Date.now(); const second = fetch(srv.baseUrl + '/api/charges', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const sr = await second; if (i < 3) console.log('  (retry status', sr.status, 'replayed=', sr.headers.get('idempotent-replayed'), (Date.now() - t1) + 'ms )');
      await Promise.all(backlog);
    }
    await sleep(500);
    d = await db();
    console.log('  (per-key counts', JSON.stringify(Array.from({ length: 15 }, (_, i) => d.charges.filter(c => c.kind === 'one-off' && c.amount === 9000.5 + i).length)), ')');
    for (let i = 0; i < 15; i++) if (d.charges.filter(c => c.kind === 'one-off' && c.amount === 9000.5 + i).length > 1) dupCharges++;
    T.check('abort + same-key retry: one-off charge is applied exactly once per key (EXPECTED 0 doubles)', dupCharges === 0, `${dupCharges} of 15 keys billed twice`);

    // same for a receipt the cashier already confirmed as separate money (confirmDuplicate) - advance receipts
    for (let i = 0; i < 15; i++) {
      const backlog = Array.from({ length: 120 }, (_, j) => a.post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 20000 + j + i * 100 }));
      const body = rent({ amount: 333.33 + i, receivedNow: true, advancePayment: true, confirmDuplicate: true });
      const key = `payretry-${i}-${Date.now()}`;
      await rawKill('POST', '/api/payments', body, key, 30);
      const second = raw('POST', '/api/payments', body, key);
      await Promise.all([...backlog, second]);
    }
    await sleep(500);
    d = await db();
    for (let i = 0; i < 15; i++) if (d.payments.filter(p => p.amount === 333.33 + i && p.status === 'completed').length > 1) dupPayments++;
    T.check('abort + same-key retry: receipt is banked exactly once per key (EXPECTED 0 doubles)', dupPayments === 0, `${dupPayments} of 15 keys banked twice`);
    await inv('abort + retry');

  } finally {
    await srv.stop();
  }
  return T.done();
}
