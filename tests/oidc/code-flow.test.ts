import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus } from '../../server/core/wire.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { PASSWORD, REDIRECT_URI, signIn } from './browser.ts';

describe('authorization code flow', () => {
  let app: TestApp;
  let issuer: string;

  beforeAll(async () => {
    app = await startTestApp();
    issuer = app.services.issuer;
    await app.services.users.create({
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
    const client = await app.services.clients.create({
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
    const client = await app.services.clients.create({
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

  // Mealie v2 and other authlib-based apps: a client secret and PKCE together, and a second
  // redirect URI with a query string.
  it('signs a user into a confidential client that also uses PKCE', async () => {
    const directUri = `${REDIRECT_URI}?direct=1`;
    const client = await app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI, directUri],
      postLogoutRedirectUris: [directUri],
    });
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile email groups',
      state: 's-1',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const callback = await signIn(app, `/oidc/auth?${query}`, 'ada', PASSWORD);
    expect(callback.searchParams.get('iss')).toBe(issuer);

    const exchange = (codeVerifier: string) =>
      fetch(`${issuer}/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
      });
    const tokenRes = await exchange(verifier);
    expect(tokenRes.status).toBe(HttpStatus.Ok);
    const tokens = await tokenRes.json();
    const me = await (
      await fetch(`${issuer}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    ).json();
    expect(me).toMatchObject({ email: 'ada@example.com', email_verified: true, groups: ['admins'] });

    // The code is spent, and a wrong verifier would not have been taken anyway.
    expect((await exchange(randomBytes(32).toString('base64url'))).status).toBe(HttpStatus.BadRequest);
  });

  it('turns away a wrong password', async () => {
    const client = await app.services.clients.create({
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
