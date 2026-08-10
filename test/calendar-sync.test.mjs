/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Synchronising a calendar feed.
 *
 * The existing SSRF suite proves a feed pointing at the internal network is
 * refused *when it is added*. That is the easy half. The half that actually
 * matters is what happens later, at sync time, because between those two moments
 * the URL is no longer under the app's control:
 *
 *  - a feed can be written straight into db.json by anyone with file access;
 *  - a hostname that resolved publicly on Monday can resolve to 127.0.0.1 today.
 *
 * So the guard has to run against the address actually being dialled, every
 * time — not once at the point of entry. These tests hold it there, using a
 * local server as the thing that must never be reached.
 *
 * Not covered here: the *redirect* hop. `fetchICal` re-checks each hop before
 * dialling it, but proving that from the outside needs a genuinely public host
 * that answers a redirect pointing inward, and a test suite should not depend on
 * reaching the internet. It is verified by reading `server/ical.ts` instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Calendar sync';

/** A local target that records whether anything ever reached it. */
function startCanary() {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        hits: () => hits,
        close: () => new Promise(r => server.close(r))
      })
    );
  });
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ical-'));
  const canary = await startCanary();
  let srv = await startServer({ port, adminPassword: 'IcalTest-1234!', projectRoot, dataDir });

  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'IcalTest-1234!', 'IcalAdmin-9876!');

    T.check(
      'syncing with no feeds configured is refused with an explanation, not a crash',
      (await admin.post('/api/ical/sync', {})).status === 400
    );

    // A junior officer holds addBookings by default, and sync creates bookings —
    // so the gate that matters here is the one on adding the feed in the first place.
    await admin.post('/api/users', { name: 'Junior Jo', username: 'junior', role: 'JUNIOR_OFFICER', password: 'JuniorPass-11!' });
    const jr = makeClient(srv.baseUrl);
    await jr.post('/api/auth/login', { username: 'junior', password: 'JuniorPass-11!' }, { captureCookie: true });
    await jr.post('/api/auth/change-password', { currentPassword: 'JuniorPass-11!', newPassword: 'JuniorOwn-22!' });
    T.check(
      'a junior officer cannot link a calendar feed',
      (await jr.post('/api/ical/feeds', { unitId: 'unit-1', url: 'https://example.com/cal.ics', source: 'Airbnb' })).status === 403
    );

    // Adding the loopback canary directly is refused, as the SSRF suite covers.
    T.check(
      'the canary cannot be added as a feed in the first place',
      (await admin.post('/api/ical/feeds', { unitId: 'unit-1', url: `http://127.0.0.1:${canary.port}/internal.ics`, source: 'Other' })).status === 400
    );
    T.check('nothing reached the canary while it was being refused', canary.hits() === 0);

    /* ---------------------------------------------------------------- *
     * A feed written straight into the file is still checked at sync time
     * ---------------------------------------------------------------- */

    await srv.stop();
    const dbPath = path.join(dataDir, 'db.json');
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    onDisk.settings.icalFeeds.push({
      id: 'feed-smuggled',
      unitId: onDisk.units[0].id,
      unitNumber: onDisk.units[0].number,
      url: `http://127.0.0.1:${canary.port}/internal.ics`,
      source: 'Other',
      active: true
    });
    fs.writeFileSync(dbPath, JSON.stringify(onDisk, null, 2));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });

    const admin2 = makeClient(srv.baseUrl);
    await admin2.post('/api/auth/login', { username: 'admin', password: 'IcalAdmin-9876!' }, { captureCookie: true });

    const smuggled = await admin2.post('/api/ical/sync', { feedId: 'feed-smuggled' });
    T.check('syncing a smuggled internal feed reports a failure rather than fetching it', smuggled.status === 200 && smuggled.body?.results?.[0]?.ok === false);
    T.check('the internal address was never dialled', canary.hits() === 0);
    T.check(
      'and the failure is recorded against the feed for someone to see',
      (await admin2.get('/api/db')).body.settings.icalFeeds.find(f => f.id === 'feed-smuggled')?.lastStatus === 'error'
    );
    T.check(
      'the failed sync is on the audit trail',
      (await admin2.get('/api/db')).body.auditLogs.some(a => /Calendar sync failed/.test(a.action))
    );
    T.check(
      'a refused sync imported no bookings',
      (await admin2.get('/api/db')).body.bookings.length === 0
    );

    T.check(
      'syncing a feed id that does not exist is refused rather than syncing everything',
      (await admin2.post('/api/ical/sync', { feedId: 'feed-nope' })).status === 400
    );

    /* ---------------------------------------------------------------- *
     * A feed switched off is left alone
     * ---------------------------------------------------------------- */

    await srv.stop();
    const disk2 = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    for (const f of disk2.settings.icalFeeds) f.active = false;
    fs.writeFileSync(dbPath, JSON.stringify(disk2, null, 2));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });

    const admin3 = makeClient(srv.baseUrl);
    await admin3.post('/api/auth/login', { username: 'admin', password: 'IcalAdmin-9876!' }, { captureCookie: true });
    T.check(
      'a deactivated feed is not synchronised',
      (await admin3.post('/api/ical/sync', {})).status === 400
    );
    T.check('and it was not fetched behind the scenes either', canary.hits() === 0);

    return T.done();
  } finally {
    await srv.stop();
    await canary.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
