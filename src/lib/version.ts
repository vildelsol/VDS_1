/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which version is on screen, and which version is actually running.
 *
 * These are two different things, and until v1.10.1 the application only ever
 * showed the first while calling it the second. The number in the sidebar is
 * compiled into the browser bundle; the bundle is delivered by a service worker,
 * so after an upgrade a browser can keep serving the previous release's page for
 * as long as it likes. On the v1.10.0 upgrade that produced the worst possible
 * outcome: a correct release, correctly installed, and every visible check on the
 * machine still reporting the old version — with no way to tell that apart from
 * an upgrade that had genuinely failed.
 *
 * The comparison lives here, away from React, so it can be asserted directly.
 */

/**
 * True only when both versions are known and they differ.
 *
 * `null` — the server was not reachable, or is old enough not to report a version
 * — must never raise the alarm. A warning that fires when nothing is known is a
 * warning people learn to dismiss, and it would then be dismissed on the day it
 * was right.
 */
export function versionMismatch(client: string, server: string | null): boolean {
  if (!server) return false;
  return server.trim() !== client.trim();
}
