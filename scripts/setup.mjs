/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guided first-time setup.
 *
 *   npm run setup
 *
 * Asks where to keep the records, where to put backups, and what the first
 * administrator password should be, then writes a .env file that `npm run dev`
 * and `npm start` read. Everything it asks has a sensible default in [brackets] —
 * press Enter to accept it. Nothing here is destructive: it never overwrites an
 * existing database and it shows the final settings before writing.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Queue lines as they arrive so the prompt flow works identically whether the
// answers are typed at a terminal or piped in (which is how the setup is tested).
const pending = [];
const waiters = [];
let closed = false;
rl.on('line', line => {
  if (waiters.length) waiters.shift()(line);
  else pending.push(line);
});
rl.on('close', () => {
  closed = true;
  while (waiters.length) waiters.shift()(null);
});

function nextLine() {
  if (pending.length) return Promise.resolve(pending.shift());
  if (closed) return Promise.resolve(null);
  return new Promise(resolve => waiters.push(resolve));
}

async function ask(question, fallback) {
  process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
  const line = await nextLine();
  const value = (line ?? '').trim();
  return value || fallback || '';
}

function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function strongPassword() {
  // 3 words-ish + digits + symbol, easy to read once and change on first login.
  const part = () => crypto.randomBytes(3).toString('hex');
  return `Vds-${part()}-${part()}!`;
}

async function main() {
  console.log('\n' + '='.repeat(66));
  console.log('  Villaggio Del Sol — first-time setup');
  console.log('='.repeat(66));

  if (fs.existsSync(ENV_FILE)) {
    const overwrite = (await ask('\nA .env already exists. Overwrite it? (y/N)', 'N')).toLowerCase();
    if (overwrite !== 'y') {
      console.log('Left the existing .env untouched. Nothing changed.');
      rl.close();
      return;
    }
  }

  console.log('\nPress Enter to accept the default shown in [brackets].\n');

  // 1. Where the records live.
  const dataDir = expand(await ask('Folder to store the records (db.json)', ROOT));
  fs.mkdirSync(dataDir, { recursive: true });

  const dbFile = path.join(dataDir, 'db.json');
  if (fs.existsSync(dbFile)) {
    console.log(`  → An existing database was found here and will be kept and used: ${dbFile}`);
  } else {
    console.log(`  → A fresh database will be created here on first launch: ${dbFile}`);
  }

  // 2. Off-machine backup.
  console.log('\nBackups are written daily. A second copy on a synced folder or external');
  console.log('drive means a disk failure or lost laptop does not take the records with it.');
  const defaultBackup = path.join(os.homedir(), 'VDS-Backups');
  const wantBackup = (await ask('Set up a second, off-machine backup folder? (Y/n)', 'Y')).toLowerCase();
  let backupDir = '';
  if (wantBackup !== 'n') {
    backupDir = expand(await ask('  Off-machine backup folder', defaultBackup));
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`  → A daily copy will also be written to: ${backupDir}`);
  } else {
    console.log('  → Skipped. Backups will only be kept on this machine (db-backups/).');
    console.log('    You can add one later by setting VDS_BACKUP_DIR, or from System Settings.');
  }

  // 3. First administrator password.
  console.log('\nThe first administrator account (username: admin) needs a password.');
  console.log('You will be forced to change it at first sign-in.');
  const suggested = strongPassword();
  let adminPassword = await ask('  Administrator password', suggested);
  if (adminPassword.length < 10) {
    console.log('  (Too short — using a generated strong password instead.)');
    adminPassword = suggested;
  }

  // 4. Port.
  const port = await ask('\nPort to run on', '3000');

  // Confirm.
  console.log('\n' + '-'.repeat(66));
  console.log('  About to write these settings to .env:');
  console.log(`    Records folder   : ${dataDir}`);
  console.log(`    Off-machine copy : ${backupDir || '(none)'}`);
  console.log(`    Admin password   : ${adminPassword}`);
  console.log(`    Port             : ${port}`);
  console.log('-'.repeat(66));
  const go = (await ask('Write this and finish? (Y/n)', 'Y')).toLowerCase();
  if (go === 'n') {
    console.log('Aborted. Nothing was written.');
    rl.close();
    return;
  }

  const lines = [
    '# Villaggio Del Sol configuration — written by `npm run setup`.',
    '# This file contains the initial admin password; keep it private and do not commit it.',
    '',
    `VDS_DATA_DIR=${dataDir}`,
    ...(backupDir ? [`VDS_BACKUP_DIR=${backupDir}`] : []),
    `VDS_ADMIN_PASSWORD=${adminPassword}`,
    `PORT=${port}`,
    ''
  ];
  fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8');

  console.log('\n✓ Setup complete. .env written.\n');
  console.log('  Start the application with:');
  console.log('      npm run dev        (for everyday use on this machine)');
  console.log('  or  npm run build && npm start   (for a permanent install)');
  console.log('');
  console.log('  Then open http://localhost:' + port + ' and sign in as:');
  console.log('      username: admin');
  console.log('      password: ' + adminPassword);
  console.log('  You will be asked to set a new password immediately.\n');
  console.log('  Once in, create a personal account for each staff member under');
  console.log('  System Settings → Staff accounts, and stop sharing the admin login.\n');

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  rl.close();
  process.exit(1);
});
