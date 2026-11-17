/**
 * Parallel attacks on charges and unit/payment edits: post-month x N, one-offs, void races, lost updates, id collisions.
 */
import { reporter } from './harness.mjs';
import { boot, seedUnit, rent, balance, invariants, auditFor, lastMonth } from './concurrency-util.mjs';

export const title = 'Concurrency: charges and edits';

export default async function run({ port, projectRoot }) {
  const { srv, a, b } = await boot({ port, projectRoot });
  const T = reporter(title);
  const db = async () => (await a.get('/api/db')).body;
  const inv = async label => { const v = invariants(await db()); T.check(`${label}: invariants hold`, v.length === 0, v.join('; ')); };
  const pick = i => (i % 2 ? a : b);
  try {
    // 1. post-month x30 in parallel on the first posting
    await a.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', tenantName: 'Tenant', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1 });
    const month = lastMonth();
    let rs = await Promise.all(Array.from({ length: 30 }, (_, i) => pick(i).post('/api/charges/post-month', { monthString: month })));
    let d = await db();
    const std = d.charges.filter(c => c.periodMonth === month && c.kind === undefined && c.status === 'open');
    T.check('post-month x30: all replies 200', rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.status)));
    T.check('post-month x30: one Rent + one Maintenance charge per unit-month', std.filter(c => c.unitId === 'unit-1').length === 2, String(std.filter(c => c.unitId === 'unit-1').length));
    T.check('post-month x30: exactly one reply created charges', rs.filter(r => r.body?.created > 0).length === 1);
    T.check('independent rent balance is one month, 50000', balance(d, 'unit-1', 'Rent') === 5000000, String(balance(d, 'unit-1', 'Rent')));
    T.check('audit: one "Posted recurring charges" entry that created charges', d.auditLogs.filter(x => /Posted recurring charges/.test(x.action) && /charge\(s\) created: [^n]/.test(x.newValue) && !/^0 charge/.test(x.newValue)).length === 1);
    await inv('post-month');

    // 2. post-month racing a void of the posted rent charge
    const rentChg = std.find(c => c.unitId === 'unit-1' && c.category === 'Rent');
    rs = await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? a.post('/api/charges/post-month', { monthString: month })
      : b.post(`/api/charges/${rentChg.id}/void`, { reason: 'race void test' })));
    d = await db();
    const live = d.charges.filter(c => c.periodMonth === month && c.category === 'Rent' && c.kind === undefined && c.status === 'open').length;
    T.check('void vs post-month: at most one live monthly rent charge', live <= 1, String(live));
    T.check('void: exactly one void succeeded', rs.filter((r, i) => i % 2 === 0 && r.status === 200).length === 1);
    await inv('void vs post-month');
    await a.post('/api/charges/post-month', { monthString: month });

    // 3. parallel one-off charges (distinct) and identical one-offs
    const before = (await db()).charges.length;
    rs = await Promise.all(Array.from({ length: 30 }, (_, i) => pick(i).post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 100 + i })));
    d = await db();
    T.check('30 distinct one-offs all stored', rs.every(r => r.status === 200) && d.charges.length === before + 30, `${rs.filter(r => r.status !== 200).length} refused; ${JSON.stringify(rs.find(r => r.status !== 200)?.body)}`);
    const before2 = d.charges.length;
    rs = await Promise.all(Array.from({ length: 10 }, (_, i) => pick(i).post('/api/charges', { unitId: 'unit-1', category: 'Rent', oneOffType: 'Late fee', amount: 77 })));
    d = await db();
    T.check('10 identical one-offs without a key: duplicate guard (EXPECTED 1)', d.charges.length - before2 === 1, `${d.charges.length - before2} stored`);
    await inv('one-offs');

    // 4. one-off void x N
    const oo = d.charges.find(c => c.kind === 'one-off' && c.status === 'open');
    rs = await Promise.all(Array.from({ length: 15 }, (_, i) => pick(i).post(`/api/charges/${oo.id}/void`, { reason: 'void race one-off' })));
    d = await db();
    T.check('void same charge x15: one success, one audit', rs.filter(r => r.status === 200).length === 1 && auditFor(d, oo.id, /Voided/).length === 1);

    // 5. lost updates: parallel edits of same unit with different fields
    const u0 = (await db()).units.find(u => u.id === 'unit-1');
    const full = f => ({ number: u0.number, ownerName: u0.ownerName, tenantName: u0.tenantName, status: 'long-term', monthlyRent: u0.monthlyRent, monthlyMaintenance: u0.monthlyMaintenance, currency: 'JMD', maintCurrency: 'JMD', rentDueDay: 1, maintDueDay: 1, ...f });
    rs = await Promise.all([
      a.put('/api/units/unit-1', full({ monthlyRent: 50001 })),
      b.put('/api/units/unit-1', full({ monthlyRent: 50002 })),
      a.put('/api/units/unit-1', full({ monthlyRent: 50003 }))
    ]);
    d = await db();
    const u1 = d.units.find(u => u.id === 'unit-1');
    T.check('3 parallel unit edits: all accepted, final value is one of them (last-writer-wins, no corruption)', rs.every(r => r.status === 200) && [50001, 50002, 50003].includes(u1.monthlyRent), `${rs.map(r => r.status + ' ' + String(r.body?.error).slice(0, 150))} ${u1.monthlyRent}`);
    T.check('each accepted unit edit has an audit entry', auditFor(d, 'unit-1').filter(x => /5000[123]/.test(x.newValue)).length >= 3, String(auditFor(d, 'unit-1').length));

    // 6. lost update on a payment: parallel PUT of different fields (PUT replaces fields from body, merges rest)
    const p = (await a.post('/api/payments', rent({ amount: 222, confirmAlreadySettled: true, confirmNoOpenCharge: true }))).body.payment;
    rs = await Promise.all([
      a.put(`/api/payments/${p.id}`, { notes: 'note-from-A' }),
      b.put(`/api/payments/${p.id}`, { reference: 'ref-from-B' })
    ]);
    d = await db();
    const pp = d.payments.find(x => x.id === p.id);
    T.check('parallel partial edits of one payment both survive (no lost update)', pp.notes === 'note-from-A' && pp.reference === 'ref-from-B', JSON.stringify({ n: pp.notes, r: pp.reference, st: rs.map(r => r.status) }));
    await inv('edits');

    // 7. unique ids under heavy burst (ids are Date.now()+random(1000))
    rs = await Promise.all(Array.from({ length: 150 }, (_, i) => pick(i).post('/api/payments', rent({ amount: 5 + (i % 7) * 0.01 + i, confirmDuplicate: true, confirmAlreadySettled: true }))));
    d = await db();
    T.check('150-burst: all accepted', rs.filter(r => r.status === 200).length === 150, String(rs.filter(r => r.status === 200).length));
    await inv('id burst');
  } finally {
    await srv.stop();
  }
  return T.done();
}
