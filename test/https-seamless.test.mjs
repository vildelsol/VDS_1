/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HTTPS with nothing for anybody to do, and the sign-in limits Ro set (2026-11-21).
 *
 *   - One port serves both: a TLS handshake gets HTTPS; plain HTTP is redirected to HTTPS once a certificate is held,
 *     and served exactly as before when none is.
 *   - The certificate comes from Tailscale (`tailscale cert`) for the machine's Tailscale name, or from
 *     <records>/tls/cert.pem + key.pem. Anything missing leaves plain HTTP running.
 *   - Session and device cookies are Secure over HTTPS.
 *   - 10 failed sign-ins a minute per address; successful sign-ins are never refused by that limit.
 *
 * The certificate here is a self-signed test certificate for localhost, used only by this file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { startServer, makeClient, reporter, activateAdmin } from './harness.mjs';

export const title = 'HTTPS on the same port, automatically; failed sign-ins limited to 10 a minute';

const CERT = `-----BEGIN CERTIFICATE-----
MIIDBjCCAe6gAwIBAgIUUeLsywcDv4y5y2DOcWF62nmPFIQwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMTIwNTY0OFoYDzIxMjYx
MDI4MjA1NjQ4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC4mCQHFrey9LH0/u/1/a28jlVA5XYwIHB2pukdCgRc
BlTxtK/GiJmqVQv3qdt6+5aReEcH1bggsDwTI6NfyEG4rosw+IdSS+zleFSeL1sI
85BkmzrKMayBEPJg8F1+021vh/XmDYZOKp+0WbiXeIK6sid0FrRUS1uzdlaxJs4X
4JzdggDCzGk287tXAIP8sMtMu+JwntZuJpHB+h7xAOjDDE/mvawYQjsWMf3dkqQW
lTCZpSZhkZesPym0KEHQ2unVJVfZRMIx5YNCt8F6RXKusfAxAxlyrJANs/78TZz0
IySPdxLjn0dXtkcjmtQyJMsThG4lJItFJaBHqqRTVi69AgMBAAGjTjBMMB0GA1Ud
DgQWBBQjvxgvCQSco8sm0WUFOKTl8OKJpzAPBgNVHRMBAf8EBTADAQH/MBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAZMl8A5Tv
wcT9JuuA4JLDRf2fCnDY1pJUPNRexJDXMruqdHG/NOrks37aCF/umT6nExh+oC36
HL4AB9g48B9Mx4ETcZnVvrnQ1g4H/+oPenV6RHY4KJUPwHZfAEH9ZlKV0ynTqrau
eQV6nKDoXv+XcKQcfJkP6PvbS4pZKQn74izU/1cIUB3hKXRPKGfbXuHa7+6SdaxT
zveuU5csSBNqr2SW5tfpF4BC2ClznVeX/iH24y4DJ25PyJ+dPwNa+mSNdONajHqt
1q8fnGhoyVapdiwwUyHjQCXMCzatuxURrYm53BGaglL75cNI1jZBywPvve/LA99q
nPLPsQ73+9B8vA==
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC4mCQHFrey9LH0
/u/1/a28jlVA5XYwIHB2pukdCgRcBlTxtK/GiJmqVQv3qdt6+5aReEcH1bggsDwT
I6NfyEG4rosw+IdSS+zleFSeL1sI85BkmzrKMayBEPJg8F1+021vh/XmDYZOKp+0
WbiXeIK6sid0FrRUS1uzdlaxJs4X4JzdggDCzGk287tXAIP8sMtMu+JwntZuJpHB
+h7xAOjDDE/mvawYQjsWMf3dkqQWlTCZpSZhkZesPym0KEHQ2unVJVfZRMIx5YNC
t8F6RXKusfAxAxlyrJANs/78TZz0IySPdxLjn0dXtkcjmtQyJMsThG4lJItFJaBH
qqRTVi69AgMBAAECggEAH8LbthWIU4QLR5SC3MBCf7Y8wH8KzCKUvzGeXAcAc4YK
YRE+CkqwJ/Dcr4ccEsfNoyd/Dz/MX+F64K8p2d3mwvxTSkCE5hnWv6/p3VLYFszz
q//SiH4uCIIONjQ9XghKZN2Pp37tvC7Uzk7+th8/3RgwtiZ+7h8OPu1uYqpC3TQX
S2hsJba/5UbqWa4WX18iZovMlazE5BdSlVDze/fx8q/7zb83y2N04Mi+r3npFu81
z1uKvo+c8xrAJ89KljS/WWvpThivYnGHN+0avP0FwuOTayHqe5bvjaDmbsmxZrnl
SlATZ5KrXjp+RODYtS0sxH0J2OruJ1gq83pyGUVa6QKBgQDnyUtjsY0fdENtldW8
9Os7/DVKRJwvjAzwgV9qkFa7GUBrMITVITRtJcgdtZEyiu1RUtYqIUUozGq3pYI6
f50mHFpRb/XLCKLSNkEnZJIz8N5f9IiPJMOQX6P3uLjLim89Orvms5yGMHbGwK3d
SyB53EYk0FxWnSa3WKPUhp7DVQKBgQDL4MgIn5m1xHa6InAPEn+fv0OxT1g1888X
5gmJlznxwm4pCpWXFU+OciUKxQmHo399dgK0iAfWRiPjJ4mXHCHg+0zPgUblJ7UW
E4LC1XOdjKxgoT9y0A33dz+PfgPRaLhEkNVmh6Ez7bSxOnBKkQt7Lvj9lE8V9jdD
KWuExLWNyQKBgEYAnF06lWWHhonFM+1Chvzx2eJZQFZ31LyaRgf4GcmeAb+dwrBf
u+au/3ZBjN2X6b6i5v2IWMvOmPhn6yHhwsNs0rY/uxsbu5kDO8A69pDrUS3nu4qH
zux+hhXd2ynV4Gy8nV06p647WtQCA0CPXPqQ1TpvF0QtaDD9e1VHZxGVAoGACdu/
sHMPOrPaTdvWcVQiqbXU7yD4EfvNGsm70lRmr+MH8qIZY6nbI/cvBVtLv6xPQODQ
9qvRPTI9EAHcbFsm5DsilrIYnIIUBpJA82zg31BrEW0apVGcK0gv4Z9lTd3zcxVR
zFhomhs3bo512ZUz6ev2jER8ooI6X9wD3/KnGMkCgYEAmg72Du3O4pd4AuEAHh/O
1hv1sRHW5+PJFyly/5RrbCcutlPSIDy2JussuMLBWWpHpsecOuFe4JBaF1wLUgup
3Ur45X8n9U19z3FY7WiGJS1VG8NO0OXUi00+nVNu7CldfIJGNJhZDyOF384vBxiU
15JNyCLsGlyn5SEdJmuFscA=
-----END PRIVATE KEY-----`;

