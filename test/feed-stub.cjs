/**
 * Test-only preload (`--require`): serves calendar feeds from files for hosts
 * ending in `.feed-stub.test`, so a sync can be driven end to end without the
 * internet. The hostname resolves to a public-looking address so the SSRF guard
 * runs exactly as in production. Never loaded outside the test suite.
 */
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');

const STUB = '.feed-stub.test';
const lookup = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async (host, opts) => (String(host).endsWith(STUB) ? [{ address: '93.184.216.34', family: 4 }] : lookup(host, opts));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname.endsWith(STUB)) {
    const file = path.join(process.env.VDS_TEST_FEED_DIR, path.basename(u.pathname));
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'Content-Type': 'text/calendar' } });
  }
  return realFetch(url, init);
};
