/** Shared set-up for the security-*.test.mjs modules (not a test itself). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, makeClient, activateAdmin, makeLongTermUnit, confirmPayment } from './harness.mjs';

export const ADMIN_PW = 'SecAdmin-9876!';
export const ROLE_PW = {
  MANAGER: 'SecManager-22!x',
  FINANCE_OFFICER: 'SecFinance-22!x',
  JUNIOR_OFFICER: 'SecJunior-22!x'
};

export async function signedIn(baseUrl, username, issued, chosen) {
  const c = makeClient(baseUrl);
  await c.post('/api/auth/login', { username, password: issued }, { captureCookie: true });
  await c.post('/api/auth/change-password', { currentPassword: issued, newPassword: chosen });
  return c;
}

/** Boot a server and return an admin plus one signed-in client per role. */
export async function boot(port, projectRoot, { env, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vds-sec-'));
  const srv = await startServer({ port, adminPassword: 'SecBoot-1234!', projectRoot, dataDir: dir, env });
  const admin = makeClient(srv.baseUrl);
  await activateAdmin(admin, 'SecBoot-1234!', ADMIN_PW);
  const clients = { admin };
  for (const [role, name] of [['MANAGER', 'manager'], ['FINANCE_OFFICER', 'finance'], ['JUNIOR_OFFICER', 'junior']]) {
    await admin.post('/api/users', { name: `Sec ${name}`, username: name, role, password: 'Issued-1111!aa' });
    clients[name] = await signedIn(srv.baseUrl, name, 'Issued-1111!aa', ROLE_PW[role]);
  }
  const users = (await admin.get('/api/db')).body.users;
  return { srv, dir, ...clients, users, stop: async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** A billable long-term villa with a posted month, so money routes have something to act on. */
export async function seedLedger(admin, over = {}) {
  await makeLongTermUnit(admin, 'unit-1', over);
  await admin.post('/api/charges/post-month', { monthString: new Date().toISOString().slice(0, 7) });
  return (await admin.get('/api/db')).body;
}
export { makeClient, confirmPayment, makeLongTermUnit };
