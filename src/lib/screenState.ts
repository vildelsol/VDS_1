/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What each screen was showing, remembered for as long as you are signed in.
 *
 * `App.tsx` renders exactly one tab at a time, so leaving a screen unmounts it and
 * every choice made on it — the month, the period, which sub-view — is thrown
 * away. Coming back re-ran the default. Look at Operational Reports for August,
 * step across to the dashboard to check a figure, come back, and the screen has
 * quietly gone somewhere else while you were reading.
 *
 * The defaults themselves are deliberate and are left exactly as they are: a
 * report about a finished month opens on last month on purpose, so a part-month
 * figure is never circulated as if it were final. What was wrong was not the
 * first answer, it was that the screen kept giving it after you had said
 * otherwise. So this remembers your answer and uses the documented default only
 * until you have given one.
 *
 * Session-scoped and held in a module, for the same reason as
 * `reportRange.ts`: this is a working choice, not a setting. It does not survive
 * a reload, and `forgetScreenState()` is called on sign-out — the desk machine is
 * shared and the next person to sign in is not owed the last one's view.
 *
 * Keys are namespaced by screen (`'reports.ispo.month'`). Two screens sharing a
 * key would silently share a control, so `test/components.test.mjs` asserts every
 * key used in `src/` is unique.
 */

import { useCallback, useRef, useState } from 'react';

const remembered = new Map<string, unknown>();

/** What this key was last set to, or `undefined` if it never has been. */
export function recall<T>(key: string): T | undefined {
  return remembered.get(key) as T | undefined;
}

/** Record a choice, so the next mount of that screen starts where this one ended. */
export function remember<T>(key: string, value: T): void {
  remembered.set(key, value);
}

/** Forget every screen's choices. Called on sign-out, and by the tests. */
export function forgetScreenState(): void {
  remembered.clear();
}

/**
 * `useState`, except the screen picks up where you left it.
 *
 * A drop-in replacement: the second element is an ordinary React setter and takes
 * the updater form. `initial` is only consulted the first time this key is used
 * in the session, so a screen's documented default still decides the first view.
 */
export function useRemembered<T>(
  key: string,
  initial: T | (() => T)
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (remembered.has(key)) return remembered.get(key) as T;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });

  /*
   * The latest value is held in a ref as well as in state so the updater form can
   * be resolved here rather than inside `setValue`. Writing to the map from
   * inside a state updater would be a side effect in a function React is free to
   * call twice.
   */
  const latest = useRef(value);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = resolved;
      remembered.set(key, resolved);
      setValue(resolved);
    },
    [key]
  );

  return [value, set];
}
