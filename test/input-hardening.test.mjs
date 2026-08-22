/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the server does with a figure it cannot read, a key it has seen before,
 * and a rate that cannot be true. All three came out of an adversarial pass over
 * a running server rather than from reading the code.
 *
 * The theme is the same in each: the old behaviour never said no. It produced
 * *a* number, *a* response, *a* rate — plausible, wrong, and silent. In a ledger
 * a refusal is cheap and a quiet wrong figure is not, because it is receipted,
 * reported to an owner, and reconciled against a bank statement before anybody
 * notices it was never what was typed.
 */

import { startServer, makeClient, reporter, activateAdmin, makeLongTermUnit } from './harness.mjs';

export const title = 'Unreadable figures, replayed keys & impossible rates';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'Hardening-1234!', projectRoot });
  const T = reporter(title);
  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'Hardening-1234!', 'HardAdmin-9876!');
    await makeLongTermUnit(admin);

    /* ---------------------------------------------------------------- *
     * Figures that are read, and figures that are refused
     * ---------------------------------------------------------------- */

    const expense = (amount) =>
      admin.post('/api/expenses', { category: 'Maintenance', description: 'probe', amount, currency: 'JMD', date: '2026-07-05', vendor: 'V' });

    // The forgiving cases exist because people paste from invoices and receipts.
    for (const [typed, expected] of [
      [50000, 50000],
      ['50000', 50000],
      ['50,000', 50000],
      ['$50,000', 50000],
      ['12 000', 12000],
      ['  50000  ', 50000],
      ['50000.50', 50000.5],
      ['1,234.56', 1234.56]
    ]) {
      const r = await expense(typed);
      T.check(`${JSON.stringify(typed)} is read as ${expected}`, r.status === 200 && r.body?.expense?.amount === expected, `got ${r.status} ${r.body?.expense?.amount ?? r.body?.error}`);
    }

    // The refusals. Each of these used to produce a number nobody typed.
    for (const [typed, wasSilently] of [
      ['1.500.000', 1.5],
      ['1e999', 1999],
      ['50000abc', 50000],
      ['5-0-0', 5],
      ['1,2,3', 123],
      ['abc', 0],
      ['', 0],
      ['--5', 0],
      ['1.2.3.4', 1.2]
    ]) {
      const r = await expense(typed);
      T.check(
        `${JSON.stringify(typed)} is refused rather than becoming ${wasSilently}`,
        r.status === 400,
        `got ${r.status} ${JSON.stringify(r.body?.expense?.amount ?? r.body?.error)}`
      );
    }
    T.check(
      'and the refusal says how to write it instead',
      /not a figure I can read/.test((await expense('1.500.000')).body?.error || '')
    );

    // The same grammar has to hold where a figure is optional, or the guard is
    // just moved somewhere quieter.
    const unreadableRent = await admin.put('/api/units/unit-1', { number: '1', ownerName: 'O', ownerChangeIntent: 'correction', status: 'long-term', currency: 'JMD', maintCurrency: 'JMD', monthlyRent: '1.500.000' });
    T.check('an unreadable rent is refused rather than stored as 1.5', unreadableRent.status === 400, `got ${unreadableRent.status}`);
    T.check(
      'and the rent that was already there is untouched',
      (await admin.get('/api/db')).body.units.find(u => u.id === 'unit-1')?.monthlyRent === 50000
    );

    const omittedRent = await admin.put('/api/units/unit-1', { number: '1', ownerName: 'O', ownerChangeIntent: 'correction', status: 'long-term', currency: 'JMD', maintCurrency: 'JMD' });
    T.check('omitting the rent still means "leave it as it was"', omittedRent.status === 200);
    T.check(
      'and it really was left alone',
      (await admin.get('/api/db')).body.units.find(u => u.id === 'unit-1')?.monthlyRent === 50000
    );

    /* ---------------------------------------------------------------- *
     * An idempotency key belongs to the account that sent it
     * ---------------------------------------------------------------- */

    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    await admin.post('/api/charges/post-month', { monthString: '2026-07' });

    const KEY = 'a-key-both-of-them-used';
    const mine = await admin.post(
      '/api/payments',
      { unitId: 'unit-1', category: 'Rent', amount: 12345, currency: 'JMD', payerName: 'AdminPayer', method: 'Cash', confirmNoOpenCharge: true },
      { headers: { 'Idempotency-Key': KEY } }
    );
    const theirs = await jr.post(
      '/api/payments',
      { unitId: 'unit-1', category: 'Rent', amount: 999, currency: 'JMD', payerName: 'JuniorPayer', method: 'Cash', confirmNoOpenCharge: true },
      { headers: { 'Idempotency-Key': KEY } }
    );
    T.check('the same key from another account does its own work', theirs.status === 200 && theirs.body?.payment?.id !== mine.body?.payment?.id);
    T.check('and records the amount that was actually sent', theirs.body?.payment?.amount === 999, `stored ${theirs.body?.payment?.amount}`);
    T.check('and names the person who sent it', theirs.body?.payment?.payerName === 'JuniorPayer');

    // Replay by the *same* account is still exactly one action — that is the
    // whole point of the key, and the offline queue depends on it.
    const replay = await admin.post(
      '/api/payments',
      { unitId: 'unit-1', category: 'Rent', amount: 12345, currency: 'JMD', payerName: 'AdminPayer', method: 'Cash', confirmNoOpenCharge: true },
      { headers: { 'Idempotency-Key': KEY } }
    );
    T.check('a replay by the same account returns the first result', replay.body?.payment?.id === mine.body?.payment?.id);
    const all = (await admin.get('/api/db')).body.payments;
    T.check('and did not record a second payment', all.filter(p => p.id === mine.body?.payment?.id).length === 1);
    T.check('so the till holds two payments, not one and not three', all.filter(p => ['AdminPayer', 'JuniorPayer'].includes(p.payerName)).length === 2);

    /* ---------------------------------------------------------------- *
     * An exchange rate that cannot be true
     * ---------------------------------------------------------------- */

    const rateBefore = (await admin.get('/api/db')).body.settings.fxRateJmdPerUsd;
    for (const rate of [0.0001, 0, -160, 99999, 1e9, 'abc']) {
      T.check(`an impossible rate is refused: ${rate}`, (await admin.post('/api/settings', { fxRateJmdPerUsd: rate })).status === 400);
    }
    T.check('the rate that was in force is unchanged', (await admin.get('/api/db')).body.settings.fxRateJmdPerUsd === rateBefore);
    const sane = await admin.post('/api/settings', { fxRateJmdPerUsd: 158.5 });
    T.check('a real rate is still accepted', sane.status === 200 && sane.body?.settings?.fxRateJmdPerUsd === 158.5);

    return T.done();
  } finally {
    await srv.stop();
  }
}
