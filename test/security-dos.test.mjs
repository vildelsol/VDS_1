/** Availability probe: unauthenticated sign-in flood with distinct usernames (each costs a synchronous scrypt). Measures, asserts a generous bound. */
import { reporter, startServer } from './harness.mjs';
export const title = 'Security: unauthenticated sign-in flood vs. responsiveness';
export const allowUnknownRoutes = true;
export default async function run({ port, projectRoot }) {
  const T = reporter(title);
  const srv = await startServer({ port, adminPassword: 'Dos-Test-1234!', projectRoot });
  try {
    const timeHealth = async () => { const t = Date.now(); await fetch(srv.baseUrl + '/api/health'); return Date.now() - t; };
    const idle = await timeHealth();
    const flood = Array.from({ length: 150 }, (_, i) => fetch(srv.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `flood-${i}`, password: 'x'.repeat(100000) }) }).then(r => r.status));
    await new Promise(r => setTimeout(r, 20));
    const during = [];
    for (let i = 0; i < 5; i++) during.push(await timeHealth());
    const statuses = await Promise.all(flood);
    console.log(`  info health latency idle ${idle} ms; during 150 concurrent logins (100 KB passwords, distinct usernames): ${during.join(', ')} ms; statuses ${[...new Set(statuses)].join(',')}`);
    T.check('server is not starved by an unauthenticated flood: /api/health answers within 1 s during 150 concurrent distinct-user sign-ins', Math.max(...during) < 1000, `worst ${Math.max(...during)} ms (idle ${idle} ms); no per-IP cap exists across distinct usernames`);
    T.check('flood was not rate-limited per IP (all attempts reached password verification)', statuses.every(s => s === 401), [...new Set(statuses)].join(','));
  } finally { await srv.stop(); }
  return T.done();
}
