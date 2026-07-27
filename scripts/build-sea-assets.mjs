/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generates sea-config.json for the single-file executable build.
 *
 * Node's Single Executable Application (SEA) feature packages one script plus,
 * optionally, a map of extra "assets" it can read back with sea.getAsset() at
 * runtime — that "assets" map is how the client shell (index.html, the built
 * JS/CSS, the icons) ends up inside the .exe itself, rather than needing a
 * dist/ folder shipped alongside it (see server.ts, serveEmbeddedAssets).
 *
 * Vite content-hashes the client filenames on every build (index-XXXXXX.js), so
 * this walks the actual dist/ output fresh each run rather than a hand-written
 * list that would silently go stale.
 *
 * Run after `npm run build` (client + the ordinary server.cjs) and
 * `npm run build:exe-bundle` (the fully self-contained server bundle this
 * config points at as `main`). See package.json's build:exe-prep.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

// Everything in dist/ that is not part of the browser-servable client shell.
// Source maps are excluded too — they are large and of no use to an end user's
// double-clicked copy of the program.
const EXCLUDE_FILES = new Set(['server.cjs', 'server.cjs.map', 'server-bundle.cjs', 'server-bundle.cjs.map']);

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
      continue;
    }
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (EXCLUDE_FILES.has(rel) || rel.endsWith('.map')) continue;
    out[rel] = full;
  }
  return out;
}

const indexHtml = path.join(DIST, 'index.html');
const serverBundle = path.join(DIST, 'server-bundle.cjs');

if (!fs.existsSync(indexHtml)) {
  console.error('dist/index.html not found. Run "npm run build" first.');
  process.exit(1);
}
if (!fs.existsSync(serverBundle)) {
  console.error('dist/server-bundle.cjs not found. Run "npm run build:exe-bundle" first.');
  process.exit(1);
}

const assets = walk(DIST, DIST, {});
const assetCount = Object.keys(assets).length;
if (assetCount === 0) {
  console.error('No client assets found under dist/ — refusing to write an empty sea-config.json.');
  process.exit(1);
}

const config = {
  main: 'dist/server-bundle.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries(Object.entries(assets).map(([key, full]) => [key, path.relative(ROOT, full)]))
};

fs.writeFileSync(path.join(ROOT, 'sea-config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`sea-config.json written with ${assetCount} embedded client asset(s).`);
