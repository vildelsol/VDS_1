/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The reporting period, remembered across screens.
 *
 * Charts and Operational Reports each used to hold their own range with their own
 * default, so assembling one set of documents for one period meant picking the
 * same dates twice — and nothing stopped the two being picked slightly
 * differently, which is how a pack goes out with a chart covering a different
 * period from the statement beside it.
 *
 * Deliberately *not* shared with Financial Projections. That screen's window is a
 * historical basis for averaging a run-rate and ends at last month on purpose:
 * feeding it a reporting range that includes the current part-finished month
 * would drag every average down. Same-looking control, different meaning.
 *
 * Held in a module rather than persisted: the range is a working choice for the
 * session, not a setting, and it should not outlive the browser tab.
 */

export interface ReportRange {
  from: string;
  to: string;
  /**
   * The named preset that produced this range, when one did. Screens whose preset
   * vocabulary lacks the name fall back to a custom range over the same dates,
   * which is the same period either way.
   */
  preset?: string;
}

let current: ReportRange | null = null;

/** The range last chosen on any screen, or null before anything has chosen one. */
export function getReportRange(): ReportRange | null {
  return current;
}

/** Publish the range this screen is showing, for the next screen to adopt. */
export function setReportRange(range: ReportRange): void {
  current = range;
}

/** Testing seam: forget the shared range. */
export function clearReportRange(): void {
  current = null;
}
