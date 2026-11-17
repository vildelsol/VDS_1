/**
 * Shared helpers for the concurrency-* suites: an independent recompute of the
 * books from raw /api/db rows (it deliberately does NOT use the app's balance
 * function) and structural invariant checks.
 */
import { startServer, makeClient, activateAdmin, makeLongTermUnit } from './harness.mjs';

export function lastMonth() {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}

export async function boot({ port, projectRoot, pw = 'Conc-1234!' }) {
  const srv = await startServer({ port, adminPassword: pw, projectRoot });
  const a = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
  await activateAdmin(a, pw, 'ConcNew-9876!');
  const b = makeClient(srv.baseUrl, { autoConfirmDuplicates: false });
  await a.post('/api/users', { name: 'Second Officer', username: 'second', role: 'ADMINISTRATOR', password: 'Second-1234!' });
  await b.post('/api/auth/login', { username: 'second', password: 'Second-1234!' }, { captureCookie: true });
  // Second user is forced to change password on first login in some builds; try, ignore result.
  await b.post('/api/auth/change-password', { currentPassword: 'Second-1234!', newPassword: 'SecondNew-9876!' });
  return { srv, a, b };
}

export async function seedUnit(c, month = lastMonth()) {
  await makeLongTermUnit(c);
  return c.post('/api/charges/post-month', { monthString: month });
}

export const rent = (over = {}) => ({
  unitId: 'unit-1', category: 'Rent', amount: 1000, currency: 'JMD', payerName: 'Tenant', method: 'Cash', ...over
});

const cents = x => Math.round(Number(x) * 100);

/** Independent balance in cents (owed minus net received), keyed unit|category|currency. Positive = owed. */
export function recompute(d) {
  const m = new Map();
  const add = (k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const c of d.charges) if (c.status === 'open') add(`${c.unitId}|${c.category}|${c.currency}`, cents(c.amount));
  for (const p of d.payments) if (p.status === 'completed') add(`${p.unitId}|${p.category}|${p.currency}`, -(cents(p.amount) - cents(p.refundedAmount || 0)));
  return m;
}
export const balance = (d, unit, cat, cur = 'JMD') => recompute(d).get(`${unit}|${cat}|${cur}`) || 0;

/** Structural invariants. Returns a list of violation strings (empty = clean). */
export function invariants(d) {
  const v = [];
  const dup = (arr, f) => { const seen = new Set(), out = new Set(); for (const x of arr) { const k = f(x); if (seen.has(k)) out.add(k); seen.add(k); } return [...out]; };
  const nums = d.payments.filter(p => p.receiptNo);
  const dn = dup(nums, p => p.receiptNo);
  if (dn.length) v.push(`duplicate receipt numbers: ${dn.join(',')}`);
  const dp = dup(d.payments, p => p.id);
  if (dp.length) v.push(`duplicate payment ids: ${dp.join(',')}`);
  const dc = dup(d.charges, c => c.id);
  if (dc.length) v.push(`duplicate charge ids: ${dc.join(',')}`);
  const da = dup(d.auditLogs, a => a.id);
  if (da.length) v.push(`duplicate audit ids: ${da.length}`);
  const dm = dup(d.charges.filter(c => c.status === 'open' && c.kind === undefined), c => `${c.unitId}|${c.category}|${c.periodMonth}`);
  if (dm.length) v.push(`duplicate monthly charges: ${dm.join(',')}`);
  for (const p of d.payments) {
    if (p.status === 'completed' && !p.receiptNo) v.push(`completed payment ${p.id} has no receipt number`);
    if (p.status !== 'completed' && p.receiptNo && p.status === 'pending') v.push(`pending payment ${p.id} carries receipt ${p.receiptNo}`);
    if (p.status === 'reversed' && p.refundedAmount) v.push(`payment ${p.id} is both voided and refunded`);
    if ((p.refundedAmount || 0) > p.amount) v.push(`payment ${p.id} refunded more than received`);
  }
  // audit chain: newest first, each entry's prevSeal is the seal of the one before it in time (next in array)
  for (let i = 0; i < d.auditLogs.length - 1; i++) {
    if ((d.auditLogs[i].prevSeal || '') !== (d.auditLogs[i + 1].seal || '')) { v.push(`audit chain broken at index ${i}`); break; }
  }
  return v;
}

export const auditFor = (d, recordId, re) => d.auditLogs.filter(a => a.recordId === recordId && (!re || re.test(a.action)));
export const statuses = rs => rs.map(r => r.status);
export const count = (rs, s) => rs.filter(r => r.status === s).length;
