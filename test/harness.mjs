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

/** Start a server child on its own temp data dir and wait until it answers. */
export async function startServer({ port, adminPassword, projectRoot }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-test-'));
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
      VDS_FORCE_SECURE_COOKIE: ''
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
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (!up) {
    await stop();
    throw new Error(`server did not come up on ${baseUrl}. Log:\n${log}`);
  }

  return { baseUrl, dataDir, stop, getLog: () => log };
}

/** An HTTP client with a cookie jar. Options are always forwarded (a real one bit us before). */
export function makeClient(baseUrl) {
  let cookie = '';
  async function call(method, apiPath, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
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
    return { status: res.status, body: json, setCookie, text };
  }
  return {
    call,
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, b, o) => call('DELETE', p, b, o),
    setCookie: c => (cookie = c),
    getCookie: () => cookie
  };
}

/** Sign in as the seeded admin and clear its forced password change. Leaves the client signed in. */
export async function activateAdmin(client, oldPassword, newPassword) {
  await client.post('/api/auth/login', { username: 'admin', password: oldPassword }, { captureCookie: true });
  await client.post('/api/auth/change-password', { currentPassword: oldPassword, newPassword });
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
