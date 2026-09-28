/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Staying signed in while the program is open.
 *
 * Ro, 2026-09-16: *"if i leave the program open, say overnight, eventually it
 * times out, and closes."* A session lasted twelve hours from sign-in, fixed,
 * however much it was used. Ro chose "stay signed in while it's open", and these
 * are the rules that decision makes, in the order a morning meets them:
 *
 *   - using the program keeps you signed in — any signed-in request, and the
 *     check-in the open screen sends on its own;
 *   - that survives the HP restarting in the night;
 *   - the browser is told as well, or it deletes the cookie at the old time;
 *   - a session nobody held open still lapses, and is not brought back;
 *   - signing out still signs out.
 *
 * Nobody can wait twelve hours in a test, so time is moved the way the existing
 * expiry test moves it: stop the server, age the session on disk, start again.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer, makeClient, reporter, activateAdmin, sleep } from './harness.mjs';

export const title = 'Staying signed in while the program is open';

const HOUR = 60 * 60 * 1000;
const TTL_SECONDS = 12 * 60 * 60;

export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-stay-'));
  const dbPath = path.join(dataDir, 'db.json');
  let srv = await startServer({ port, adminPassword: 'StayTest-1234!', projectRoot, dataDir });

  const readSession = token => JSON.parse(fs.readFileSync(dbPath, 'utf8')).sessions.find(s => s.token === token);

  /** Stop the server, set this session's expiry on disk, start it again. */
  async function ageOnDisk(token, expiresAt) {
    await srv.stop();
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const s = db.sessions.find(x => x.token === token);
    if (s) s.expiresAt = expiresAt;
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
  }

  /** The renewal is saved after the response goes out; give it a moment to land. */
  async function waitForDisk(token, predicate) {
    for (let i = 0; i < 40; i++) {
      const s = readSession(token);
      if (s && predicate(s)) return s;
      await sleep(50);
    }
    return readSession(token);
  }

  const maxAge = setCookie => Number((String(setCookie || '').match(/Max-Age=(\d+)/) || [])[1]);

  try {
    const admin = makeClient(srv.baseUrl);
    await activateAdmin(admin, 'StayTest-1234!', 'StayAdmin-9876!');
    await admin.post('/api/users', { name: 'Desk Officer', username: 'desk', role: 'JUNIOR_OFFICER', password: 'DeskPass-1111!' });
    const deskFirst = makeClient(srv.baseUrl);
    await deskFirst.post('/api/auth/login', { username: 'desk', password: 'DeskPass-1111!' }, { captureCookie: true });
    await deskFirst.post('/api/auth/change-password', { currentPassword: 'DeskPass-1111!', newPassword: 'DeskOwn-2222!' });

    const signIn = async () => {
      const c = makeClient(srv.baseUrl);
      await c.post('/api/auth/login', { username: 'desk', password: 'DeskOwn-2222!' }, { captureCookie: true });
      return { client: c, token: c.getCookie().split('=')[1] };
    };

    /* ------------------------------------------------------------ *
     * The screen left open overnight
     * ------------------------------------------------------------ */

    {
      const { client, token } = await signIn();
      T.check('a session was issued and saved', !!token && !!readSession(token));

      // Signed in eleven and a half hours ago: under the old rule, half an hour left.
      const oldExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await ageOnDisk(token, oldExpiry);

      const checkIn = await client.get('/api/auth/me');
      T.check('the open screen checking in is still signed in', checkIn.status === 200, `status ${checkIn.status}`);
      T.check(
        'and the browser is handed a fresh twelve hours, or it would delete the cookie at the old time',
        maxAge(checkIn.setCookie) === TTL_SECONDS && String(checkIn.setCookie).includes(token),
        String(checkIn.setCookie)
      );

      const saved = await waitForDisk(token, s => s.expiresAt !== oldExpiry);
      T.check(
        'the renewal reaches db.json',
        new Date(saved.expiresAt).getTime() > Date.now() + 11 * HOUR,
        `on disk: ${saved.expiresAt}`
      );

      // The HP restarts in the night — a Windows update. The renewal must survive it.
      await srv.stop();
      srv = await startServer({ port, adminPassword: 'unused', projectRoot, dataDir });
      const morning = await client.get('/api/db');
      T.check(
        'so the screen is still signed in after the server restarts overnight',
        morning.status === 200,
        `status ${morning.status}`
      );
      T.check(
        'well past the moment the old rule would have signed it out',
        new Date(readSession(token).expiresAt).getTime() > new Date(oldExpiry).getTime() + 11 * HOUR
      );

      /* ------------ signing out still signs out ------------ */
      await client.post('/api/auth/logout');
      T.check('signing out still ends a renewed session', (await client.get('/api/db')).status === 401);
      T.check('and leaves nothing on disk to renew', !readSession(token));
    }

    /* ------------------------------------------------------------ *
     * Using the program is what counts, not only the check-in
     * ------------------------------------------------------------ */

    {
      const { client, token } = await signIn();
      const oldExpiry = new Date(Date.now() + 2 * HOUR).toISOString();
      await ageOnDisk(token, oldExpiry);

      const work = await client.get('/api/db');
      T.check('ordinary work renews the session too', work.status === 200 && maxAge(work.setCookie) === TTL_SECONDS, String(work.setCookie));
      const saved = await waitForDisk(token, s => s.expiresAt !== oldExpiry);
      T.check('and that renewal is saved as well', new Date(saved.expiresAt).getTime() > Date.now() + 11 * HOUR, saved.expiresAt);
    }

    /* ------------------------------------------------------------ *
     * Not a disk write for every click
     * ------------------------------------------------------------ */

    {
      const { client, token } = await signIn();
      const issued = readSession(token).expiresAt;
      const again = await client.get('/api/db');
      T.check('a session renewed minutes ago is not renewed again', again.status === 200 && !again.setCookie, String(again.setCookie));
      await sleep(200);
      T.check('and nothing is rewritten on disk for it', readSession(token).expiresAt === issued);
    }

    /* ------------------------------------------------------------ *
     * A session nothing held open still ends
     * ------------------------------------------------------------ */

    {
      const { client, token } = await signIn();
      // The window was closed, or the machine switched off, for longer than twelve hours.
      await ageOnDisk(token, new Date(Date.now() - 60_000).toISOString());
      const late = await client.get('/api/auth/me');
      T.check('a session left with nothing holding it open for twelve hours is refused', late.status === 401, `status ${late.status}`);
      T.check('and the answer does not quietly hand it a new cookie', !String(late.setCookie || '').includes(token), String(late.setCookie));
      T.check('nor can any later request bring it back', (await client.get('/api/db')).status === 401);
    }

    /* ------------------------------------------------------------ *
     * The open screen checks in often enough
     * ------------------------------------------------------------
     *
     * The heartbeat is a React effect, which the server renderer does not run, so
     * this one is read from the source. What it guards is the relationship: a
     * check-in interval edited upward past the lifetime would make every rule
     * above true and the screen signed out anyway.
     */
    {
      const app = fs.readFileSync(path.join(projectRoot, 'src', 'App.tsx'), 'utf8');
      const beat = app.match(/const SESSION_HEARTBEAT_MS = ([\d\s*_]+);/);
      const beatMs = beat ? Function(`return (${beat[1].replace(/_/g, '')})`)() : NaN;
      T.check('the open screen checks in by itself', !!beat && /api\.get\('\/api\/auth\/me'/.test(app));
      T.check(
        'at least every hour, far inside the twelve-hour lifetime',
        beatMs > 0 && beatMs <= HOUR,
        `every ${beatMs / 60000} minutes`
      );
      T.check('and again the moment the window is looked at after sleeping', /visibilitychange/.test(app));
    }

    return T.done();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
