/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Single API client.
 *
 * Every screen used to build its own fetch call and half of them read the error
 * body without checking that one existed, so a server error surfaced as
 * "undefined" or an unhandled promise rejection. All calls now go through here:
 * one place that parses errors, recognises an expired session, and never leaves
 * a rejected promise unattributed.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isAuthError() {
    return this.status === 401;
  }
}

let onUnauthenticated: (() => void) | null = null;

/** Registered by App so an expired session bounces the user to the sign-in screen. */
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check that the application service is running.');
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const serverMessage =
      payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : '';
    const message = serverMessage || `Request failed (HTTP ${res.status}).`;
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    throw new ApiError(res.status, message);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body ?? {})
};

/** Normalise anything thrown into a message safe to show a user. */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
