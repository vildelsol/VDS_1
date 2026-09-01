/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Can this machine tell you what it is running?
 *
 * On 1 September 2026 v1.10.0 was built from the right commit, published, and
 * installed on the office PC — and every way of checking still said v1.9.0. The
 * release was never at fault. The number on screen comes from the *browser
 * bundle*, which a service worker may serve from cache for as long as it likes,
 * and nothing the server printed or answered stated its own version. So "the
 * upgrade did not happen" and "the upgrade happened and this page has not caught
 * up" were indistinguishable, and the handover's own instruction — confirm the
 * sidebar reads v1.10.0 — was advice that could lie.
 *
 * This file exists so that cannot recur. It asserts the three places the answer
 * now has to be available: the health endpoint, the value it reports, and the
 * warning the screen raises when the page and the program disagree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startServer, makeClient, reporter } from './harness.mjs';

export const title = 'Version reporting';

/** Bundle the version rule and the banner, with the compile-time version defined. */
async function loadClient(projectRoot, clientVersion) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-version-'));
  const outfile = path.join(dir, 'version.mjs');
  await build({
    stdin: {
      contents: `
        export { renderToStaticMarkup } from 'react-dom/server';
        export { versionMismatch } from './src/lib/version';
        export { VersionMismatchBanner } from './src/components/VersionCheck';
        export { default as React } from 'react';
      `,
      resolveDir: projectRoot,
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    define: { __APP_VERSION__: JSON.stringify(clientVersion) },
    outfile,
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
    }
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, "'").replace(/\s+/g, ' ').trim();

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  /* ---------------- the server states its own version ---------------- */
  {
    const srv = await startServer({ port, adminPassword: 'Version-Pass-1234!', projectRoot });
    try {
      const c = makeClient(srv.baseUrl);

      // Unauthenticated on purpose. The moment this is most needed is a
      // half-finished upgrade, when nobody may be able to sign in to ask.
      const res = await c.get('/api/health');
      T.check('the health endpoint answers without signing in', res.status === 200, String(res.status));
      T.check(
        'and it states the version the server was built from',
        res.body.version === pkg.version,
        `reported ${JSON.stringify(res.body.version)}, package.json says ${pkg.version}`
      );
      T.check(
        'which is a real version number, not a placeholder',
        typeof res.body.version === 'string' && /^\d+\.\d+\.\d+/.test(res.body.version),
        String(res.body.version)
      );

      // The reconnect logic in src/lib/api.ts reads ok/status from this route.
      // Adding a field must not have disturbed what it already promised.
      T.check('the liveness contract the reconnect logic depends on is unchanged', res.body.ok === true);
      T.check('including the timestamp', typeof res.body.time === 'string' && !Number.isNaN(Date.parse(res.body.time)));
    } finally {
      await srv.stop();
    }
  }

  /* ---------------- the screen compares the two ---------------- */
  {
    const { mod, cleanup } = await loadClient(projectRoot, pkg.version);
    try {
      const { versionMismatch, VersionMismatchBanner, React, renderToStaticMarkup } = mod;

      T.check('matching versions are not a mismatch', versionMismatch('1.10.1', '1.10.1') === false);
      T.check('differing versions are', versionMismatch('1.10.1', '1.9.0') === true);

      // The rule that keeps the warning credible: not knowing is not a mismatch.
      T.check('an unreachable server is not reported as a mismatch', versionMismatch('1.10.1', null) === false);
      T.check(
        'nor is a server too old to report a version',
        versionMismatch('1.10.1', undefined) === false || versionMismatch('1.10.1', '') === false
      );

      const quiet = renderToStaticMarkup(React.createElement(VersionMismatchBanner, { client: '1.10.1', server: '1.10.1' }));
      T.check('nothing is shown when the page and the program agree', quiet === '', quiet);

      const unknown = renderToStaticMarkup(React.createElement(VersionMismatchBanner, { client: '1.10.1', server: null }));
      T.check('and nothing when the server has not answered', unknown === '', unknown);

      const warned = text(renderToStaticMarkup(React.createElement(VersionMismatchBanner, { client: '1.9.0', server: '1.10.1' })));
      T.check('a mismatch is shown', warned.length > 0, warned);
      T.check('naming both versions, so it can be acted on', warned.includes('1.10.1') && warned.includes('1.9.0'), warned);
      T.check('saying which one the program is', warned.includes('program on this computer is'), warned);
      T.check('and telling the reader what to do about it', /Ctrl.*Shift.*R/.test(warned), warned);
    } finally {
      cleanup();
    }
  }

  return T.done();
}
