/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Recovering a lost administrator password.
 *
 * The normal "reset password" screen requires being signed in as someone with
 * permission to manage staff — no help if the only administrator is the one
 * locked out. This is the local, file-based recovery path: a marker file
 * dropped into the data folder, read only at server start-up, never reachable
 * over the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter } from './harness.mjs';

export const title = 'Administrator password recovery';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-recovery-'));
  const marker = path.join(dataDir, 'RESET-ADMIN-PASSWORD.txt');

  try {
    // --- establish a real account with a real (now "forgotten") password ---
    let srv = await startServer({ port, adminPassword: 'OriginalPass-1!', projectRoot, dataDir });
    let c = makeClient(srv.baseUrl);
    await c.post('/api/auth/login', { username: 'admin', password: 'OriginalPass-1!' }, { captureCookie: true });
    await c.post('/api/auth/change-password', { currentPassword: 'OriginalPass-1!', newPassword: 'ForgottenPass-9!' });
    // A live session exists at the moment the password is "lost".
    const staleSessionCookie = c.getCookie();
    await srv.stop();

    // --- no marker file: a restart must not touch the account at all ---
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    c = makeClient(srv.baseUrl);
    T.check(
      'without a marker file, the old password still works after a restart',
      (await c.post('/api/auth/login', { username: 'admin', password: 'ForgottenPass-9!' })).status === 200
    );
    await srv.stop();

    // --- drop the marker file (simulating someone with file access to the machine) ---
    fs.writeFileSync(marker, '');
    let logSeenPassword = null;
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    const consoleLog = srv.getLog();
    const match = /password:\s*(\S+)/.exec(consoleLog);
    logSeenPassword = match ? match[1] : null;

    T.check('the marker file is consumed (deleted) on start-up', !fs.existsSync(marker));
    T.check('a new password was printed to the console', !!logSeenPassword, consoleLog.slice(0, 400));

    c = makeClient(srv.baseUrl);
    T.check('the forgotten password no longer works', (await c.post('/api/auth/login', { username: 'admin', password: 'ForgottenPass-9!' })).status === 401);

    const relogin = await c.post('/api/auth/login', { username: 'admin', password: logSeenPassword }, { captureCookie: true });
    T.check('the printed reset password signs in', relogin.status === 200, `status ${relogin.status}`);
    T.check('it is flagged to be changed immediately, exactly like a fresh account', relogin.body?.user?.mustChangePassword === true);

    // --- a session that existed before the reset must not survive it ---
    const replay = makeClient(srv.baseUrl);
    replay.setCookie(staleSessionCookie);
    T.check('a session from before the reset is invalidated', (await replay.get('/api/db')).status === 401);

    // --- the reset is a permanent, visible record, not a silent backdoor ---
    await c.post('/api/auth/change-password', { currentPassword: logSeenPassword, newPassword: 'BrandNewPass-7!' });
    const db = (await c.get('/api/db')).body;
    T.check(
      'the reset is recorded in the audit trail',
      db.auditLogs.some(a => /password reset/i.test(a.action) && a.user === 'System'),
      db.auditLogs.slice(-3).map(a => a.action).join(' | ')
    );
    await srv.stop();

    // --- resetting a non-existent / non-administrator username is a safe no-op ---
    fs.writeFileSync(marker, 'no-such-user');
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
    T.check('an unmatched username in the marker is consumed without effect', !fs.existsSync(marker));
    c = makeClient(srv.baseUrl);
    T.check(
      "the real admin's password (just changed) is untouched by the failed attempt",
      (await c.post('/api/auth/login', { username: 'admin', password: 'BrandNewPass-7!' })).status === 200
    );
    await srv.stop();
  } finally {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return T.done();
}
