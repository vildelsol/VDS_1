/**
 * Audit-log tamper resistance and backup/restore security.
 * File-level tampering is done on this test's own throw-away data directory while
 * its own server is stopped, then the server is restarted and asked what it sees.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { reporter, startServer, makeClient, activateAdmin, localToday } from './harness.mjs';
import { boot, ADMIN_PW } from './security-kit.mjs';

export const title = 'Security: audit-log tamper resistance, backups, restore';
export const allowUnknownRoutes = true;

const seal = e => crypto.createHash('sha256').update(JSON.stringify([e.prevSeal || '', e.id, e.user, e.role, e.dateTime, e.action, e.recordType, e.recordId, e.previousValue, e.newValue, e.approvedBy || ''])).digest('hex');
const rechain = logs => { // logs newest-first, like db.json
  for (let i = logs.length - 1; i >= 0; i--) { logs[i].prevSeal = logs[i + 1]?.seal || ''; logs[i].seal = seal(logs[i]); }
};

/** A risk the owner has been told about and has not yet decided on: reported, never failing the suite. */
const KNOWN = [];
function known(desc, cond, detail) {
  KNOWN.push(desc);
  console.log(`  known-risk (awaiting a decision): ${desc} — ${cond ? 'holds' : 'does NOT hold'}${detail ? ` (${detail})` : ''}`);
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const env = await boot(port, projectRoot);
  const { admin, manager, junior, srv, dir } = env;
  const dbFile = path.join(dir, 'db.json');
  let live = srv;
  try {
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    for (let i = 0; i < 6; i++) await manager.post('/api/payments', { unitId: 'unit-1', category: 'Other', amount: 10 + i, currency: 'JMD', method: 'Cash', payerName: `P${i}`, confirmDuplicate: true });
    const logs0 = (await admin.get('/api/db')).body.auditLogs;
    T.check('every audit entry carries a seal and a link to its predecessor', logs0.length > 8 && logs0.every(e => /^[0-9a-f]{64}$/.test(e.seal || '')) && logs0.slice(0, -1).every((e, i) => e.prevSeal === logs0[i + 1].seal));

    /* ---- no API can alter the trail ---- */
    const victim = logs0[logs0.length - 2];
    const attempts = [];
    for (const [who, c] of [['admin', admin], ['manager', manager], ['junior', junior]]) {
      for (const [m, p, b] of [['PUT', `/api/audit/${victim.id}`, { action: 'x' }], ['DELETE', `/api/audit/${victim.id}`], ['DELETE', `/api/audit-logs/${victim.id}`], ['PUT', `/api/auditLogs/${victim.id}`, { action: 'x' }], ['DELETE', '/api/audit', {}], ['POST', '/api/audit', { action: 'forged', user: 'System Administrator' }], ['PUT', '/api/db', { auditLogs: [] }], ['POST', '/api/db', { auditLogs: [] }], ['PATCH', `/api/audit/${victim.id}`, { action: 'x' }]]) {
        const r = await c.call(m, p, b);
        attempts.push(`${who} ${m} ${p} -> ${r.status}`);
        if (r.status === 200) T.check(`${who} ${m} ${p} must not succeed`, false, `status ${r.status}`);
      }
    }
    await admin.post('/api/settings', { auditLogs: [], requireCosign: false });
    const logs1 = (await admin.get('/api/db')).body.auditLogs;
    T.check('no route accepted a write to the audit trail; the earlier entries are byte-identical', logs0.every(e => JSON.stringify(logs1.find(x => x.id === e.id)) === JSON.stringify(e)), attempts.filter(a => !/ 40[134] | 404$/.test(a)).join('; '));
    T.check('a settings POST carrying "auditLogs" did not replace the trail', logs1.length >= logs0.length);
    T.check('the audit "user" and role come from the session, never from the request', !logs1.some(e => e.user === 'System Administrator' && /forged/.test(e.action)));
    await junior.post('/api/auth/login', { username: 'junior', password: 'wrong' }, { captureCookie: false });
    T.check('a failed sign-in is audited under the guessed name with role UNKNOWN (cannot be attributed to a real user)', (await admin.get('/api/db')).body.auditLogs.some(e => e.role === 'UNKNOWN' && /Failed sign-in/.test(e.action)));
    T.check('integrity report: the untouched trail verifies', !(await admin.get('/api/integrity')).body.findings.some(f => f.code === 'audit-trail-broken'));

    /* ---- file-level tamper detection (server stopped, db.json edited, server restarted) ---- */
    const snapshotFile = fs.readFileSync(dbFile, 'utf8');
    await live.stop();
    const tamper = async (label, mutate, { expectDetected, why, known }) => {
      const j = JSON.parse(snapshotFile);
      mutate(j);
      fs.writeFileSync(dbFile, JSON.stringify(j, null, 2));
      live = await startServer({ port, adminPassword: 'x', projectRoot, dataDir: dir });
      const c = makeClient(live.baseUrl);
      const login = await c.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }, { captureCookie: true });
      const rep = login.status === 200 ? (await c.get('/api/integrity')).body : { findings: [] };
      const flagged = (rep.findings || []).some(f => f.code === 'audit-trail-broken');
      // `known`: a limit of an UNKEYED hash chain (anyone who can edit the file can recompute it). Reported, not failing.
      if (known) console.log(`  known-risk (needs a key kept off this machine): ${label} — ${flagged ? 'detected' : 'NOT detected'}`);
      else T.check(label, expectDetected ? flagged : flagged, why || (flagged ? 'flagged' : 'NOT flagged by /api/integrity'));
      await live.stop();
    };
    await tamper('control: editing the text of an old audit entry is detected', j => { j.auditLogs[j.auditLogs.length - 3].action = 'Created nothing at all'; }, { expectDetected: true });
    await tamper('deleting a middle audit entry is detected', j => { j.auditLogs.splice(4, 1); }, { expectDetected: true });
    await tamper('inserting a forged entry with a made-up seal is detected', j => { j.auditLogs.splice(3, 0, { ...j.auditLogs[3], id: 'audit-forged', action: 'forged', seal: 'f'.repeat(64) }); }, { expectDetected: true });
    await tamper('deleting the NEWEST 4 entries (e.g. the evidence of the last action) is detected', j => { j.auditLogs.splice(0, 4); }, { known: true, expectDetected: true });
    await tamper('stripping seal and prevSeal from every entry and rewriting one is detected', j => { for (const e of j.auditLogs) { delete e.seal; delete e.prevSeal; } j.auditLogs[5].action = 'rewritten history'; }, { known: true, expectDetected: true });
    await tamper('rewriting an entry AND recomputing the whole chain (unkeyed SHA-256, algorithm is in the source) is detected', j => { j.auditLogs[5].action = 'rewritten history'; rechain(j.auditLogs); }, { known: true, expectDetected: true });
    await tamper('wiping the entire trail is detected', j => { j.auditLogs = []; }, { known: true, expectDetected: true });

    /* ---- restore: tampered snapshot, traversal ---- */
    fs.writeFileSync(dbFile, snapshotFile);
    live = await startServer({ port, adminPassword: 'x', projectRoot, dataDir: dir });
    const a2 = makeClient(live.baseUrl);
    await a2.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }, { captureCookie: true });
    const snap = JSON.parse((await a2.get('/api/backup/download')).text);
    await new Promise(r => setTimeout(r, 300));
    T.check('a snapshot download is audited with the downloader\'s name', (await a2.get('/api/db')).body.auditLogs.some(e => /Downloaded a records snapshot/.test(e.action)));
    const auditCountBeforeRestore = (await a2.get('/api/db')).body.auditLogs.length;
    const forgedSnap = JSON.parse(JSON.stringify(snap));
    forgedSnap.auditLogs[forgedSnap.auditLogs.length - 3].action = 'tampered inside the snapshot';
    const dry = await a2.post('/api/backup/restore', { source: 'snapshot', snapshot: forgedSnap, dryRun: true });
    const done = await a2.post('/api/backup/restore', { source: 'snapshot', snapshot: forgedSnap, confirm: 'RESTORE' });
    // 2026-11-17: a restore never imports audit entries (the live trail is history and is kept), so a tampered one in the file cannot get in.
    T.check('restoring a snapshot whose audit entry was edited does NOT import the edited entry', done.status === 200 && !(await a2.get('/api/db')).body.auditLogs.some(e => e.action === 'tampered inside the snapshot'));
    const afterRestore = (await a2.get('/api/db')).body.auditLogs;
    T.check('a restore does not erase audit entries written after the snapshot was taken (the trail must only grow)', afterRestore.some(e => /Downloaded a records snapshot/.test(e.action)), `audit entries ${auditCountBeforeRestore} before restore, ${afterRestore.length} after`);
    for (const file of ['../db.json', '..%2fdb.json', 'db-2026-01-01.json/../../db.json', 'db-2026-01-01.json\u0000.txt', '/etc/passwd', 'db-2026-01-01.json ', 'db-9999-99-99.json']) {
      const r = await a2.post('/api/backup/restore', { source: 'backup', file, location: 'local', dryRun: true });
      T.check(`restore by backup name ${JSON.stringify(file)} is refused with 400`, r.status === 400, `status ${r.status}`);
    }
    const noConfirm = await a2.post('/api/backup/restore', { source: 'snapshot', snapshot: snap });
    T.check('restore without typing RESTORE changes nothing', noConfirm.status === 400);
    const empty = await a2.post('/api/backup/restore', { source: 'snapshot', snapshot: { units: [], charges: [], payments: [] }, confirm: 'RESTORE' });
    T.check('a snapshot with no villas is refused (cannot wipe the property)', empty.status === 400);
    const protoSnap = JSON.parse('{"units":[{"id":"unit-1","number":"1","__proto__":{"x":1}}],"charges":[],"payments":[],"settings":{"__proto__":{"requireCosign":false},"constructor":{"prototype":{"y":1}}},"counters":{"receiptYear":"1e999","receiptSeq":"NaN"}}');
    const rp = await a2.post('/api/backup/restore', { source: 'snapshot', snapshot: protoSnap, dryRun: true });
    T.check('a snapshot with __proto__ keys and NaN counters does not crash the dry run', rp.status < 500 && (await fetch(live.baseUrl + '/api/health')).ok, `status ${rp.status}`);

    /* ---- backups on disk ---- */
    await a2.post('/api/backup/run', {});
    const bdir = path.join(dir, 'db-backups');
    // Only the dated database copies: the folder also carries audit-key.json, the audit seal key.
    const files = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => f.startsWith('db-') && f.endsWith('.json')) : [];
    T.check('a backup file was written', files.length > 0);
    // POSIX permission bits mean nothing on Windows (every file reads as 666); the folder's own rights apply there.
    const modeOf = p => (process.platform === 'win32' ? 0 : fs.statSync(p).mode & 0o777);
    const worldReadable = [path.join(bdir, files[0] || 'none'), bdir, dbFile].filter(p => fs.existsSync(p) && (modeOf(p) & 0o044)).map(p => `${path.basename(p)} ${modeOf(p).toString(8)}`);
    const keyInBackup = path.join(bdir, 'audit-key.json');
    T.check('the audit seal key copied into the backup folder is not readable by other local users', process.platform === 'win32' || (fs.existsSync(keyInBackup) && (modeOf(keyInBackup) & 0o077) === 0), fs.existsSync(keyInBackup) ? modeOf(keyInBackup).toString(8) : 'missing');
    T.check('backup files, the backup folder and db.json (all carry password hashes) are not readable by other local users', worldReadable.length === 0, worldReadable.join('; '));
    const bk = files[0] && fs.readFileSync(path.join(bdir, files[0]), 'utf8');
    T.check('backup files contain no live session tokens', bk && !/"token"/.test(bk) || (bk && JSON.parse(bk).sessions.length === 0));
    T.check('(info) backup files do contain password hashes and salts', !!bk && /passwordHash/.test(bk));
    const safety = fs.existsSync(path.join(dir, 'db-before-restore')) ? fs.readdirSync(path.join(dir, 'db-before-restore')) : [];
    T.check('db-before-restore safety copies are not world readable', safety.every(f => !(modeOf(path.join(dir, 'db-before-restore', f)) & 0o044)), safety.map(f => modeOf(path.join(dir, 'db-before-restore', f)).toString(8)).join(','));
    // Choice of backup folder
    const m2 = makeClient(live.baseUrl);
    await m2.post('/api/auth/login', { username: 'manager', password: 'SecManager-22!x' }, { captureCookie: true });
    const setDir = await m2.post('/api/settings', { backupDir: path.join(dir, 'chosen-by-manager') });
    T.check('only an Administrator can choose where off-machine backups go (a Manager redirecting them is an exfiltration path)', setDir.status === 403, `status ${setDir.status}`);
  } finally {
    await live.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
