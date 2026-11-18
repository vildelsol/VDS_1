/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Calendar days are local, never a slice of a UTC instant.
 *
 * `new Date().toISOString().slice(0, 10)`, or slicing a stored server timestamp,
 * gives the UTC day. In Jamaica (UTC-5) after 7pm that is tomorrow: a payment is
 * dated ahead (and refused as future-dated) or a charge lands in the wrong month.
 *
 * 1. A scan of src/ fails on any slice/split of an ISO timestamp outside
 *    src/lib/dates.ts, which owns the conversion (today(), dayOfTimestamp()).
 * 2. The helpers are run in child processes under TZ=UTC and TZ=America/Jamaica
 *    with Date pinned to a fixed instant, never the real clock.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Local calendar days';

const HELPER = path.join('src', 'lib', 'dates.ts');

// A timestamp-ish expression cut to a day or month.
const PATTERNS = [
  /toISOString\(\)\s*\.\s*(slice|substring|substr|split)\s*\(/,
  /toISOString\(\)\s*\[/,
  /\b\w*(At|Time|Timestamp)\b\??\.\s*(slice|substring|substr)\s*\(\s*0\s*,\s*(7|10)\s*\)/,
  /\.split\(\s*['"`]T['"`]\s*\)/,
];

export function scanSource(root) {
  const hits = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(ent.name)) {
        const rel = path.relative(root, p);
        if (rel === HELPER) continue;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (PATTERNS.some(re => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(path.join(root, 'src'));
  return hits;
}

const PROBE = `
const lib = require(process.argv[2]);
const pinned = Date.parse(process.argv[3]);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(pinned); else super(...a); }
  static now() { return pinned; }
}
globalThis.Date = FixedDate;
process.stdout.write(JSON.stringify({
  today: lib.today(),
  month: lib.currentMonth(),
  ts: lib.dayOfTimestamp(process.argv[3]),
  plain: lib.dayOfTimestamp('2026-11-18'),
  empty: lib.dayOfTimestamp(''),
  junk: lib.dayOfTimestamp('not a date'),
}));
`;

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-dates-'));
  try {
    /* ---- scan ---- */
    const hits = scanSource(projectRoot);
    T.check('no UTC instant is sliced into a calendar day outside src/lib/dates.ts', hits.length === 0, hits.join(' | '));

    // Positive control: the scanner does see the defect it guards against.
    const fake = path.join(dir, 'src');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'a.tsx'), "const d = new Date().toISOString().slice(0, 10);\nconst e = x.lastSyncAt.substring(0, 10);\nconst f = new Date().toISOString().split('T')[0];\n");
    T.check('the scanner flags each kind of slice (positive control)', scanSource(dir).length === 3, scanSource(dir).join(' | '));

    /* ---- helper under pinned clock, two zones ---- */
    const out = path.join(dir, 'dates.cjs');
    await build({ entryPoints: [path.join(projectRoot, HELPER)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const probe = path.join(dir, 'probe.cjs');
    fs.writeFileSync(probe, PROBE);
    const at = (tz, instant) => JSON.parse(execFileSync(process.execPath, [probe, out, instant], { env: { ...process.env, TZ: tz } }).toString());

    // 30 Nov 2026, 20:30 in Jamaica = 1 Dec 01:30 UTC: the month boundary is the worst case.
    const evening = '2026-12-01T01:30:00.000Z';
    const ja = at('America/Jamaica', evening);
    T.check('Jamaica 8:30pm: today() is still the local day', ja.today === '2026-11-30', ja.today);
    T.check('Jamaica 8:30pm: currentMonth() is still the local month', ja.month === '2026-11', ja.month);
    T.check('Jamaica: a stored UTC timestamp shows its local day', ja.ts === '2026-11-30', ja.ts);
    const utc = at('UTC', evening);
    T.check('UTC: today() is the UTC day', utc.today === '2026-12-01', utc.today);
    T.check('UTC: currentMonth() is the UTC month', utc.month === '2026-12', utc.month);
    T.check('UTC: a stored timestamp shows its UTC day', utc.ts === '2026-12-01', utc.ts);
    const morning = at('America/Jamaica', '2026-11-18T14:00:00.000Z');
    T.check('Jamaica daytime: same day either way', morning.today === '2026-11-18' && morning.ts === '2026-11-18', JSON.stringify(morning));
    for (const [z, r] of [['Jamaica', ja], ['UTC', utc]]) {
      T.check(`${z}: a plain calendar day passes through unchanged`, r.plain === '2026-11-18', r.plain);
      T.check(`${z}: empty and unparseable values give ''`, r.empty === '' && r.junk === '', JSON.stringify([r.empty, r.junk]));
    }
    return T.done();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
