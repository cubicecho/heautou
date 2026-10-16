import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus } from '../../server/core/wire.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';

const REDIRECT_URI = 'http://app.example/callback';
const PASSWORD = 'correct horse';
/** More hops than a sign-in takes: authorize, login, consent, and back. */
const MAX_HOPS = 10;

/** A browser that keeps cookies by name and follows nothing on its own. */
function createBrowser(base: string) {
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
 * @returns The callback URL the provider sent the browser to.
 */
async function signIn(app: TestApp, authorizeUrl: string, username: string, password: string): Promise<URL> {
  const browser = createBrowser(app.base);
  let next = authorizeUrl;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const loginUid = /^\/login\/([^/]+)$/.exec(next)?.[1];
    if (loginUid !== undefined) {
      const details = await (await browser.send(`/interaction/${loginUid}/details`)).json();
      expect(details).toEqual({ clientName: 'Test app' });
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

describe('authorization code flow', () => {
  let app: TestApp;
  let issuer: string;

  beforeAll(async () => {
    app = await startTestApp();
    issuer = app.services.issuer;
    app.services.users.create({
      username: 'ada',
      password: PASSWORD,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      groups: ['admins'],
    });
  });

  afterAll(() => app.close());

  it('publishes discovery at the issuer', async () => {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`);
    const discovery = await res.json();
    expect(discovery.issuer).toBe(issuer);
    expect(discovery.scopes_supported).toEqual(expect.arrayContaining(['openid', 'profile', 'email', 'groups']));
    const jwks = await (await fetch(discovery.jwks_uri)).json();
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('signs a user into a confidential client and releases their claims', async () => {
    const client = app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    const state = randomBytes(8).toString('hex');
    const authorize = new URL(`${issuer}/auth`);
    authorize.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile email groups',
      state,
      nonce: 'n-1',
    }).toString();

    const callback = await signIn(app, authorize.pathname + authorize.search, 'ada', PASSWORD);
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code') ?? '';

    const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
    const tokenRes = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    });
    const tokens = await tokenRes.json();
    expect(tokenRes.status).toBe(HttpStatus.Ok);
    expect(tokens.id_token).toEqual(expect.any(String));

    const [, payload = ''] = tokens.id_token.split('.');
    const idClaims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(idClaims).toMatchObject({ iss: issuer, aud: client.clientId, nonce: 'n-1', email: 'ada@example.com' });

    const me = await (
      await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    ).json();
    expect(me).toEqual({
      sub: expect.any(String),
      preferred_username: 'ada',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      email_verified: true,
      groups: ['admins'],
    });
  });

  it('signs a user into a public client with PKCE', async () => {
    const client = app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.None,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const callback = await signIn(app, `/oidc/auth?${query}`, 'ada', PASSWORD);

    const tokenRes = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code') ?? '',
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(HttpStatus.Ok);
  });

  it('turns away a wrong password', async () => {
    const client = app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    });
    await expect(signIn(app, `/oidc/auth?${query}`, 'ada', 'wrong horse')).rejects.toThrow(/expected 401 to be 200/);
  });
});
