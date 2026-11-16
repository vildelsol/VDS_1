/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which Windows drives count as external. A second internal disk, an optical
 * drive or a network share must never be adopted as the off-machine backup; a
 * USB stick and a USB hard disk must be. The classifier is exercised with the
 * rows Windows reports; on a real Windows machine (CI) the live query is
 * checked too.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { reporter } from './harness.mjs';

export const title = 'Windows: only genuinely external drives are treated as external';

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-windrv-'));
  const outfile = path.join(dir, 'bundle.mjs');
  try {
    await build({
      entryPoints: [path.join(projectRoot, 'server', 'windowsDrives.ts')],
      bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent'
    });
    const m = await import(pathToFileURL(outfile).href);
    const { isExternalWindowsDrive: ext, parseWindowsDriveReport: parse } = m;
    const d = (letter, driveType, bus = '') => ({ letter, driveType, bus });

    T.check('a removable-type drive (USB stick, card) is external', ext(d('E', 2)) === true);
    T.check('a USB hard disk, reported as fixed on a USB bus, is external', ext(d('F', 3, 'USB')) === true);
    T.check('an SD or MMC card reader is external', ext(d('G', 3, 'SD')) === true && ext(d('G', 3, 'mmc')) === true);
    T.check('a second internal SATA disk is NOT external', ext(d('D', 3, 'SATA')) === false);
    T.check('an internal NVMe or RAID disk is NOT external', ext(d('D', 3, 'NVMe')) === false && ext(d('H', 3, 'RAID')) === false);
    T.check('a fixed disk with no bus information is NOT external', ext(d('D', 3)) === false);
    T.check('an optical drive is NOT external', ext(d('E', 5)) === false);
    T.check('a network share is NOT external', ext(d('Z', 4)) === false);
    T.check('a RAM disk is NOT external', ext(d('R', 6)) === false);
    T.check('the system drive is never external, even if reported removable', ext(d('C', 2)) === false && ext(d('C', 3, 'USB')) === false);
    T.check('a drive Windows said nothing about is NOT external', ext(undefined) === false);
    T.check('control: the same USB bus on a system on D: is respected', ext(d('D', 3, 'USB'), 'D') === false);

    const many = parse('[{"letter":"C","driveType":3,"bus":"NVMe"},{"letter":"e","driveType":2,"bus":null}]');
    T.check('a report with several drives parses', many?.length === 2 && many[1].letter === 'E' && many[1].driveType === 2);
    const one = parse('{"letter":"D","driveType":3,"bus":"USB"}');
    T.check('a report with one drive (an object, not an array) parses', one?.length === 1 && one[0].bus === 'USB');
    T.check('garbage and empty output parse to null, not a crash', parse('not json') === null && parse('') === null);
    T.check('rows with no usable letter are dropped', parse('[{"letter":"","driveType":2},{"driveType":2},{"letter":"CD"}]')?.length === 0);

    if (process.platform === 'win32') {
      const rows = m.queryWindowsDrives();
      const c = rows?.find(r => r.letter === 'C');
      T.check('on Windows: the live query answers and lists C:', !!c, JSON.stringify(rows) + ' error: ' + m.lastWindowsDriveError());
      T.check('on Windows: C: is a fixed disk and not external', c?.driveType === 3 && ext(c) === false, JSON.stringify(c));
    } else {
      console.log('  (live Windows query skipped on this platform; CI runs it)');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return T.done();
}
