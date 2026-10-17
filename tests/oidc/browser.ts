import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
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
 * @param callback - Where the client wants the browser back; the walk stops at the first redirect there.
 * @returns The callback URL the provider sent the browser to.
 */
export async function signIn(
  app: TestApp,
  authorizeUrl: string,
  username: string,
  password: string,
  browser: Browser = createBrowser(app.base),
  callback: string = REDIRECT_URI,
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
    if (location.startsWith(callback)) {
      return new URL(location);
    }
    next = location.startsWith(app.base) ? location.slice(app.base.length) : location;
  }
  throw new Error('The sign-in never came back to the client.');
}

/**
 * Signs a browser in to the admin UI, adding the admin first when there is none by that name.
 *
 * @param app - The running app.
 * @param [username] - The admin's username.
 * @returns The browser, holding the admin session cookie.
 */
export async function signInAsAdmin(app: TestApp, username = 'root'): Promise<Browser> {
  const { users } = app.services;
  const exists = users.list().some((user) => user.username === username);
  if (exists === false) {
    users.create({ username, password: PASSWORD, email: '', name: '', groups: [ADMIN_DEFAULTS.group] });
  }
  const browser = createBrowser(app.base);
  const callback = await signIn(app, '/admin/login', username, PASSWORD, browser, `${app.base}/admin/callback`);
  const res = await browser.send(callback.pathname + callback.search);
  expect(res.status).toBe(HttpStatus.SeeOther);
  return browser;
}

/**
 * Sends a GraphQL operation the way the admin UI does.
 *
 * @param browser - A browser, signed in or not.
 * @param query - The operation.
 * @param [variables] - Its variables.
 * @returns The parsed reply.
 */
export async function adminGql(browser: Browser, query: string, variables: Record<string, unknown> = {}) {
  const res = await browser.send('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

/** A subscription opened the way the admin UI opens one. */
export interface Subscription {
  /**
   * Waits for the next event.
   *
   * @returns Its parsed `data`, or null once the stream has completed.
   */
  next: () => Promise<{ data?: Record<string, unknown>; errors?: unknown[] } | null>;
  /** Closes the stream. */
  close: () => void;
}

/**
 * Opens a GraphQL subscription over server-sent events, as the admin UI does.
 *
 * @param browser - A browser, signed in or not.
 * @param query - The subscription.
 * @param [variables] - Its variables.
 * @returns The response, and the stream once it answered 200.
 */
export async function adminSubscribe(
  browser: Browser,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<{ res: Response; subscription: Subscription }> {
  const abort = new AbortController();
  const res = await browser.send('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ query, variables }),
    signal: abort.signal,
  });
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const next: Subscription['next'] = async () => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = block.split('\n');
        if (lines.includes('event: complete')) {
          return null;
        }
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
        if (data.length > 0 && data.join('') !== '') {
          return JSON.parse(data.join('\n'));
        }
        continue;
      }
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        return null;
      }
      buffer += chunk.value;
    }
  };
  return { res, subscription: { next, close: () => abort.abort() } };
}

/** The tokens a confidential client gets for a user. */
export interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
}

/**
 * Signs a user in to a confidential client and swaps the code for tokens.
 *
 * @param app - The running app.
 * @param client - The client, with its secret.
 * @param username - Who signs in.
 * @param [scope] - What the client asks for.
 * @param [browser] - The browser, so a test can sign in again with its session.
 * @returns The tokens.
 */
export async function signInForTokens(
  app: TestApp,
  client: { clientId: string; clientSecret: string | null },
  username: string,
  scope = 'openid profile email groups',
  browser: Browser = createBrowser(app.base),
): Promise<Tokens> {
  const { issuer } = app.services;
  const authorize = new URL(`${issuer}/auth`);
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    ...(scope.includes('offline_access') ? { prompt: 'consent' } : {}),
  }).toString();
  const callback = await signIn(app, authorize.pathname + authorize.search, username, PASSWORD, browser);
  const tokenRes = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(tokenRes.status).toBe(HttpStatus.Ok);
  return tokenRes.json();
}

/**
 * Builds a client's HTTP Basic header.
 *
 * @param client - The client, with its secret.
 * @returns The header's value.
 */
export function basicAuth(client: { clientId: string; clientSecret: string | null }): string {
  return `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret ?? ''}`).toString('base64')}`;
}

/**
 * Reads a JWT's payload without checking it.
 *
 * @param jwt - The token.
 * @returns Its claims.
 */
export function payloadOf(jwt: string): Record<string, unknown> {
  const [, payload = ''] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}
