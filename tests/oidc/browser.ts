import { HttpStatus } from '../../server/core/wire.ts';
import type { TestApp } from '../helpers.ts';

export const REDIRECT_URI = 'http://app.example/callback';
export const PASSWORD = 'correct horse';
/** More hops than a sign-in takes: authorize, login, consent, and back. */
const MAX_HOPS = 10;

/** A browser that keeps cookies by name and follows nothing on its own. */
export type Browser = ReturnType<typeof createBrowser>;

/**
 * Makes a browser for one test.
 *
 * @param base - The app's origin; relative URLs resolve against it.
 * @returns The browser.
 */
export function createBrowser(base: string) {
  const jar = new Map<string, string>();
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    const res = await fetch(new URL(url, base), { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
  return { send };
}

/**
 * Walks a browser from the authorize URL to the client's callback, signing in on the way.
 *
 * @param app - The running app.
 * @param authorizeUrl - Where the client sent the user.
 * @param username - Who signs in.
 * @param password - Their password.
 * @param browser - The browser to sign in with, so its cookies can be used after. A fresh one by default.
 * @returns The callback URL the provider sent the browser to.
 */
export async function signIn(
  app: TestApp,
  authorizeUrl: string,
  username: string,
  password: string,
  browser: Browser = createBrowser(app.base),
): Promise<URL> {
  let next = authorizeUrl;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const loginUid = /^\/login\/([^/]+)$/.exec(next)?.[1];
    if (loginUid !== undefined) {
      const details = await (await browser.send(`/interaction/${loginUid}/details`)).json();
      expect(details).toEqual({ clientName: expect.any(String) });
      const res = await browser.send(`/interaction/${loginUid}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      expect(res.status).toBe(HttpStatus.Ok);
      next = (await res.json()).redirectTo;
      continue;
    }
    const res = await browser.send(next);
    const location = res.headers.get('location');
    if (location === null) {
      throw new Error(`${next} answered ${res.status} without a redirect: ${await res.text()}`);
    }
    if (location.startsWith(REDIRECT_URI)) {
      return new URL(location);
    }
    next = location.startsWith(app.base) ? location.slice(app.base.length) : location;
  }
  throw new Error('The sign-in never came back to the client.');
}
