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
    // Flipped in the second security pass: the per-address cap (30 failed attempts per 15 minutes from devices the server has never seen) now answers the rest with 429 without running scrypt.
    T.check('the flood is rate-limited per IP once the address passes its cap (429), the first attempts are still answered 401', statuses.includes(429) && statuses.includes(401) && statuses.filter(s => s === 401).length <= 31, [...new Set(statuses)].join(',') + ` (${statuses.filter(s => s === 401).length} reached password verification)`);
  } finally { await srv.stop(); }
  return T.done();
}
