/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Say which version is really running, and say so loudly when the two disagree.
 *
 * The version printed in the sidebar and on the sign-in screen is compiled into
 * the browser bundle. The bundle is served by a service worker, which is what
 * makes the app installable and lets it open when the server is unreachable —
 * and which also means the page can be a whole release behind the program that
 * served it. On the v1.10.0 upgrade the release was correct, the HP had it, and
 * every visible check still said v1.9.0: there was no way to tell "the upgrade
 * did not happen" from "the upgrade happened and the browser has not noticed".
 *
 * So the screen now states both numbers, and when they differ it stops being a
 * footnote and becomes an instruction — because in that state everything else on
 * screen is being drawn by the old app.
 */

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fetchServerVersion } from '../lib/api';
import { versionMismatch } from '../lib/version';

export interface VersionState {
  /** What this page was built from. Always known. */
  client: string;
  /** What the server reports. Null while unasked, unreachable, or too old to say. */
  server: string | null;
  /** True only when both are known and they differ — never on "not known yet". */
  mismatch: boolean;
}

/**
 * Asked once per page load, shared by every caller.
 *
 * Both the footer and the banner use this hook, and each is rendered on the
 * sign-in screen and again inside the app — so without this, opening the app
 * fired four identical requests before anybody had typed a password. The version
 * of a running program cannot change underneath it, so there is nothing to
 * refresh: the one answer is kept for the life of the page.
 */
let pending: Promise<string | null> | null = null;
function serverVersionOnce(): Promise<string | null> {
  if (!pending) pending = fetchServerVersion();
  return pending;
}

export function useVersionCheck(): VersionState {
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void serverVersionOnce().then(v => {
      if (!cancelled) setServer(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { client: __APP_VERSION__, server, mismatch: versionMismatch(__APP_VERSION__, server) };
}

/**
 * The one-line version footer. Shows the server's number as well as its own once
 * it knows it, so "which build is this machine on" can be answered from the
 * screen rather than from the file size of an .exe.
 */
export function VersionFooter({ className = '' }: { className?: string }) {
  const { client, server, mismatch } = useVersionCheck();
  return (
    <p
      className={`text-center font-mono text-[9px] uppercase tracking-[0.2em] ${mismatch ? 'text-amber-400' : 'text-slate-500'} ${className}`}
      title={server ? `This page: v${client} · Server: v${server}` : `This page: v${client}`}
    >
      Powered by ISPO · v{client}
      {server && server !== client && <> · server v{server}</>}
    </p>
  );
}

/**
 * Shown only on a genuine mismatch. Deliberately worded as what to do rather than
 * what is wrong: the person reading it wants the new version, not a diagnosis.
 */
export function VersionMismatchBanner(props: { client?: string; server?: string | null } = {}) {
  const live = useVersionCheck();
  const client = props.client ?? live.client;
  const server = props.server === undefined ? live.server : props.server;
  if (!versionMismatch(client, server)) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-amber-400/60 bg-amber-50 p-3 text-xs text-amber-900 print:hidden"
    >
      <RefreshCw className="mt-px h-4 w-4 shrink-0 text-amber-600" />
      <span>
        <strong>This page is out of date.</strong> The program on this computer is <strong>v{server}</strong>, but
        the page you are looking at was built from <strong>v{client}</strong> and is being served from this
        browser&rsquo;s cache. Hold <strong>Ctrl</strong> and <strong>Shift</strong> and press <strong>R</strong> to
        load the new one. If it still says v{client} afterwards, close every tab of this app and open it again.
      </span>
    </div>
  );
}
