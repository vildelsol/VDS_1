/*
 * Two guards added after defects that no test was watching (2026-11-25).
 *
 * 1. The Everything operating statement is the strata book plus ISPO's book,
 *    line for line, in each currency. It is checked on the rendered page as well
 *    as from the function: v1.16.26 shipped with correct figures and a note under
 *    them saying ISPO's maintenance was "not counted as income a second time",
 *    the old rule. A reader of the page was told the opposite of the numbers.
 *
 * 2. No on-screen text says "levy" (Ro, 2026-11-24: "nobody uses the word levy,
 *    leave it as maintenance"). Every string a user can see, in the screens,
 *    the libraries and the server's messages, is read from the source with the
 *    TypeScript parser. Comments and code names are not on screen and are left
 *    alone; record keys such as `levy-differs-from-schedule` are never shown.
 *
 * The release build runs this suite before it makes the exe, so a breach here
 * stops the release.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Guards: the combined statement is strata plus ISPO, and no screen says "levy"';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
const C = n => Math.round(n * 100);

const LEVY = /\blev(y|ies|ied)\b/i;
/*
 * Wording of rules that have been replaced. When Ro changes a rule, add the old
 * wording here once; the scan then keeps it off every screen in the app.
 */
export const RETIRED_WORDING = [
  [/not counted as income a second time/i, 'combined view shows whole figures, Ro 2026-11-24'],
  [/already inside the rent and bookings/i, 'combined view shows whole figures, Ro 2026-11-24'],
  [/rent (shown )?net of (the )?maintenance/i, 'rent is shown whole, Ro 2026-11-24'],
  [/left out of the combined books/i, 'ISPO maintenance is counted on the combined view, Ro 2026-11-24'],
  [/rent less (the )?maintenance/i, 'rent is shown whole, Ro 2026-11-24']
];

