/**
 * Shared helpers for the recovery-* suites: a realistic dataset built only through
 * the API, and an independent recompute of every account balance from raw rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { makeLongTermUnit, recordAndConfirmPayment } from './harness.mjs';

export async function bundleFinance(projectRoot, outDir) {
  const outfile = path.join(outDir, 'fin.mjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'lib', 'finance.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  return import(pathToFileURL(outfile).href + '?' + Date.now());
}

const cents = x => Math.round(x * 100);

/** Owed (open charges minus net completed receipts) per unit|category|currency, in cents, from raw rows only. */
export function rawBalances(d) {
  const m = new Map();
  const add = (k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const c of d.charges) if (c.status === 'open') add(`${c.unitId}|${c.category}|${c.currency}`, cents(c.amount));
  for (const p of d.payments) if (p.status === 'completed') add(`${p.unitId}|${p.category}|${p.currency}`, -(cents(p.amount) - cents(p.refundedAmount || 0)));
  for (const [k, v] of [...m]) if (v === 0) m.delete(k);
  return m;
}
export const mapStr = m => JSON.stringify([...m].sort());

/** A realistic property: 3 let villas (JMD and USD), 5 months of charges, receipts, a void, a refund, advance credit, expenses. */
export async function buildDataset(admin) {
  await makeLongTermUnit(admin, 'unit-1');
  await makeLongTermUnit(admin, 'unit-2', { monthlyRent: 800, monthlyMaintenance: 100, currency: 'USD', maintCurrency: 'USD' });
  await makeLongTermUnit(admin, 'unit-3', { monthlyRent: 75000, monthlyMaintenance: 20000 });
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) await admin.post('/api/charges/post-month', { monthString: m });
  const pay = (unitId, category, amount, currency, date, extra = {}) =>
    recordAndConfirmPayment(admin, { unitId, category, amount, currency, date, payerName: 'Payer', method: 'Cash', ...extra });
  const receipts = [];
  const note = r => { if (r.body?.payment?.receiptNo) receipts.push({ no: r.body.payment.receiptNo, id: r.body.payment.id, amount: r.body.payment.amount }); return r; };
  note(await pay('unit-1', 'Rent', 50000, 'JMD', '2026-05-03'));
  note(await pay('unit-1', 'Rent', 50000, 'JMD', '2026-06-03'));
  note(await pay('unit-1', 'Maintenance', 10000, 'JMD', '2026-06-04'));
  const toVoid = note(await pay('unit-1', 'Rent', 20000, 'JMD', '2026-07-02'));
  note(await pay('unit-2', 'Rent', 800, 'USD', '2026-05-04'));
  note(await pay('unit-2', 'Rent', 400, 'USD', '2026-06-04'));
  note(await pay('unit-3', 'Rent', 75000, 'JMD', '2026-05-05'));
  const adv = note(await pay('unit-3', 'Rent', 400000, 'JMD', '2026-07-05', { advancePayment: true }));
  const voidRes = await admin.post(`/api/payments/${toVoid.body.payment.id}/reverse`, { reversalReason: 'entered in error' });
  const refundRes = await admin.post(`/api/payments/${adv.body.payment.id}/refund`, { amount: 5000, refundedOn: '2026-07-20', method: 'Bank Transfer', reason: 'Returned part of advance' });
  const ex1 = await admin.post('/api/expenses', { category: 'Landscaping', amount: 50000, currency: 'JMD', date: '2026-06-20', description: 'Gardening', vendor: 'A gardener' });
  const ex2 = await admin.post('/api/expenses', { unitId: 'unit-1', category: 'Maintenance', amount: 15000, currency: 'JMD', date: '2026-08-20', description: 'Plumbing', vendor: 'A plumber' });
  const exVoid = await admin.post('/api/expenses', { category: 'Landscaping', amount: 999, currency: 'JMD', date: '2026-08-21', description: 'wrong', vendor: 'x' });
  const exId = exVoid.body?.expense?.id;
  const exVoidRes = exId ? await admin.post(`/api/expenses/${exId}/void`, { reason: 'duplicate entry', confirmSettled: true }) : { status: 0 };
  return { receipts, voidStatus: voidRes.status, refundStatus: refundRes.status, expenseStatus: [ex1.status, ex2.status, exVoid.status, exVoidRes.status] };
}

export const todayStamp = () => {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

import { spawn } from 'node:child_process';

/** Boot the server on a data dir and report whether it came up, or exited, and what it said. */
export async function tryBoot({ port, projectRoot, dataDir, adminPassword = 'Recov-1234!', env = {} }) {
  const child = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), VDS_DATA_DIR: dataDir, VDS_ADMIN_PASSWORD: adminPassword, VDS_BACKUP_DIR: '', VDS_TRUST_PROXY: '', VDS_FORCE_SECURE_COOKIE: '', VDS_DRIVE_ROOTS: '', VDS_DRIVE_ROOTS_ONLY: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));
  let exitCode = null;
  child.on('exit', c => (exitCode = c ?? -1));
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline && exitCode === null) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  const stop = async () => { if (exitCode === null) { child.kill('SIGKILL'); await new Promise(r => setTimeout(r, 200)); } };
  return { up, exitCode, log: () => log, stop, baseUrl: `http://127.0.0.1:${port}` };
}
