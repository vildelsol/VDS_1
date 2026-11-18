/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Audit Trail and System Settings screens show what the server knows.
 *
 *  - The Audit Trail states the seal: intact, broken, or key missing, from the
 *    real integrity report of a server whose trail was really tampered with or
 *    whose key was really moved away. It used to say nothing, so a tampered
 *    trail read exactly like an intact one.
 *  - An entry's detail shows what was recorded even when there is no previous
 *    value (creations), and shows who approved it.
 *  - When the screen holds only the newest entries (GET /api/db sends 2000), it
 *    says so, against the whole-trail count the integrity report carries.
 *  - Search reaches the recorded values, not only the action line.
 *  - The permission matrix has a row for every permission, overrideMoneyGuards
 *    included, and only an Administrator can tick that one.
 *
 * Rendered with react-dom/server (no browser); effects do not run, so the
 * pieces are exported and rendered directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter, startServer, makeClient } from './harness.mjs';
import { boot, ADMIN_PW } from './security-kit.mjs';

export const title = 'Audit records: Audit Trail and System Settings screens';

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-audit-ui-'));
  const outfile = path.join(dir, 'audit-ui.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { createElement } from 'react';
        export { AuditChainStatus, AuditEntryDetail, filterAuditLogs, auditCoverageNote, default as Audit } from './src/components/Audit';
        export { default as SystemSettings } from './src/components/SystemSettings';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  return { mod: await import(pathToFileURL(outfile).href), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const { mod, cleanup } = await load(projectRoot);
  const { renderToStaticMarkup: html, createElement: h, AuditChainStatus, AuditEntryDetail, filterAuditLogs, auditCoverageNote, Audit, SystemSettings } = mod;
  const status = report => (html(h(AuditChainStatus, { report })).match(/data-chain-status="([^"]+)"/) || [])[1];

  const env = await boot(port, projectRoot);
  const { admin, dir } = env;
  let live = env.srv;
  try {
    /* ---------------- chain status from a real server ---------------- */
    await admin.put('/api/units/unit-1', { number: '1', ownerName: 'Owner', status: 'long-term', monthlyRent: 50000, monthlyMaintenance: 10000, currency: 'JMD', maintCurrency: 'JMD', tenantName: 'T', rentDueDay: 1, maintDueDay: 1 });
    const intact = (await admin.get('/api/integrity')).body;
    const total = (await admin.get('/api/db')).body.auditLogs.length;
    T.check('the integrity report carries the whole trail\'s entry count', intact.counts.auditLogs === total, `${intact.counts.auditLogs} vs ${total}`);
    T.check('an untouched trail renders as intact', status(intact) === 'intact', status(intact));
    T.check('the intact banner states the entry count', html(h(AuditChainStatus, { report: intact })).includes(`(${total} entries)`));
    T.check('no report yet renders as checking, never as intact', status(null) === 'checking');
    T.check('a check that could not be reached renders as unverified', /data-chain-status="unverified"/.test(html(h(AuditChainStatus, { report: null, failed: true }))));

    const dbFile = path.join(dir, 'db.json');
    const clean = fs.readFileSync(dbFile, 'utf8');
    const restart = async mutate => {
      await live.stop();
      mutate();
      live = await startServer({ port, adminPassword: 'x', projectRoot, dataDir: dir });
      const c = makeClient(live.baseUrl);
      await c.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }, { captureCookie: true });
      return (await c.get('/api/integrity')).body;
    };

    const broken = await restart(() => {
      const j = JSON.parse(clean);
      j.auditLogs[j.auditLogs.length - 2].action = 'edited by hand';
      fs.writeFileSync(dbFile, JSON.stringify(j));
    });
    T.check('(setup) the server reports the edited trail as audit-trail-broken', broken.findings.some(f => f.code === 'audit-trail-broken'));
    const brokenHtml = html(h(AuditChainStatus, { report: broken }));
    T.check('a tampered trail renders as broken on the Audit Trail screen', status(broken) === 'broken', status(broken));
    const victim = JSON.parse(clean).auditLogs.slice(-2)[0].id;
    T.check('the broken banner names the altered entry', brokenHtml.includes(victim));

    const keyFile = path.join(dir, 'audit-key.json');
    const aside = keyFile + '.aside';
    const missing = await restart(() => {
      fs.writeFileSync(dbFile, clean);
      fs.renameSync(keyFile, aside);
    });
    T.check('(setup) the server reports the moved key as audit-key-missing', missing.findings.some(f => f.code === 'audit-key-missing'), missing.findings.map(f => f.code).join(','));
    const missingHtml = html(h(AuditChainStatus, { report: missing }));
    T.check('a missing key renders as a serious finding, not as intact', /data-finding="audit-key-missing"/.test(missingHtml) && status(missing) !== 'intact', status(missing));
    // The remedy the finding prescribes: put the key back, WITHOUT rewinding db.json. The sign-ins made
    // while it was missing are real entries sealed without it; they must not read as tampering.
    const back = await restart(() => fs.renameSync(aside, keyFile));
    const codes = back.findings.map(f => f.code);
    T.check('putting the key back does not turn the entries written meanwhile into "audit trail altered"', !codes.includes('audit-trail-broken'), codes.join(','));
    const gap = back.findings.find(f => f.code === 'audit-sealed-without-key');
    T.check('...those entries are named as sealed without the key instead', !!gap && gap.records.length >= 1, codes.join(','));
    T.check('...and the key-missing finding is gone', !codes.includes('audit-key-missing'));
    T.check('the screen shows them as a serious seal finding, not as intact', /data-finding="audit-sealed-without-key"/.test(html(h(AuditChainStatus, { report: back }))) && status(back) !== 'intact');
    // Control: such an entry, edited afterwards, is still caught.
    const gapId = gap?.records[0];
    const editedGap = await restart(() => {
      const j = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      const e = j.auditLogs.find(x => x.id === gapId);
      if (e) e.action = 'rewritten while the key was away';
      fs.writeFileSync(dbFile, JSON.stringify(j));
    });
    T.check('control: an entry sealed without the key that is later edited is reported as broken', editedGap.findings.some(f => f.code === 'audit-trail-broken' && f.records.some(r => r.startsWith(gapId))), editedGap.findings.map(f => f.code).join(','));
    // Control: the label cannot be used to launder an edit to a keyed entry.
    const laundered = await restart(() => {
      const j = JSON.parse(clean);
      const e = j.auditLogs[j.auditLogs.length - 3];
      e.action = 'laundered';
      e.sealKind = 'sha256-key-missing';
      fs.writeFileSync(dbFile, JSON.stringify(j));
    });
    T.check('control: relabelling an edited keyed entry as "sealed without the key" is still broken', laundered.findings.some(f => f.code === 'audit-trail-broken'), laundered.findings.map(f => f.code).join(','));
    const fresh = await restart(() => fs.writeFileSync(dbFile, clean));
    T.check('control: the untouched trail with its key is intact', status(fresh) === 'intact', fresh.findings.map(f => f.code).join(','));
    const failedCheck = { ...intact, findings: [{ severity: 'serious', code: 'integrity-check-failed', message: 'boom', records: [] }] };
    T.check('an integrity check that failed is never shown as intact', status(failedCheck) !== 'intact');

    /* ---------------- entry detail ---------------- */
    const created = { id: 'a1', user: 'Sec finance', role: 'FINANCE_OFFICER', dateTime: '2026-11-01T10:00:00Z', action: 'Recorded payment', recordType: 'Payment', recordId: 'p-1', previousValue: '', newValue: 'JMD 5000 from Tenant One' };
    T.check('an entry with no previous value still shows what was recorded', html(h(AuditEntryDetail, { log: created })).includes('JMD 5000 from Tenant One'));
    const cosigned = { ...created, previousValue: 'a', newValue: 'b', approvedBy: 'Second Approver' };
    T.check('an entry shows who approved it', html(h(AuditEntryDetail, { log: cosigned })).includes('Second Approver'));
    T.check('search finds an entry by what it recorded', filterAuditLogs([created], 'tenant one', 'ALL').length === 1);
    T.check('control: search still excludes what does not match', filterAuditLogs([created], 'nothing like it', 'ALL').length === 0);
    T.check('the role filter keeps only that role', filterAuditLogs([created], '', 'MANAGER').length === 0 && filterAuditLogs([created], '', 'FINANCE_OFFICER').length === 1);

    /* ---------------- truncation is stated ---------------- */
    T.check('a screen holding 2000 of 2500 entries says so', /newest 2000 of 2500/.test(auditCoverageNote(2000, 2500)));
    T.check('control: a complete trail carries no note', auditCoverageNote(40, 40) === '' && auditCoverageNote(40, undefined) === '');
    const page = html(h(Audit, { auditLogs: [created] }));
    T.check('the Audit Trail screen renders the seal status before the entries', page.indexOf('data-chain-status') >= 0 && page.indexOf('data-chain-status') < page.indexOf('Compliance Log Register'));

    /* ---------------- the permission matrix ---------------- */
    const s = (await admin.get('/api/db')).body.settings;
    const props = role => ({
      settings: s, users: [], units: [],
      session: { id: 'u', name: 'U', username: 'u', email: '', position: '', role, mustChangePassword: false, permissions: s.rolePermissions[role] || s.rolePermissions.MANAGER },
      onUpdateSettings: async () => {}, onCreateUser: async () => {}, onUpdateUser: async () => {}, onResetPassword: async () => {},
      onAddFeed: async () => {}, onRemoveFeed: async () => {}, onSyncFeed: async () => ({ results: [] })
    });
    const boxes = (markup, label) => [...markup.matchAll(/<input[^>]*>/g)].map(m => m[0]).filter(t => t.includes(`aria-label="${label} for`));
    const label = 'Override money checks (duplicate, wrong currency, already settled) with a recorded reason';
    const asManager = html(h(SystemSettings, props('MANAGER')));
    const asAdmin = html(h(SystemSettings, props('ADMINISTRATOR')));
    T.check('the permission matrix has an override row for each editable role', boxes(asAdmin, label).length === 3, `${boxes(asAdmin, label).length}`);
    T.check('an Administrator can tick it', boxes(asAdmin, label).every(t => !/ disabled=""/.test(t)));
    T.check('a Manager sees it but cannot tick it', boxes(asManager, label).length === 3 && boxes(asManager, label).every(t => / disabled=""/.test(t)));
    T.check('control: a Manager can still tick an ordinary permission', boxes(asManager, 'Record payments &amp; issue receipts').every(t => !/ disabled=""/.test(t)) && boxes(asManager, 'Record payments &amp; issue receipts').length === 3);
  } finally {
    await live.stop().catch(() => {});
    await env.stop().catch(() => {});
    cleanup();
  }
  return T.done();
}
