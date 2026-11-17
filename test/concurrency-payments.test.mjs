/**
 * Parallel attacks on payments: duplicate submit, confirm, refund, reverse, void races, receipt numbers.
 */
import { reporter } from './harness.mjs';
import { boot, seedUnit, rent, recompute, balance, invariants, auditFor, count, lastMonth } from './concurrency-util.mjs';

export const title = 'Concurrency: payments';

export default async function run({ port, projectRoot }) {
  const { srv, a, b } = await boot({ port, projectRoot });
  const T = reporter(title);
  const db = async () => (await a.get('/api/db')).body;
  const inv = async label => { const v = invariants(await db()); T.check(`${label}: invariants hold`, v.length === 0, v.join('; ')); };
  try {
    await seedUnit(a);
    const N = 20;
    const clients = i => (i % 2 ? a : b);

    // 1. same pending payment submitted N times in parallel (no confirmDuplicate)
    let rs = await Promise.all(Array.from({ length: N }, (_, i) => clients(i).post('/api/payments', rent({ amount: 1234, confirmAlreadySettled: true }))));
    let d = await db();
    let ok = rs.filter(r => r.status === 200).length;
    T.check('same payment x20 in parallel: exactly one accepted', ok === 1, `accepted ${ok}`);
    T.check('the rest carry possible-duplicate-payment', rs.filter(r => r.status !== 200).every(r => r.body?.code === 'possible-duplicate-payment'), JSON.stringify(rs.filter(r => r.status !== 200).map(r => r.body?.code).slice(0, 3)));
    T.check('exactly one 1234 row stored', d.payments.filter(p => p.amount === 1234).length === 1);
    T.check('audit has one entry per stored payment', auditFor(d, d.payments.find(p => p.amount === 1234).id).length === 1);
    await inv('dup submit');

    // 1b. same, receivedNow
    rs = await Promise.all(Array.from({ length: N }, (_, i) => clients(i).post('/api/payments', rent({ amount: 777, receivedNow: true, confirmAlreadySettled: true }))));
    d = await db();
    T.check('receivedNow duplicate x20: exactly one receipt', d.payments.filter(p => p.amount === 777 && p.status === 'completed').length === 1);
    await inv('dup receivedNow');

    // 2. confirm the same pending payment N times
    const pend = (await a.post('/api/payments', rent({ amount: 555, confirmAlreadySettled: true }))).body.payment;
    rs = await Promise.all(Array.from({ length: N }, (_, i) => clients(i).post(`/api/payments/${pend.id}/confirm`, {})));
    d = await db();
    const pc = d.payments.find(p => p.id === pend.id);
    T.check('confirm x20: exactly one 200', rs.filter(r => r.status === 200).length === 1, String(rs.filter(r => r.status === 200).length));
    T.check('confirm x20: one confirm audit entry', auditFor(d, pend.id, /Confirmed receipt/).length === 1, String(auditFor(d, pend.id, /Confirmed receipt/).length));
    T.check('receipt number issued once and matches the 200 reply', rs.find(r => r.status === 200)?.body?.payment?.receiptNo === pc.receiptNo);
    await inv('confirm race');

    // 3. refund same receipt N times (needs unspent credit): advance payment
    const adv = (await a.post('/api/payments', rent({ amount: 90000, receivedNow: true, advancePayment: true, confirmDuplicate: true }))).body.payment;
    const credit0 = -balance(await db(), 'unit-1', 'Rent');
    rs = await Promise.all(Array.from({ length: N }, (_, i) => clients(i).post(`/api/payments/${adv.id}/refund`, { amount: 20000, reason: 'refund race', method: 'Cash' })));
    d = await db();
    const pr = d.payments.find(p => p.id === adv.id);
    T.check('refund x20: exactly one accepted', rs.filter(r => r.status === 200).length === 1, String(rs.filter(r => r.status === 200).length));
    T.check('refunded amount is 20000 not a multiple', pr.refundedAmount === 20000, String(pr.refundedAmount));
    T.check('one refund audit entry', auditFor(d, adv.id, /Refunded/).length === 1);
    T.check('independent balance moved by exactly one refund', -balance(d, 'unit-1', 'Rent') === credit0 - 2000000, `${credit0} -> ${-balance(d, 'unit-1', 'Rent')}`);
    await inv('refund race');

    // 4. reverse and refund the same receipt in parallel
    const adv2 = (await a.post('/api/payments', rent({ amount: 5000, receivedNow: true, advancePayment: true, confirmDuplicate: true }))).body.payment;
    rs = await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2
      ? a.post(`/api/payments/${adv2.id}/refund`, { amount: 1000, reason: 'race', method: 'Cash' })
      : b.post(`/api/payments/${adv2.id}/reverse`, { reversalReason: 'race void' })));
    d = await db();
    const p2 = d.payments.find(p => p.id === adv2.id);
    T.check('reverse vs refund: not both applied', !(p2.status === 'reversed' && p2.refundedAmount), JSON.stringify({ s: p2.status, r: p2.refundedAmount }));
    T.check('reverse vs refund: exactly one winner', rs.filter(r => r.status === 200).length === 1, String(rs.filter(r => r.status === 200).length));
    await inv('reverse vs refund');

    // 5. confirm racing a void on a pending payment
    const pend2 = (await a.post('/api/payments', rent({ amount: 4321, confirmAlreadySettled: true }))).body.payment;
    rs = await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2
      ? a.post(`/api/payments/${pend2.id}/confirm`, {})
      : b.post(`/api/payments/${pend2.id}/reverse`, { reversalReason: 'race cancel' })));
    d = await db();
    const p3 = d.payments.find(p => p.id === pend2.id);
    T.check('confirm vs void: exactly one winner', rs.filter(r => r.status === 200).length === 1);
    T.check('confirm vs void: state coherent (reversed => no live receipt counted; completed => has receipt)', (p3.status === 'reversed') || (p3.status === 'completed' && !!p3.receiptNo), p3.status);
    T.check('confirm vs void: one terminal audit entry', auditFor(d, pend2.id, /Confirmed receipt|Cancelled an expected|Voided receipt/).length === 1);
    await inv('confirm vs void');

    // 6. parallel receipt-number allocation, many distinct receipts
    const before = (await db()).payments.length;
    rs = await Promise.all(Array.from({ length: 30 }, (_, i) => clients(i).post('/api/payments', rent({ amount: 10 + i, receivedNow: true, confirmDuplicate: true, advancePayment: true }))));
    d = await db();
    const made = rs.filter(r => r.status === 200).length;
    T.check('30 distinct receipts accepted', made === 30, `${made} ok; ${[...new Set(rs.filter(r => r.status !== 200).map(r => r.body?.error?.slice(0, 80)))]}`);
    T.check('payments added match accepted count', d.payments.length === before + made);
    const seqs = d.payments.filter(p => p.receiptNo).map(p => Number(p.receiptNo.split('-')[2])).sort((x, y) => x - y);
    T.check('receipt numbers gap-free', seqs.every((n, i) => n === i + 1), seqs.join(','));
    await inv('receipt allocation');

    // 7. idempotent retry with same body + same key, in parallel
    const key = `k-${Date.now()}`;
    rs = await Promise.all(Array.from({ length: 10 }, () => a.post('/api/payments', rent({ amount: 31.37, receivedNow: true, confirmDuplicate: true, advancePayment: true }), { headers: { 'Idempotency-Key': key } })));
    d = await db();
    T.check('same Idempotency-Key x10 parallel: one payment stored', d.payments.filter(p => p.amount === 31.37).length === 1, String(d.payments.filter(p => p.amount === 31.37).length));
    const after = await a.post('/api/payments', rent({ amount: 31.37, receivedNow: true, confirmDuplicate: true, advancePayment: true }), { headers: { 'Idempotency-Key': key } });
    T.check('sequential retry replays', after.status === 200 && (await db()).payments.filter(p => p.amount === 31.37).length === 1);

    // 8. retry without a key, no confirmDuplicate (double click)
    const body = rent({ amount: 41.41, confirmAlreadySettled: true });
    const r1 = await a.post('/api/payments', body); const r2 = await a.post('/api/payments', body);
    T.check('keyless immediate retry refused as possible duplicate', r1.status === 200 && r2.status === 400 && r2.body?.code === 'possible-duplicate-payment');

    // 9. an expected-payment backlog: same date/amount but entered > window? (not run: needs 10 min clock)
    // 10. final books recompute: every completed payment counted once
    d = await db();
    const sumPaid = d.payments.filter(p => p.status === 'completed' && p.category === 'Rent').reduce((s, p) => s + Math.round(p.amount * 100) - Math.round((p.refundedAmount || 0) * 100), 0);
    const owed = d.charges.filter(c => c.status === 'open' && c.category === 'Rent').reduce((s, c) => s + Math.round(c.amount * 100), 0);
    T.check('independent final balance = charges - net receipts', balance(d, 'unit-1', 'Rent') === owed - sumPaid);
    await inv('final');
  } finally {
    await srv.stop();
  }
  return T.done();
}
