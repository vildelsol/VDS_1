/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Calendar-feed URLs must not be usable to reach the internal network.
 */

import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'Calendar feed SSRF guard';

export default async function run({ port, projectRoot }) {
  const srv = await startServer({ port, adminPassword: 'SsrfTest-1234!', projectRoot });
  const T = reporter(title);
  try {
    const c = makeClient(srv.baseUrl);
    await activateAdmin(c, 'SsrfTest-1234!', 'SsrfNew-9876!');
    await c.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'short-term', monthlyMaintenance: 5000, currency: 'USD', maintCurrency: 'USD' });

    const add = url => c.post('/api/ical/feeds', { unitId: 'unit-2', url, source: 'Other' });

    const internal = [
      ['loopback by IP', 'http://127.0.0.1:9/cal.ics'],
      ['loopback by name', 'http://localhost:9/cal.ics'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['private 10.x', 'http://10.0.0.1/cal.ics'],
      ['private 192.168.x', 'http://192.168.1.1/cal.ics'],
      ['private 172.16.x', 'http://172.16.0.1/cal.ics'],
      ['CGNAT / Tailscale range', 'http://100.64.1.1/cal.ics'],
      ['IPv6 loopback', 'http://[::1]:9/cal.ics'],
      ['unspecified address', 'http://0.0.0.0/cal.ics']
    ];
    for (const [why, url] of internal) {
      T.check(`an internal feed URL is refused: ${why}`, (await add(url)).status === 400);
    }

    T.check('a non-http scheme is refused', (await add('ftp://example.com/cal.ics')).status === 400);
    T.check('no internal feed was stored', ((await c.get('/api/db')).body.settings.icalFeeds || []).length === 0);

    // Public IP literals exercise the allow-path without needing DNS in the sandbox.
    T.check('a public IPv4 feed URL is accepted', (await add('https://93.184.216.34/calendar.ics')).status === 200);
    T.check('a public IPv6 feed URL is accepted', (await add('https://[2606:2800:220:1:248:1893:25c8:1946]/calendar.ics')).status === 200);
    const feeds = (await c.get('/api/db')).body.settings.icalFeeds;
    T.check('the public feeds were stored', feeds.length === 2, `${feeds.length} stored`);
    T.check('a stored feed can still be removed', (await c.del(`/api/ical/feeds/${feeds[0].id}`)).status === 200);
  } finally {
    await srv.stop();
  }
  return T.done();
}
