/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tenancy lifecycle: move-in dates, changeovers, eviction and write-off.
 *
 * A tenancy opened from the units register used to be stamped with today's date.
 * When the register is first filled in — which is the normal way this system gets
 * set up — that invented a move-in date for tenants who had already lived there
 * for years, and then refused to backdate their move-out or eviction to the day it
 * actually happened. Unknown is now left unknown; only a genuine changeover is
 * dated today.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Tenancy lifecycle & eviction';

const villa = (over = {}) => ({
  number: '1',
  ownerName: 'Owner',
  status: 'long-term',
  monthlyRent: 60000,
  monthlyMaintenance: 12000,
  currency: 'JMD',
  maintCurrency: 'JMD',
  rentDueDay: 1,
  maintDueDay: 1,
  ...over
});

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'TenTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'TenTest-1234!', 'TenNew-9876!');

    // --- first time a tenant is recorded: move-in date is not invented ---
    await c.put('/api/units/unit-1', villa({ tenantName: 'Existing Tenant' }));
    let db = (await c.get('/api/db')).body;
    let active = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    T.check('a tenancy is opened for the tenant', !!active, active?.tenantName);
    T.check('their move-in date is left unknown rather than set to today', active.startedOn === '', `startedOn="${active.startedOn}"`);

    // --- the real date can be supplied when it is known ---
    await c.put('/api/units/unit-2', { ...villa({ number: '2', tenantName: 'Known Tenant' }), tenantMovedInOn: '2024-03-15' });
    db = (await c.get('/api/db')).body;
    const known = db.tenancies.find(t => t.unitId === 'unit-2' && t.status === 'active');
    T.check('a stated move-in date is recorded as given', known.startedOn === '2024-03-15', known.startedOn);
    const future = await c.put('/api/units/unit-3', { ...villa({ number: '3', tenantName: 'Future' }), tenantMovedInOn: '2099-01-01' });
    T.check('a move-in date in the future is refused', future.status === 400, String(future.body?.error).slice(0, 46));

    // --- a genuine changeover is dated today ---
    await c.put('/api/units/unit-1', villa({ tenantName: 'Replacement Tenant' }));
    db = (await c.get('/api/db')).body;
    const closed = db.tenancies.find(t => t.unitId === 'unit-1' && t.tenantName === 'Existing Tenant');
    const opened = db.tenancies.find(t => t.unitId === 'unit-1' && t.status === 'active');
    T.check('the outgoing tenancy is closed, never deleted', closed?.status === 'ended', `ended ${closed?.endedOn}`);
    T.check('and it records why it ended', !!closed?.endReason, closed?.endReason);
    T.check('a real changeover IS dated today', !!opened.startedOn && opened.startedOn !== '', opened.startedOn);
    T.check('both tenancies are retained as history', db.tenancies.filter(t => t.unitId === 'unit-1').length === 2);

    // --- the unknown move-in date does not block backdating a move-out ---
    const backdated = await c.put(`/api/tenancies/${known.id}`, { endedOn: '2026-07-10', endReason: 'Lease ended; keys returned.' });
    T.check('a move-out can be backdated to the day it happened', backdated.status === 200, `ended ${backdated.body?.tenancy?.endedOn}`);
    db = (await c.get('/api/db')).body;
    const u2 = db.units.find(u => u.id === 'unit-2');
    T.check('the villa is released when the tenancy closes', u2.tenantName === '' && u2.status === 'vacant', `status ${u2.status}`);

    // --- eviction with write-off, backdated, on a tenancy with no move-in date ---
    await c.put('/api/units/unit-5', villa({ number: '5', tenantName: 'Arrears Tenant', monthlyRent: 45000 }));
    await c.post('/api/charges/post-month', { monthString: '2026-07' });
    db = (await c.get('/api/db')).body;
    const target = db.tenancies.find(t => t.unitId === 'unit-5' && t.status === 'active');
    const owed = db.charges
      .filter(x => x.unitId === 'unit-5' && x.category === 'Rent' && x.status === 'open')
      .reduce((a, x) => a + x.amount, 0);
    const ev = await c.post(`/api/tenancies/${target.id}/evict`, {
      reason: 'Two months in arrears; notice served and expired.',
      effectiveDate: '2026-07-20'
    });
    T.check('an eviction can be backdated when the move-in date is unknown', ev.status === 200, ev.status === 200 ? `wrote off ${ev.body.writtenOff}` : ev.body?.error);
    T.check('the write-off equals the rent that was owing', ev.body?.writtenOff === owed, `${ev.body?.writtenOff} vs ${owed}`);

    db = (await c.get('/api/db')).body;
    const evicted = db.tenancies.find(t => t.id === target.id);
    T.check('the tenancy is closed and flagged as an eviction', evicted.status === 'ended' && evicted.evicted === true);
    T.check('the write-off amount is kept on the tenancy record', evicted.writeOffAmount === owed, String(evicted.writeOffAmount));
    T.check('the effective date is the one given, not today', evicted.endedOn === '2026-07-20', evicted.endedOn);
    const voided = db.charges.filter(x => x.unitId === 'unit-5' && x.category === 'Rent' && x.status === 'void');
    T.check('the rent charge is voided with a reason, not deleted', voided.length > 0 && !!voided[0].voidReason, voided[0]?.voidReason?.slice(0, 40));
    const openRent = db.charges.filter(x => x.unitId === 'unit-5' && x.category === 'Rent' && x.status === 'open');
    T.check('the written-off rent no longer counts as collectable', openRent.length === 0);
    const maintStillOwed = db.charges.some(x => x.unitId === 'unit-5' && x.category === 'Maintenance' && x.status === 'open');
    T.check('the owner\'s maintenance liability survives the eviction', maintStillOwed);
    const u5 = db.units.find(u => u.id === 'unit-5');
    T.check('the villa is released and shows as vacant', u5.tenantName === '' && u5.status === 'vacant');
    T.check('the eviction is audited with an approver', db.auditLogs.some(a => /Evicted/.test(a.action) && !!a.approvedBy));

    // --- an eviction cannot predate a KNOWN move-in date ---
    await c.put('/api/units/unit-6', { ...villa({ number: '6', tenantName: 'Dated Tenant' }), tenantMovedInOn: '2026-07-01' });
    db = (await c.get('/api/db')).body;
    const dated = db.tenancies.find(t => t.unitId === 'unit-6' && t.status === 'active');
    const tooEarly = await c.post(`/api/tenancies/${dated.id}/evict`, { reason: 'Testing the date guard.', effectiveDate: '2026-06-01' });
    T.check('an eviction before a known move-in date is still refused', tooEarly.status === 400, String(tooEarly.body?.error).slice(0, 48));
  } finally {
    await srv.stop();
  }
  return T.done();
}
