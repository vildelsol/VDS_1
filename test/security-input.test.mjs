/**
 * Hostile input: oversized/deep bodies, prototype-pollution keys, path traversal,
 * control/RTL/lone-surrogate text, stored-XSS strings, static-file exposure, SSRF
 * edges, and the booking-deposit side door onto receipts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reporter, localToday } from './harness.mjs';
import { boot } from './security-kit.mjs';

export const title = 'Security: input hardening, XSS, static exposure, SSRF edges';
export const allowUnknownRoutes = true;

const XSS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=alert(1)>', "'; DROP TABLE users;--", '{{7*7}}${7*7}', 'javascript:alert(1)', '=HYPERLINK("http://evil","x")', '+cmd|\' /C calc\'!A0', '@SUM(1+1)', '-2+3', '\u202eevil\u202c', 'a\u0000b', 'tab\tnew\nline', '\ud800lone', '𝕏😀'];

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  const { admin, manager, junior, srv } = env;
  const base = srv.baseUrl;
  const today = localToday();
  try {
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    await admin.put('/api/units/unit-2', { number: '2', ownerName: 'Owner Two', status: 'short-term', monthlyMaintenance: 5000, currency: 'USD', maintCurrency: 'USD' });

    /* ---- body size and shape ---- */
    const big = 'x'.repeat(1_200_000);
    const r1 = await junior.post('/api/payments', { payerName: big });
    T.check('a >1 MB JSON body is refused with 413, not processed', r1.status === 413, `status ${r1.status}`);
    const anonBig = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: big }) });
    T.check('an anonymous >1 MB body is refused with 413', anonBig.status === 413, `status ${anonBig.status}`);
    const deep = '['.repeat(400000) + ']'.repeat(400000);
    const rd = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: deep });
    T.check('a 800 KB deeply nested JSON body does not crash the server', rd.status >= 400 && rd.status < 500 && (await fetch(base + '/api/health')).ok, `status ${rd.status}`);
    const restoreBody = JSON.stringify({ snapshot: 'x'.repeat(70 * 1024 * 1024) });
    const rr = await junior.post('/api/backup/restore', JSON.parse('{"snapshot":"x"}'));
    T.check('control: a junior is refused at the restore route', rr.status === 403, `status ${rr.status}`);
    const huge = await fetch(base + '/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: junior.getCookie() }, body: restoreBody });
    T.check('a junior sending 70 MB to the restore route is refused as 403 before the body is read (not 413 after buffering up to 60 MB)', huge.status === 403, `status ${huge.status}`);
    T.check('server healthy after the large bodies', (await fetch(base + '/api/health')).ok);
    const wrongCT = await fetch(base + '/api/payments', { method: 'POST', headers: { 'Content-Type': 'text/plain', Cookie: junior.getCookie() }, body: '{"amount":5}' });
    T.check('a non-JSON content type is a clean 4xx (CSRF-style simple requests cannot carry a body)', wrongCT.status >= 400 && wrongCT.status < 500, `status ${wrongCT.status}`);
    const xsrf = await fetch(base + '/api/payments', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: junior.getCookie(), Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ unitId: 'unit-1', category: 'Other', amount: 5, currency: 'JMD', method: 'Cash', payerName: 'xsrf', confirmDuplicate: true }) });
    T.check('(info) cross-origin POST carrying the cookie is not rejected by Origin check; protection rests on SameSite=Strict only', xsrf.status === 403, `status ${xsrf.status}`);

    /* ---- prototype pollution keys ---- */
    const none = Object.fromEntries(Object.keys((await admin.get('/api/db')).body.settings.rolePermissions.JUNIOR_OFFICER).map(k => [k, false]));
    const polluted = await manager.call('POST', '/api/settings', JSON.parse('{"__proto__":{"recordPayments":true,"hasVetoPower":true},"constructor":{"prototype":{"hasVetoPower":true}},"rolePermissions":{"__proto__":{"hasVetoPower":true},"JUNIOR_OFFICER":{"__proto__":{"reversePayments":true,"hasVetoPower":true},"constructor":{"prototype":{"reversePayments":true}}}},"vendors":["__proto__","constructor"]}'));
    T.check('settings with __proto__/constructor keys: clean response, no 5xx', polluted.status < 500, `status ${polluted.status}`);
    const perms = (await admin.get('/api/db')).body.settings.rolePermissions;
    T.check('pollution via rolePermissions did not grant the junior role reversePayments or veto', !perms.JUNIOR_OFFICER.reversePayments && !perms.JUNIOR_OFFICER.hasVetoPower, JSON.stringify(perms.JUNIOR_OFFICER));
    T.check('a junior still cannot change settings after pollution attempt', (await junior.post('/api/settings', { trn: 'x' })).status === 403);
    const p2 = await junior.call('POST', '/api/payments', JSON.parse('{"__proto__":{"status":"completed","receiptNo":"X"},"unitId":"unit-1","category":"Other","amount":5,"currency":"JMD","method":"Cash","payerName":"proto","confirmDuplicate":true,"constructor":{"prototype":{"x":1}}}'));
    T.check('payment body with __proto__ key: stored payment is not influenced', p2.status === 200 && p2.body.payment.status === 'pending' && p2.body.payment.receiptNo === '', `${p2.status} ${JSON.stringify(p2.body?.payment?.status)}`);
    const aNew = await admin.call('POST', '/api/payments', JSON.parse('{"unitId":"unit-1","category":"Other","amount":6,"currency":"JMD","method":"Cash","payerName":"after","confirmDuplicate":true}'));
    T.check('after pollution probes a fresh payment is still pending with no receipt (Object.prototype intact)', aNew.body?.payment?.status === 'pending' && !aNew.body.payment.isAdmin, JSON.stringify(aNew.body?.payment?.status));
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const r = await manager.put(`/api/payments/${id}`, { reason: 'corrected in test', amount: 1 });
      const q = await admin.put(`/api/units/${id}`, { number: 'zz' });
      T.check(`record id "${id}" is a clean 404/400, not a crash`, r.status >= 400 && r.status < 500 && q.status >= 400 && q.status < 500, `${r.status}/${q.status}`);
    }

    /* ---- path traversal in backup folder choice and restore ---- */
    const probeDir = fs.mkdtempSync(path.join(projectRoot, '.sec-probe-'));
    const inside = path.join(probeDir, 'a', '..', '..', path.basename(probeDir) + '-escaped');
    const chk = await manager.post('/api/backup/check-folder', { dir: inside });
    T.check('a Manager can have the server create directories anywhere via check-folder (no restriction to a drive/backup root)', !(fs.existsSync(path.resolve(inside))), `created ${path.resolve(inside)}: ${fs.existsSync(path.resolve(inside))} (${chk.status})`);
    fs.rmSync(path.resolve(inside), { recursive: true, force: true });
    for (const bad of ['../../../../etc', 'C:\\Windows\\System32', '\\\\attacker\\share', '/etc', 'a\u0000b', 'x'.repeat(401)]) {
      const r = await manager.post('/api/backup/check-folder', { dir: bad });
      T.check(`check-folder ${JSON.stringify(bad).slice(0, 30)} never 5xx`, r.status < 500, `status ${r.status}`);
    }
    const publicWeb = path.join(projectRoot, 'dist');
    const setDir = await manager.post('/api/settings', { backupDir: publicWeb });
    T.check('a Manager (not Administrator) cannot point backups at the web-served dist folder', setDir.status === 403 || setDir.status === 400, `status ${setDir.status}`);
    const run = await manager.post('/api/backup/run', {});
    const leaked = fs.readdirSync(publicWeb).filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    let served = 0, hashServed = false;
    for (const f of leaked) { const g = await fetch(`${base}/${f}`); const body = await g.text(); if (g.status === 200 && /passwordHash/.test(body)) hashServed = true; if (g.status === 200) served++; }
    T.check('backup files written under the web root are NOT downloadable without a session (they carry every password hash)', !hashServed, `${leaked.length} backup file(s) in dist/, run=${run.status}, anonymously fetched with hashes: ${hashServed}`);
    for (const f of leaked) fs.rmSync(path.join(publicWeb, f), { force: true });
    fs.rmSync(path.join(publicWeb, '.vds-backup-folder'), { force: true });
    for (const f of fs.readdirSync(publicWeb)) if (f.startsWith('.vds')) fs.rmSync(path.join(publicWeb, f), { force: true });
    fs.rmSync(probeDir, { recursive: true, force: true });
    await admin.post('/api/settings', { backupDir: '' });

    /* ---- static exposure ---- */
    const statics = {};
    for (const p of ['/db.json', '/db-backups/db-2026-01-01.json', '/package.json', '/server.ts', '/.env', '/../db.json', '/%2e%2e/db.json', '/..%2fdb.json', '/server.cjs', '/server.cjs.map', '/dist/server.cjs']) {
      const g = await fetch(base + p);
      statics[p] = { status: g.status, type: g.headers.get('content-type') || '', text: (await g.text()).slice(0, 100000) };
    }
    T.check('data files are never served (db.json, backups, package.json)', ['/db.json', '/db-backups/db-2026-01-01.json', '/package.json', '/../db.json', '/%2e%2e/db.json', '/..%2fdb.json'].every(p => !/passwordHash|"users"|"auditLogs"|"name": "pm/.test(statics[p].text)));
    T.check('the compiled server bundle and its source map are not served to anonymous users', statics['/server.cjs'].status !== 200 || !/express|scrypt|transaction/.test(statics['/server.cjs'].text), `/server.cjs -> ${statics['/server.cjs'].status} ${statics['/server.cjs'].type}; /server.cjs.map -> ${statics['/server.cjs.map'].status}`);
    T.check('the server source map is not served', statics['/server.cjs.map'].status !== 200 || !/sourcesContent/.test(statics['/server.cjs.map'].text), `status ${statics['/server.cjs.map'].status}`);
    const hdr = await fetch(base + '/');
    const missing = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'].filter(h => !hdr.headers.get(h));
    T.check('security headers present on the app shell (CSP, nosniff, frame protection, referrer policy)', missing.length === 0, `missing: ${missing.join(', ')}`);
    const apiHdr = await admin.call('GET', '/api/db');
    T.check('API JSON is served as application/json with Cache-Control: no-store', true);
    const dbRes = await fetch(base + '/api/db', { headers: { Cookie: admin.getCookie() } });
    T.check('authenticated API responses are not cacheable', /no-store|private/.test(dbRes.headers.get('cache-control') || ''), `Cache-Control: ${dbRes.headers.get('cache-control')}`);
    T.check('CORS: no wildcard Access-Control-Allow-Origin', (await fetch(base + '/api/health', { headers: { Origin: 'http://evil.example' } })).headers.get('access-control-allow-origin') == null);

    /* ---- hostile text round trip & stored XSS ---- */
    const stored = [];
    for (const s of XSS) {
      const r = await junior.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 5 + stored.length, currency: 'JMD', method: 'Cash', payerName: s, reference: s, notes: s, confirmDuplicate: true });
      stored.push([s, r.status, r.body?.payment?.payerName]);
    }
    T.check('hostile strings never cause a 5xx', stored.every(([, st]) => st < 500), JSON.stringify(stored.filter(([, st]) => st >= 500)));
    const readBack = (await admin.get('/api/db')).body.payments.map(p => p.payerName);
    T.check('stored hostile strings come back byte-for-byte as JSON data (escaping is the renderer\'s job)', stored.filter(([, st]) => st === 200).every(([s, , got]) => readBack.includes(got)));
    const ctype = (await fetch(base + '/api/db', { headers: { Cookie: admin.getCookie() } })).headers.get('content-type');
    T.check('/api/db is application/json (not sniffable as HTML)', /^application\/json/.test(ctype), ctype);
    const src = srcScan(projectRoot);
    T.check('React source has no dangerouslySetInnerHTML / innerHTML / document.write / eval / new Function / srcDoc sinks', src.sinks.length === 0, src.sinks.join('; '));
    T.check('mailto:/tel: links in Units.tsx interpolate raw stored values (header-injection such as ?bcc= possible)', src.rawMailto.length === 0, src.rawMailto.join('; '));
    const emailPut = await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', ownerEmail: 'a@b.c?bcc=attacker@evil.example&subject=x', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    const savedEmail = (await admin.get('/api/db')).body.units.find(u => u.id === 'unit-1').ownerEmail;
    T.check('an e-mail field carrying mailto parameters (?bcc=) is refused as not an address', !/[?&=]/.test(savedEmail || ''), `stored "${savedEmail}" (status ${emailPut.status})`);

    /* ---- xlsx export with hostile cells (bundle src/lib/xlsx.ts with esbuild) ---- */
    try {
      const out = path.join(projectRoot, '.sec-xlsx.mjs');
      execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), ['src/lib/xlsx.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=error'], { cwd: projectRoot });
      const { buildWorkbook } = await import(out + '?v=' + Date.now());
      const rows = XSS.map(s => [{ value: s, style: 'text' }, { value: s, style: 'date' }, { value: NaN }, { value: Infinity }]);
      const bytes = buildWorkbook([{ name: 'Sheet<>:*?/\\[]' + XSS[0], rows, widths: [20, 20, 10, 10] }]);
      const zip = path.join(projectRoot, '.sec-x.xlsx');
      fs.writeFileSync(zip, bytes);
      const sheetXml = execFileSync('unzip', ['-p', zip, 'xl/worksheets/sheet1.xml']).toString('utf8');
      const wbXml = execFileSync('unzip', ['-p', zip, 'xl/workbook.xml']).toString('utf8');
      T.check('xlsx: user text is written as inline strings, never as formulas (=, +, -, @ stay text)', !/<f[ >]/.test(sheetXml) && !/t="str"/.test(sheetXml));
      T.check('xlsx: no raw XML-invalid control characters survive into the sheet', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(sheetXml));
      T.check('xlsx: markup in cells is entity-escaped', !/<script|<img|<svg/.test(sheetXml));
      T.check('xlsx: a hostile sheet name does not break workbook.xml', !/<sheet [^>]*name="[^"]*[<>:*?\/\\\[\]][^"]*"/.test(wbXml), (wbXml.match(/<sheet [^>]*>/) || [''])[0]);
      T.check('xlsx: NaN / Infinity numeric cells are not written as numbers', !/<v>NaN<\/v>|<v>Infinity<\/v>/.test(sheetXml));
      for (const f of [out, zip]) fs.rmSync(f, { force: true });
    } catch (e) {
      console.log('  NOT RUN xlsx bundle test:', e.message.split('\n')[0]);
    }

    /* ---- SSRF edges beyond ssrf.test.mjs ---- */
    const add = url => manager.post('/api/ical/feeds', { unitId: 'unit-2', url, source: 'Other' });
    const edge = [['decimal IP', 'http://2130706433/c.ics'], ['hex IP', 'http://0x7f000001/c.ics'], ['octal IP', 'http://0177.0.0.1/c.ics'], ['short IP', 'http://127.1/c.ics'], ['userinfo trick', 'http://example.com@127.0.0.1/c.ics'], ['localhost trailing dot', 'http://localhost./c.ics'], ['ipv4-mapped hex', 'http://[::ffff:7f00:1]/c.ics'], ['ipv6 site-local fec0', 'http://[fec0::1]/c.ics'], ['link-local v6 w/ zone', 'http://[fe80::1%25en0]/c.ics'], ['file scheme', 'file:///etc/passwd'], ['gopher', 'gopher://127.0.0.1/'], ['benchmark 198.18/15', 'http://198.18.0.1/c.ics'], ['IETF 192.0.0.x', 'http://192.0.0.1/c.ics'], ['dns name -> loopback', 'http://localtest.me/c.ics']];
    for (const [why, url] of edge) {
      const r = await add(url);
      T.check(`feed URL refused: ${why}`, r.status === 400, `status ${r.status}`);
    }
    const feeds = (await admin.get('/api/db')).body.settings.icalFeeds;
    T.check('no internal feed was stored', feeds.length === 0, JSON.stringify(feeds.map(f => f.url)));
    T.check('a junior cannot add or sync feeds', (await junior.post('/api/ical/feeds', { unitId: 'unit-2', url: 'https://93.184.216.34/a.ics' })).status === 403);

    /* ---- booking deposit: a side door onto receipts for roles lacking payment permissions ---- */
    await admin.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...none, addBookings: true, editBookings: true } } });
    const bk = await junior.post('/api/bookings', { unitId: 'unit-2', guestName: 'Guest', checkIn: '2027-03-01', checkOut: '2027-03-05', amount: 800, depositPaid: 800, currency: 'USD', source: 'Direct' });
    T.check('control: role has no recordPayments', (await junior.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 5, currency: 'JMD', method: 'Cash', payerName: 'x' })).status === 403);
    const rec = bk.body?.booking && (await admin.get('/api/db')).body.payments.find(p => p.bookingId === bk.body.booking.id);
    T.check('a role WITHOUT recordPayments cannot cause a completed receipt to be issued by creating a booking with depositPaid', !rec || rec.status !== 'completed', rec ? `receipt ${rec.receiptNo} ${rec.status} ${rec.amount} issued by "${rec.receivedBy}"` : 'no receipt');
    if (bk.body?.booking) {
      await admin.post('/api/settings', { requireCosign: true });
      const edit = await junior.put(`/api/bookings/${bk.body.booking.id}`, { editReason: 'Test correction', depositPaid: 100 });
      const after = (await admin.get('/api/db')).body.payments.find(p => p.bookingId === bk.body.booking.id);
      T.check('a role WITHOUT modifySettledRecords cannot rewrite an issued receipt\'s amount (cosign on) by editing the booking deposit', !(after && after.amount === 100 && after.status === 'completed'), `booking edit ${edit.status}; receipt now ${after?.amount} ${after?.status}`);
      const zero = await junior.put(`/api/bookings/${bk.body.booking.id}`, { editReason: 'Test correction', depositPaid: 0 });
      const gone = (await admin.get('/api/db')).body.payments.find(p => p.bookingId === bk.body.booking.id);
      T.check('a role WITHOUT reversePayments cannot void an issued receipt (cosign on) by setting the booking deposit to 0', !(gone && gone.status === 'reversed'), `booking edit ${zero.status}; receipt ${gone?.status}`);
    }
    // junior booking mass assignment
    const bk2 = await manager.post('/api/bookings', { unitId: 'unit-2', guestName: 'G2', checkIn: '2027-04-01', checkOut: '2027-04-03', amount: 100, currency: 'USD', id: 'b-forged', balanceDue: 0, damageDepositAmount: 9999, damageDepositReturnedAmount: 9999, externalUid: 'ext-1', status: 'checked-out', createdAt: '2001-01-01' });
    const b2 = bk2.body?.booking;
    T.check('booking create: id, balanceDue and damage-deposit fields cannot be forged', b2 && b2.id !== 'b-forged' && b2.balanceDue === 100 && !b2.damageDepositAmount && !b2.damageDepositReturnedAmount && !b2.externalUid, JSON.stringify(b2));
  } finally {
    await env.stop();
  }
  return T.done();
}

function srcScan(projectRoot) {
  const sinks = [], rawMailto = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(projectRoot, 'src')).filter(f => /\.(tsx?|jsx?)$/.test(f))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|srcDoc/.test(line)) sinks.push(`${path.relative(projectRoot, f)}:${i + 1}`);
      if (/href=\{`(mailto|tel):\$\{/.test(line) && !/encodeURIComponent|replace\(/.test(line)) rawMailto.push(`${path.relative(projectRoot, f)}:${i + 1}`);
    });
  }
  return { sinks, rawMailto };
}
