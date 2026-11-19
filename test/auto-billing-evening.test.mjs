/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automatic billing in the evening.
 *
 * Records are stamped in UTC. The machine's day is local. In Jamaica (UTC-5, no
 * daylight saving) every record written after 19:00 carries tomorrow's UTC date.
 * The "clock behind the records" guard compared the local day with the first ten
 * characters of the newest stamp, so from 19:00 to midnight every run decided the
 * clock was wrong and billed nothing, writing a false hold to the Compliance Log.
 * Found 2026-11-18 at 19:49 local, when the full suite ran after 00:00 UTC.
 *
 * This test does not depend on the time it is run: the server runs in
 * America/Jamaica and the newest record is stamped 23:59 Jamaica time today,
 * which is always the next UTC day.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Automatic billing runs in the evening, not only before 19:00';

const PASS = 'Str0ng-Pass!2026';
const TZ = 'America/Jamaica';

/** Today in Jamaica, YYYY-MM-DD. */
const jamaicaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-evening-'));
  const env = { TZ };
  try {
    const day = jamaicaToday();
    const month = day.slice(0, 7);

    const first = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir, env });
    let c = makeClient(first.baseUrl);
    await activateAdmin(c, 'admin123', PASS);
    const put = await c.put('/api/units/unit-3', {
      number: '3', ownerName: 'Owner Three', status: 'owner-occupied',
      monthlyMaintenance: 15000, currency: 'JMD', maintCurrency: 'JMD', maintDueDay: 1
    });
    T.check('setup: the villa is on the register', put.status === 200, JSON.stringify(put.body).slice(0, 200));
    const pay = await c.post('/api/payments', { unitId: 'unit-3', category: 'Other', amount: 100, currency: 'JMD', method: 'Cash', payerName: 'Evening', receivedNow: true });
    T.check('setup: a receipt was recorded', pay.status === 200, JSON.stringify(pay.body).slice(0, 200));
    await first.stop();

    // 23:59 in Jamaica today is 04:59 UTC tomorrow: the newest record carries tomorrow's UTC date.
    const lateStamp = new Date(`${day}T23:59:00-05:00`).toISOString();
    T.check('setup: the late stamp falls on the next UTC day', lateStamp.slice(0, 10) > day, lateStamp);
    const file = path.join(dataDir, 'db.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = raw.payments.find(x => x.id === pay.body.payment?.id);
    T.check('setup: the receipt is on disk', !!p);
    if (p) p.createdAt = lateStamp;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    const live = await startServer({ port, adminPassword: 'admin123', projectRoot, dataDir, env: { ...env, VDS_AUTO_POST: 'on' } });
    try {
      c = makeClient(live.baseUrl);
      await c.post('/api/auth/login', { username: 'admin', password: PASS }, { captureCookie: true });
      const db = (await c.get('/api/db')).body;
      const levy = db.charges.filter(x => x.unitId === 'unit-3' && x.category === 'Maintenance' && x.periodMonth === month && x.status === 'open' && !x.kind);
      T.check('this month\'s levy was billed automatically although the newest record is stamped with tomorrow\'s UTC date', levy.length === 1 && levy[0].createdBy === 'System', `${levy.length} levy charge(s) for ${month}`);
      const falseHold = (db.auditLogs || []).filter(a => a.action === 'Automatic billing held back' && /before the newest record/.test(a.details || a.notes || JSON.stringify(a)));
      T.check('no false "clock behind the records" hold was written to the Compliance Log', falseHold.length === 0, falseHold.map(a => JSON.stringify(a).slice(0, 200)).join(' | '));
    } finally {
      await live.stop();
    }
    return T.done();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
