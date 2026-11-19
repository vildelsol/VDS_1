/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Veto power: who can see it, who can give it, who can take it away.
 *
 * Veto power carries settings authority, including the permission matrix itself,
 * so whoever holds it can hand out every other permission. Before 2026-11-18 the
 * server refused only a Manager giving it to the Junior Officer: a Manager could
 * still make the Finance Officer a second settings manager, or strip a veto an
 * Administrator had given. And System Settings had no row for it at all, so it
 * could be neither seen nor changed on screen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reporter } from './harness.mjs';
import { boot } from './security-kit.mjs';

export const title = 'Veto power is shown in System Settings and given only by an Administrator';

const errorOf = r => r.body?.error || r.body?.message || '';

export default async function run({ port, projectRoot }) {
  const T = reporter(title);

  /* ---- the screen ---- */
  const src = fs.readFileSync(path.join(projectRoot, 'src/components/SystemSettings.tsx'), 'utf8');
  const row = src.slice(src.indexOf('Veto power: change System Settings'));
  T.check('System Settings has a veto power row', src.includes('Veto power: change System Settings'));
  T.check('the row toggles hasVetoPower', /toggle\(role, 'hasVetoPower'\)/.test(row));
  T.check('the row is locked for anyone but an Administrator', /onChange=\{\(\) => toggle\(role, 'hasVetoPower'\)\}\s*disabled=\{!isAdmin\}/.test(row));

  /* ---- the server ---- */
  const env = await boot(port, projectRoot);
  try {
    const perms = async () => (await env.admin.get('/api/db')).body.settings.rolePermissions;
    const base = await perms();
    const finance = veto => ({ rolePermissions: { FINANCE_OFFICER: { ...base.FINANCE_OFFICER, hasVetoPower: veto } } });

    const give = await env.manager.post('/api/settings', finance(true));
    T.check(
      'a Manager cannot give the Finance Officer veto power',
      give.status === 403 && /Only an administrator can give the Finance Officer veto power/.test(errorOf(give)),
      `${give.status} ${errorOf(give)}`
    );
    T.check('and the Finance Officer is left without it', !(await perms()).FINANCE_OFFICER.hasVetoPower);

    const adminGive = await env.admin.post('/api/settings', finance(true));
    T.check('an Administrator can give it (positive control)', adminGive.status === 200 && (await perms()).FINANCE_OFFICER.hasVetoPower === true, `${adminGive.status}`);

    const take = await env.manager.post('/api/settings', finance(false));
    T.check(
      'a Manager cannot withdraw the veto an Administrator gave',
      take.status === 403 && /Only an administrator can withdraw veto power from the Finance Officer/.test(errorOf(take)),
      `${take.status} ${errorOf(take)}`
    );
    T.check('and the Finance Officer keeps it', (await perms()).FINANCE_OFFICER.hasVetoPower === true);

    // A Manager's ordinary save, carrying the veto unchanged, still goes through.
    const ordinary = await env.manager.post('/api/settings', {
      rolePermissions: { FINANCE_OFFICER: { ...base.FINANCE_OFFICER, hasVetoPower: true, viewShortfall: !base.FINANCE_OFFICER.viewShortfall } }
    });
    T.check('a Manager saving other permissions with the veto unchanged is not refused', ordinary.status === 200, `${ordinary.status} ${errorOf(ordinary)}`);

    const juniorTake = await env.manager.post('/api/settings', { rolePermissions: { JUNIOR_OFFICER: { ...base.JUNIOR_OFFICER, hasVetoPower: false } } });
    T.check('a Manager saving the junior desk without veto (it has none) is not refused', juniorTake.status === 200, `${juniorTake.status} ${errorOf(juniorTake)}`);

    const adminTake = await env.admin.post('/api/settings', finance(false));
    T.check('an Administrator can withdraw it (positive control)', adminTake.status === 200 && !(await perms()).FINANCE_OFFICER.hasVetoPower, `${adminTake.status}`);
  } finally {
    await env.stop();
  }
  return T.done();
}