function get(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : require_http();
    const req = lib.request(u, { method, headers, rejectUnauthorized: false }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
let httpMod;
function require_http() {
  return httpMod;
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

export default async function run({ port, projectRoot }) {
  httpMod = (await import('node:http')).default;
  const T = reporter(title);
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-tls-'));
  fs.writeFileSync(path.join(tlsDir, 'cert.pem'), CERT);
  fs.writeFileSync(path.join(tlsDir, 'key.pem'), KEY);
  const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // The harness polls /api/health with fetch; once HTTPS is on that is redirected to the self-signed test certificate.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let srv;
  try {
    /* ---------------- a certificate on file: HTTPS on the same port ---------------- */
    srv = await startServer({ port, adminPassword: 'Https-Test-48213!', projectRoot, env: { VDS_HTTPS: 'on', VDS_TLS_DIR: tlsDir, VDS_TAILSCALE_BIN: path.join(tlsDir, 'no-such-tailscale') } });
    const httpsUp = await waitFor(async () => (await get(`https://127.0.0.1:${port}/api/health`).catch(() => ({ status: 0 }))).status === 200);
    T.check('the same port answers HTTPS once the certificate is loaded', httpsUp);
    const plain = await get(`http://localhost:${port}/api/health?x=1`);
    T.check('a plain-HTTP request on that port is redirected to HTTPS, path kept', plain.status === 308 && plain.headers.location === `https://localhost:${port}/api/health?x=1`, `${plain.status} ${plain.headers.location}`);
    const evil = await get(`http://localhost:${port}/`, { headers: { Host: 'evil.example"><x' } });
    T.check('a junk Host header is never echoed into a redirect', evil.status !== 308 || !/evil/.test(evil.headers.location || ''), `${evil.status} ${evil.headers.location}`);

    const admin = makeClient(`https://127.0.0.1:${port}`);
    await activateAdmin(admin, 'Https-Test-48213!', 'HttpsNew-58213!');
    const login = await get(`https://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `https://127.0.0.1:${port}` }, body: JSON.stringify({ username: 'admin', password: 'HttpsNew-58213!' }) });
    const cookies = [].concat(login.headers['set-cookie'] || []);
    T.check('signing in over HTTPS works', login.status === 200, `${login.status} ${login.body.slice(0, 160)}`);
    T.check('and the session cookie is Secure over HTTPS', cookies.some(c => /^vds_session=/.test(c) && /;\s*Secure/i.test(c)), cookies.join(' | '));
    const db = await admin.get('/api/db');
    T.check('the application works over HTTPS (records load)', db.status === 200 && Array.isArray(db.body?.units), String(db.status));
    await srv.stop();
    srv = null;

    /* ---------------- control: no certificate, plain HTTP exactly as before ---------------- */
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-tls-none-'));
    srv = await startServer({ port: port + 1, adminPassword: 'Https-Test-48213!', projectRoot, env: { VDS_HTTPS: 'on', VDS_TLS_DIR: empty, VDS_TAILSCALE_BIN: path.join(empty, 'no-such-tailscale') } });
    await new Promise(r => setTimeout(r, 1500));
    const noCert = await get(`http://127.0.0.1:${port + 1}/api/health`);
    T.check('control: with no certificate and no Tailscale, plain HTTP is served as before (no redirect)', noCert.status === 200, String(noCert.status));
    await srv.stop();
    srv = null;
    fs.rmSync(empty, { recursive: true, force: true });

    /* ---------------- Tailscale issues the certificate (a stand-in command) ---------------- */
    if (process.platform !== 'win32') {
      const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-ts-'));
      const fake = path.join(tsDir, 'tailscale');
      const src = (domains) => `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
if (a[0] === 'version') { console.log('1.0.0'); process.exit(0); }
if (a[0] === 'status') { console.log(JSON.stringify({ CertDomains: ${JSON.stringify(domains)} })); process.exit(0); }
if (a[0] === 'cert') { fs.writeFileSync(a[a.indexOf('--cert-file') + 1], ${JSON.stringify(CERT)}); fs.writeFileSync(a[a.indexOf('--key-file') + 1], ${JSON.stringify(KEY)}); fs.writeFileSync(${JSON.stringify(path.join(tsDir, 'asked'))}, a[a.length - 1]); process.exit(0); }
process.exit(1);
`;
      fs.writeFileSync(fake, src(['vds-hp.example-tailnet.ts.net']), { mode: 0o755 });
      const noManual = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-tls-ts-'));
      srv = await startServer({ port: port + 2, adminPassword: 'Https-Test-48213!', projectRoot, env: { VDS_HTTPS: 'on', VDS_TLS_DIR: noManual, VDS_TAILSCALE_BIN: fake } });
      const tsUp = await waitFor(async () => (await get(`http://127.0.0.1:${port + 2}/api/health`)).status === 308);
      const r = await get(`http://127.0.0.1:${port + 2}/`);
      T.check('with Tailscale HTTPS switched on, the app asks Tailscale for its own name\'s certificate', tsUp && fs.readFileSync(path.join(tsDir, 'asked'), 'utf8') === 'vds-hp.example-tailnet.ts.net');
      T.check('and redirects every address (IP, localhost) to that Tailscale name, which browsers trust', r.headers.location === `https://vds-hp.example-tailnet.ts.net:${port + 2}/`, String(r.headers.location));
      await srv.stop();
      srv = null;

      fs.writeFileSync(fake, src([]), { mode: 0o755 });
      srv = await startServer({ port: port + 3, adminPassword: 'Https-Test-48213!', projectRoot, env: { VDS_HTTPS: 'on', VDS_TLS_DIR: noManual, VDS_TAILSCALE_BIN: fake } });
      await new Promise(r => setTimeout(r, 1500));
      const off = await get(`http://127.0.0.1:${port + 3}/api/health`);
      T.check('control: Tailscale running but HTTPS certificates not switched on for the tailnet: plain HTTP as before', off.status === 200, String(off.status));
      await srv.stop();
      srv = null;
      fs.rmSync(tsDir, { recursive: true, force: true });
      fs.rmSync(noManual, { recursive: true, force: true });
    }

    /* ---------------- failed sign-ins: 10 a minute per address ---------------- */
    srv = await startServer({ port: port + 4, adminPassword: 'Https-Test-48213!', projectRoot, env: { VDS_RATE_FAILED_LOGINS_PER_ADDRESS_MIN: '', VDS_RATE_LOGINS_PER_ADDRESS_MIN: '', VDS_LOGIN_IP_CAP: '100000', VDS_LOGIN_GLOBAL_CAP: '100000' } });
    const a = makeClient(srv.baseUrl);
    await activateAdmin(a, 'Https-Test-48213!', 'HttpsNew-58213!');
    let good = 0;
    for (let i = 0; i < 15; i++) if ((await makeClient(srv.baseUrl).post('/api/auth/login', { username: 'admin', password: 'HttpsNew-58213!' })).status === 200) good++;
    T.check('control: 15 successful sign-ins in a minute are never refused by the failed-sign-in limit', good === 15, String(good));
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await makeClient(srv.baseUrl).post('/api/auth/login', { username: `guess${i}`, password: 'Wrong-Guess-9999!' })).status);
    T.check('10 failed sign-ins a minute from one address are answered', codes.slice(0, 10).every(c => c === 401), codes.join(','));
    T.check('the 11th is refused for the rest of the minute (429)', codes[10] === 429, codes.join(','));
    await srv.stop();
    srv = null;
  } finally {
    if (srv) await srv.stop();
    if (prevReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject;
    fs.rmSync(tlsDir, { recursive: true, force: true });
  }
  return T.done();
}
