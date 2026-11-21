/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HTTPS with nothing for anybody at a desk to do.
 *
 * Ro, 2026-11-21: "we connect through tailscale, if https doesnt interfere, yes add it" and "ensure the HTTPS works
 * seamlessly without a user having to do anything". So:
 *
 *   - One port serves both. The first byte of a connection says which it is (a TLS handshake starts 0x16), so the
 *     address everybody already uses keeps working; a plain-HTTP request is redirected to HTTPS once a certificate
 *     is in hand, and is served as before when there is none.
 *   - The certificate comes from Tailscale (`tailscale cert`), issued for the machine's Tailscale name
 *     (hp.tailnet.ts.net). Browsers trust it with no warning and no install on any PC. It is fetched at start-up and
 *     renewed daily, and swapped into the running server without a restart.
 *   - A certificate placed by hand in <records folder>/tls (cert.pem + key.pem) is used instead, if present.
 *   - Anything missing (Tailscale not installed or signed out, HTTPS certificates not switched on for the tailnet,
 *     the command refused) leaves the server on plain HTTP exactly as before, and says why in the console. It never
 *     stops the application starting.
 *
 * VDS_HTTPS=off switches all of it off. The test harness sets that, so a developer machine running Tailscale never
 * turns the suite's plain-HTTP servers into redirects.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** The host the certificate is for, used as the redirect target; undefined = keep the host the browser asked for. */
  host?: string;
  source: 'manual' | 'tailscale';
}

const DAY_MS = 24 * 60 * 60 * 1000;

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    );
  });
}

/** Where the Tailscale command might be. The first that answers `version` is used. */
function tailscaleCandidates(): string[] {
  const explicit = process.env.VDS_TAILSCALE_BIN;
  if (explicit) return [explicit];
  const list = ['tailscale'];
  if (process.platform === 'win32') {
    list.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
    list.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale');
  }
  return list;
}

async function findTailscale(): Promise<string | null> {
  for (const bin of tailscaleCandidates()) {
    try {
      await run(bin, ['version'], 5000);
      return bin;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** A host name a certificate can be issued for: letters, digits, hyphens and dots only. */
function safeHost(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const host = name.trim().replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253 ? host : null;
}

function readManual(dir: string): TlsMaterial | null {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), source: 'manual' };
}

/**
 * The certificate to serve, or null with the reason. Never throws.
 */
export async function obtainTls(dataDir: string, log: (msg: string) => void = () => {}): Promise<TlsMaterial | null> {
  if ((process.env.VDS_HTTPS || '').toLowerCase() === 'off') return null;
  const dir = process.env.VDS_TLS_DIR || path.join(dataDir, 'tls');
  try {
    const manual = readManual(dir);
    if (manual) return manual;
  } catch (err) {
    log(`HTTPS: the certificate in ${dir} could not be read (${(err as Error).message}); trying Tailscale.`);
  }

  const bin = await findTailscale();
  if (!bin) {
    log('HTTPS: Tailscale was not found on this computer, so the application is served over plain HTTP.');
    return null;
  }
  let host: string | null = null;
  try {
    const status = JSON.parse(await run(bin, ['status', '--json'], 10000));
    // CertDomains is listed only when HTTPS certificates are switched on for the tailnet.
    const domains: unknown[] = Array.isArray(status?.CertDomains) ? status.CertDomains : [];
    host = safeHost(domains[0]) || null;
    if (!host) {
      log(
        'HTTPS: Tailscale is running but "HTTPS certificates" is not switched on for this tailnet (Tailscale admin console → DNS). ' +
          'Serving plain HTTP until it is; nothing else needs doing.'
      );
      return null;
    }
  } catch (err) {
    log(`HTTPS: Tailscale did not answer (${(err as Error).message}); serving plain HTTP.`);
    return null;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const certFile = path.join(dir, 'tailscale.crt');
    const keyFile = path.join(dir, 'tailscale.key');
    await run(bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, host], 120000);
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), host, source: 'tailscale' };
  } catch (err) {
    log(`HTTPS: Tailscale could not issue a certificate for ${host} (${(err as Error).message}); serving plain HTTP.`);
    return null;
  }
}

/** Renew daily. `apply` receives each fresh certificate; failures keep the current one. */
export function renewTlsDaily(dataDir: string, apply: (tls: TlsMaterial) => void, log: (msg: string) => void): NodeJS.Timeout {
  const timer = setInterval(async () => {
    const fresh = await obtainTls(dataDir, log);
    if (fresh) apply(fresh);
  }, DAY_MS);
  timer.unref?.();
  return timer;
}

/** The redirect target for a plain-HTTP request once HTTPS is available, or null to serve it as plain HTTP. */
export function httpsRedirectUrl(hostHeader: string | undefined, url: string | undefined, port: number, tls: TlsMaterial | null): string | null {
  if (!tls) return null;
  const asked = (hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const host = tls.host || safeHost(asked) || (asked === 'localhost' ? 'localhost' : null);
  if (!host) return null;
  const pathPart = typeof url === 'string' && url.startsWith('/') ? url : '/';
  return `https://${host}:${port}${pathPart}`;
}