async function load(projectRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-guards-'));
  const outfile = path.join(dir, 'm.mjs');
  await build({
    stdin: {
      contents: `
        export * as fin from './src/lib/finance';
        export { renderToStaticMarkup } from 'react-dom/server';
        export { default as React } from 'react';
        export { forgetScreenState } from './src/lib/screenState';
        export { default as OperatingStatement } from './src/components/OperatingStatement';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', outfile, logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/* The 16-villa register for October 2026; every figure is hand-checkable. */
function register(fin) {
  const unit = (id, o = {}) => ({
    id, number: id.toUpperCase(), ownerName: 'ISPO', tenantName: '', status: 'short-term', monthlyRent: 0,
    monthlyMaintenance: 20000, currency: 'JMD', maintCurrency: 'JMD', meterNumber: '', notes: '', rentDueDay: 1, maintDueDay: 1, ...o
  });
  const owners = ['a2', 'b7', 'b8', 'b9', 'c12'].map(id => unit(id, { status: 'owner-occupied', ownerName: 'Owner ' + id.toUpperCase() }));
  const lets = ['a5', 'b10', 'c15'].map(id => unit(id, { status: 'long-term', tenantName: 'Tenant ' + id.toUpperCase(), monthlyRent: 100000 }));
  const shorts = ['a1', 'a3', 'a4', 'b6', 'c14', 'c16'].map(id => unit(id));
  const usd = ['c11', 'c13'].map(id => unit(id, { maintCurrency: 'USD', monthlyMaintenance: 125 }));
  const units = [...owners, ...lets, ...shorts, ...usd];
  const m = '2026-10';
  const charges = [];
  for (const u of units) charges.push({ id: `c-${u.id}-m`, unitId: u.id, unitNumber: u.number, category: 'Maintenance', periodMonth: m, dueDate: `${m}-01`, amount: u.monthlyMaintenance, currency: u.maintCurrency, status: 'open', payerName: u.ownerName, createdAt: `${m}-01T00:00:00Z` });
  for (const u of lets) charges.push({ id: `c-${u.id}-r`, unitId: u.id, unitNumber: u.number, category: 'Rent', periodMonth: m, dueDate: `${m}-01`, amount: 100000, rentPortion: 80000, maintenancePortion: 20000, currency: 'JMD', status: 'open', payerName: u.tenantName, createdAt: `${m}-01T00:00:00Z` });
  const payments = []; let n = 0;
  const pay = (u, category, amount, date, currency, payerName) => payments.push({ id: `p-${++n}`, receiptNo: `R${n}`, unitId: u.id, unitNumber: u.number, category, amount, currency, date, status: 'completed', payerName, method: 'Bank Transfer' });
  for (const u of lets) pay(u, 'Rent', 100000, '2026-10-05', 'JMD', u.tenantName);
  for (const u of owners.filter(u => u.id !== 'b9')) pay(u, 'Maintenance', 20000, '2026-10-06', 'JMD', u.ownerName);
  for (const u of shorts) pay(u, 'Maintenance', 20000, '2026-10-07', 'JMD', 'ISPO');
  for (const u of usd) pay(u, 'Maintenance', 125, '2026-10-07', 'USD', 'ISPO');
  pay(shorts[0], 'Booking', 50000, '2026-10-10', 'JMD', 'Guest One');
  pay(shorts[1], 'Booking', 400, '2026-10-12', 'USD', 'Guest Two');
  const expenses = [
    { id: 'e1', description: 'Security October', category: 'Security', amount: 60000, currency: 'JMD', date: '2026-10-15', datePaid: '2026-10-15', status: 'paid', vendor: 'Guard Co', fund: 'strata' },
    { id: 'e2', description: 'Short-let supplies A1', category: 'Supplies', amount: 15000, currency: 'JMD', date: '2026-10-16', datePaid: '2026-10-16', status: 'paid', vendor: 'Supply Co', fund: 'ispo', unitId: 'a1' }
  ];
  return { units, expenses, payments: [...payments, ...fin.settledFromRent(charges, payments, '2026-10-31')] };
}

/* Every string a user can see, read with the TypeScript parser. */
export function visibleStringsMatching(projectRoot, files, re, base = projectRoot) {
  const ts = createRequire(path.join(projectRoot, 'package.json'))('typescript');
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      const lit = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
      if (lit) {
        const t = node.text;
        const isKey = /^[a-z0-9-]+$/.test(t) && t.includes('-'); // record keys and ids, never shown
        const isImport = node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
        if (re.test(t) && !isKey && !isImport) {
          hits.push(`${path.relative(base, f)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${t.trim().slice(0, 100)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

function sourceFiles(projectRoot) {
  const out = [path.join(projectRoot, 'server.ts')];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(projectRoot, 'src'));
  walk(path.join(projectRoot, 'server'));
  return out;
}

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const RealDate = Date;
  const { mod: M, cleanup } = await load(projectRoot);
  try {
    /* ---------------- 1. Everything = strata + ISPO ---------------- */
    M.fin.setOwnershipRegistry([]);
    const D = register(M.fin);
    const st = (book, cur) => M.fin.operatingStatement(D.payments, D.expenses, D.units, cur, '2026-10-01', '2026-10-31', { book });
    for (const cur of ['JMD', 'USD']) {
      const [s, i, e] = [st('strata', cur), st('ispo', cur), st('everything', cur)];
      T.check(`${cur}: Everything income = strata income + ISPO income`, C(e.totalIncome) === C(s.totalIncome) + C(i.totalIncome), `${e.totalIncome} vs ${s.totalIncome} + ${i.totalIncome}`);
      T.check(`${cur}: Everything expenditure = strata + ISPO expenditure`, C(e.totalExpenditure) === C(s.totalExpenditure) + C(i.totalExpenditure), `${e.totalExpenditure} vs ${s.totalExpenditure} + ${i.totalExpenditure}`);
      T.check(`${cur}: Everything surplus = strata surplus + ISPO surplus`, C(e.surplus) === C(s.surplus) + C(i.surplus), `${e.surplus} vs ${s.surplus} + ${i.surplus}`);
      // Each income heading on the combined page is the two books' headings added together.
      const g = (st_, label) => C(st_.income.find(x => x.label === label)?.total || 0);
      for (const label of new Set([...s.income, ...i.income, ...e.income].map(x => x.label))) {
        T.check(`${cur}: "${label}" on Everything = strata + ISPO`, g(e, label) === g(s, label) + g(i, label), `${g(e, label)} vs ${g(s, label)} + ${g(i, label)}`);
      }
      T.check(`${cur}: nothing is left off the combined income`, (e.excludedIncome || []).length === 0, JSON.stringify(e.excludedIncome));
    }
    // By hand, JMD: rent 300,000 + maintenance 260,000 (80,000 owners, 180,000 ISPO) + bookings 50,000.
    const ej = st('everything', 'JMD');
    T.check('by hand: Everything JMD income J$610,000, expenditure J$255,000, surplus J$355,000',
      ej.totalIncome === 610000 && ej.totalExpenditure === 255000 && ej.surplus === 355000, `${ej.totalIncome} / ${ej.totalExpenditure} / ${ej.surplus}`);

    /* ---- the rendered page: its totals and its words agree with the figures ---- */
    globalThis.Date = class extends RealDate {
      constructor(...a) { a.length ? super(...a) : super('2026-11-10T12:00:00'); }
      static now() { return new RealDate('2026-11-10T12:00:00').getTime(); }
    };
    const session = { role: 'ADMINISTRATOR', permissions: {} };
    const page = book => {
      M.forgetScreenState(); // opens on "last month": October, with the clock in November
      return text(M.renderToStaticMarkup(M.React.createElement(M.OperatingStatement, { units: D.units, payments: D.payments, expenses: D.expenses, book, depositsKept: [], settings: {}, session })));
    };
    const ev = page('everything');
    T.check('page: Everything shows JMD income J$610,000.00', /JMD Total income J\$610,000\.00 Total expenditure J\$255,000\.00 Surplus for the period J\$355,000\.00/.test(ev), ev.match(/JMD Total income.{0,90}/)?.[0]);
    T.check('page: Everything shows USD income $650.00', /USD Total income \$650\.00 Total expenditure \$250\.00 Surplus for the period \$400\.00/.test(ev), ev.match(/USD Total income.{0,90}/)?.[0]);
    T.check('page: ISPO’s maintenance is listed as paid to the corporation', /Maintenance contributions paid to the corporation J\$180,000\.00/.test(ev));
    // The words under the figures must not describe the retired rule.
    const retired = [/not counted as income/i, /second time/i, /already inside the rent/i, /left out of the combined/i, /net of (the )?maintenance/i];
    for (const re of retired) T.check(`page: no note says ${re}`, !re.test(ev), ev.match(new RegExp(`.{0,80}${re.source}.{0,40}`, 'i'))?.[0]);
    T.check('page: the note says it is shown in full both ways', /shown in full as maintenance received and again under expenditure/.test(ev));
    T.check('control: the strata page opens on October too and shows J$260,000.00', /JMD Total income J\$260,000\.00/.test(page('strata')));

    /* ---------------- 2. no screen says "levy" ---------------- */
    const files = sourceFiles(projectRoot);
    T.check('the scan reads the screens, libraries and server', files.length > 40 && files.some(f => f.endsWith('Dashboard.tsx')) && files.some(f => f.endsWith('server.ts')), String(files.length));
    const hits = visibleStringsMatching(projectRoot, files, LEVY);
    T.check('no on-screen string says "levy"', hits.length === 0, hits.slice(0, 8).join(' | '));
    // Retired rules: wording that described a rule Ro has replaced must not reappear on any screen.
    for (const [re, why] of RETIRED_WORDING) {
      const h = visibleStringsMatching(projectRoot, files, re);
      T.check(`no screen anywhere says ${re} (${why})`, h.length === 0, h.slice(0, 5).join(' | '));
    }
    // Positive control: the scanner does find the word in each kind of on-screen text.
    const probe = path.join(os.tmpdir(), `vds-levy-probe-${process.pid}.tsx`);
    fs.writeFileSync(probe, [
      "// the levy in a comment is not on screen",
      "const levyTotal = 1;",
      "const a = 'Maintenance levy schedule';",
      "const b = `Owed ${levyTotal} in levy`;",
      "const c = <p>The levy of</p>;",
      "const key = 'levy-differs-from-schedule';"
    ].join('\n'));
    try {
      const found = visibleStringsMatching(projectRoot, [probe], LEVY, os.tmpdir());
      T.check('control: the scan finds "levy" in a string, a template and JSX text', found.length === 3, found.join(' | '));
      T.check('control: it ignores comments, code names and record keys', !found.some(h => /comment|differs-from/.test(h)));
    } finally {
      fs.rmSync(probe, { force: true });
    }
  } finally {
    globalThis.Date = RealDate;
    cleanup();
  }
  return T.done();
}
