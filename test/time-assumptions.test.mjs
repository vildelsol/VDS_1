/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A canary for the year this suite is written against.
 *
 * Twenty-two of the test files pin their dates to 2026 — charges posted for
 * 2026-03, a year end of 2026-12-31, ageing measured from a fixed day. The
 * application, meanwhile, ages debt against the real clock: `daysSince` and
 * `today()` do not care what year the fixtures chose.
 *
 * While the real year is the pinned year those two agree, and the suite means
 * what it says. Once the calendar moves on they quietly stop agreeing. A charge
 * the fixtures intended as "thirty days late" becomes four hundred days late,
 * and a test asserting it lands in the 30-day bucket either fails for a reason
 * that has nothing to do with the code, or — worse — still passes while
 * measuring something nobody intended.
 *
 * Most files are immune because they pass an explicit `asOf`, which is the
 * pattern to copy. This check exists for the ones that do not: rather than let
 * the suite drift into meaning something different, it fails once, loudly, with
 * instructions.
 *
 * If you are reading this because it failed: nothing is broken in the
 * application. Move the fixtures forward a year, or give the time-sensitive
 * assertions an explicit `asOf`, then update PINNED_YEAR.
 */

import fs from 'node:fs';
import path from 'node:path';
import { reporter } from './harness.mjs';

export const title = 'Time assumptions';

/** The year the fixtures across this suite are written against. */
const PINNED_YEAR = 2026;

export default async function run({ projectRoot }) {
  const T = reporter(title);
  const currentYear = new Date().getFullYear();

  T.check(
    `the suite's fixtures (${PINNED_YEAR}) still match the calendar (${currentYear})`,
    currentYear === PINNED_YEAR,
    `The fixtures are pinned to ${PINNED_YEAR} but it is now ${currentYear}. ` +
      `Ageing is measured from the real clock, so relative-date assertions no longer mean what they say. ` +
      `Move the fixtures forward or pass an explicit asOf, then set PINNED_YEAR to ${currentYear} in test/time-assumptions.test.mjs.`
  );

  /*
   * How much of the suite the canary is speaking for. Reported, not asserted.
   *
   * An earlier version of this file tried to name the individual files that
   * trust the clock, by grepping for ageing terms without a nearby `asOf`. It
   * could not be made honest: `oldestUnpaidDays` reads the same to a regex
   * whether it appears in code or in the sentence "so it reads as overdue",
   * and every candidate it flagged turned out to be prose in a comment or a
   * check label. A canary that names innocent files is one people learn to
   * ignore, so it names none — it reports the exposure and leaves the judgement
   * to whoever it wakes.
   */
  const dir = path.join(projectRoot, 'test');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs') && f !== 'time-assumptions.test.mjs');
  const pinned = files.filter(f => new RegExp(String(PINNED_YEAR)).test(fs.readFileSync(path.join(dir, f), 'utf8')));

  T.check(
    `${pinned.length} of ${files.length} test files are dated against ${PINNED_YEAR}`,
    true,
    'reported so the scale of a year rollover is visible before it happens'
  );

  return T.done();
}
