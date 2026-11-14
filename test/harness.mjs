/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-platform test harness.
 *
 * Each test file boots its own server on a fresh temporary data directory, so the
 * tests are isolated from each other and from the real db.json. Everything here is
 * plain Node with no shell, so the same suite runs on macOS and Windows.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Start a server child and wait until it answers.
 *
 * Reuses a caller-supplied `dataDir` when given — for a test that needs to stop
 * the server, change something on disk (a marker file, say), and start it again
 * against the same data — and creates a fresh temp one otherwise. Cleanup of a
 * caller-supplied dataDir is the caller's responsibility, since the harness did
 * not create it and does not know when the caller is really done with it.
 */
export async function startServer({ port, adminPassword, projectRoot, dataDir: reuseDataDir, env: extraEnv }) {
  const ownsDataDir = !reuseDataDir;
  const dataDir = reuseDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
  const child = spawn(process.execPath, ['dist/server.cjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      VDS_DATA_DIR: dataDir,
      VDS_ADMIN_PASSWORD: adminPassword,
      VDS_BACKUP_DIR: '',
      VDS_TRUST_PROXY: '',
      VDS_FORCE_SECURE_COOKIE: '',
      VDS_DRIVE_ROOTS: '',
      // Never let a test server look at the real machine's drives: a CI runner's D:
      // or a plugged-in stick would be adopted as the backup folder by the drive watcher.
      VDS_DRIVE_ROOTS_ONLY: '1',
      ...(extraEnv || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  let up = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl + '/api/health');
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }

  async function stop() {
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.on('exit', () => resolve());
      child.kill();
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);
    });
    if (ownsDataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  if (!up) {
    await stop();
    throw new Error(`server did not come up on ${baseUrl}. Log:\n${log}`);
  }

  return { baseUrl, dataDir, stop, getLog: () => log };
}

/** An HTTP client with a cookie jar. Options are always forwarded (a real one bit us before). */
export function makeClient(baseUrl, { autoConfirmDuplicates = true } = {}) {
  let cookie = '';
  /**
   * Every 404 this client received, in order.
   *
   * A simulation calls endpoints and ignores most responses, because plenty of
   * its actions are *meant* to be refused — money in the wrong currency, a
   * mistyped figure, a clashing stay. Those come back 400, 403 or 409. A 404
   * means something else entirely: the route does not exist, so the call did
   * nothing and the scenario containing it proved nothing while still counting
   * as a scenario that ran.
   *
   * Three scenarios were found doing exactly that. Recorded here so a suite can
   * assert on it; tests that deliberately probe a missing record (asking for a
   * payment that was never made) simply do not make that assertion.
   */
  const notFound = [];

  async function call(method, apiPath, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    /*
     * The server refuses the same payment entered twice within minutes unless the
     * cashier confirms it is separate money. A simulation posts identical receipts
     * seconds apart on purpose (fixed dates, fixed amounts), which is exactly what
     * that guard exists to stop, so the client confirms by default. The guard has
     * its own suite (ecosystem-guards), which turns this off.
     */
    if (autoConfirmDuplicates && method === 'POST' && apiPath === '/api/payments' && body && typeof body === 'object' && body.confirmDuplicate === undefined) {
      body = { ...body, confirmDuplicate: true };
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie && !opts.noCookie) headers.Cookie = cookie;
    const res = await fetch(baseUrl + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && opts.captureCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (res.status === 404) notFound.push(`${method} ${apiPath}`);
    return { status: res.status, body: json, setCookie, text };
  }
  return {
    call,
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, b, o) => call('DELETE', p, b, o),
    setCookie: c => (cookie = c),
    getCookie: () => cookie,
    /** Every 404 seen so far, for suites that assert none should happen. */
    notFound: () => [...notFound],
    clearNotFound: () => (notFound.length = 0)
  };
}

/** Sign in as the seeded admin and clear its forced password change. Leaves the client signed in. */
export async function activateAdmin(client, oldPassword, newPassword) {
  await client.post('/api/auth/login', { username: 'admin', password: oldPassword }, { captureCookie: true });
  await client.post('/api/auth/change-password', { currentPassword: oldPassword, newPassword });
}

/**
 * Record a payment and confirm it as received, returning the confirmed payment.
 *
 * Recording alone only logs an *expected* receipt: it carries no receipt number
 * and counts for nothing until someone confirms the money actually arrived. Tests
 * about money that has genuinely been received have to do both steps, exactly as
 * a person does.
 */
export async function recordAndConfirmPayment(client, payload) {
  const created = await client.post('/api/payments', payload);
  const id = created.body?.payment?.id;
  if (!id) return created;
  return client.post(`/api/payments/${id}/confirm`, {});
}

/** Confirm an already-logged payment by id. */
export function confirmPayment(client, id, body = {}) {
  return client.post(`/api/payments/${id}/confirm`, body);
}

/** Configure unit-1 as a long-term let with a tenant, so it is billable. */
export async function makeLongTermUnit(client, id = 'unit-1', over = {}) {
  return client.put(`/api/units/${id}`, {
    number: id.replace('unit-', ''),
    ownerName: 'Owner',
    tenantName: 'Tenant',
    status: 'long-term',
    monthlyRent: 50000,
    monthlyMaintenance: 10000,
    currency: 'JMD',
    maintCurrency: 'JMD',
    rentDueDay: 1,
    maintDueDay: 1,
    ...over
  });
}

/**
 * Today, the way the application means it: local time.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, and the server works in
 * local time (`toDayString` in src/lib/dates.ts). Those are the same string for
 * most of the day and different for the last few hours of it — five in Jamaica,
 * four on daylight time. A test that dates a receipt with the UTC day is
 * therefore dating it *tomorrow* every evening after about eight o'clock, and the
 * application correctly refuses it: "a payment cannot be dated in the future."
 *
 * That is what broke the property-manager suite on the evening of 2026-09-01,
 * having passed on the CI runner an hour earlier — because CI runs in UTC, where
 * the two never differ. The same shape as the hardcoded '2026-08' that failed on
 * the first of September: a test that agrees with the application only some of
 * the time. **Never build a "now" date in a test from toISOString().**
 */
export function localToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function reporter(title) {
  const failures = [];
  let pass = 0;
  return {
    check(desc, ok, detail) {
      if (ok) {
        pass++;
        console.log(`  ok   ${desc}`);
      } else {
        failures.push(`${desc}${detail ? ` — ${detail}` : ''}`);
        console.log(`  FAIL ${desc}${detail ? ` — ${detail}` : ''}`);
      }
    },
    done() {
      return { name: title, pass, fail: failures.length, failures };
    }
  };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
