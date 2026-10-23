import { ADMIN_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import {
  adminGql,
  basicAuth,
  createBrowser,
  PASSWORD,
  payloadOf,
  REDIRECT_URI,
  signInAsAdmin,
  signInForTokens,
} from './browser.ts';

/**
 * Tries a sign-in and returns the login POST's reply.
 *
 * @param app - The running app.
 * @param clientId - The client.
 * @param username - Who signs in.
 * @returns The status and body of `POST /interaction/:uid/login`.
 */
async function tryLogin(app: TestApp, clientId: string, username: string): Promise<{ status: number; error?: string }> {
  const browser = createBrowser(app.base);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
  });
  let location = (await browser.send(`/oidc/auth?${query}`)).headers.get('location') ?? '';
  location = (await browser.send(location)).headers.get('location') ?? '';
  const uid = location.split('/').pop();
  const res = await browser.send(`/interaction/${uid}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await res.json();
  return { status: res.status, error: body.error };
}

/**
 * Calls userinfo.
 *
 * @param app - The running app.
 * @param accessToken - The token.
 * @returns The HTTP status.
 */
async function userinfoStatus(app: TestApp, accessToken: string): Promise<number> {
  const res = await fetch(`${app.services.issuer}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  return res.status;
}

describe('who may sign in, and what clients see', () => {
  let app: TestApp;
  let client: OidcClient;
  let adaId: string;

  beforeEach(async () => {
    app = await startTestApp();
    const { users, clients } = app.services;
    adaId = (await users.create({ username: 'ada', password: PASSWORD, email: '', name: 'Ada', groups: ['family'] }))
      .id;
    await users.create({ username: 'eve', password: PASSWORD, email: '', name: '', groups: ['guests'] });
    client = await clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterEach(() => app.close());

  it('lets only the allowed groups sign in to a limited client', async () => {
    await app.services.clients.update(client.clientId, { ...client, allowedGroups: ['family'] });
    const refused = await tryLogin(app, client.clientId, 'eve');
    expect(refused.status).toBe(HttpStatus.Forbidden);
    expect(refused.error).toContain('only for family');
    await expect(signInForTokens(app, client, 'ada')).resolves.toHaveProperty('id_token');
  });

  it('turns a signed-in user away from a client their groups do not allow', async () => {
    const browser = createBrowser(app.base);
    await signInForTokens(app, client, 'eve', 'openid', browser);
    const limited = await app.services.clients.create({
      name: 'Family album',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
      allowedGroups: ['family'],
    });
    const query = new URLSearchParams({
      client_id: limited.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    });
    let next = `/oidc/auth?${query}`;
    for (let hop = 0; hop < 4 && next.startsWith('/login/') === false; hop += 1) {
      next = (await browser.send(next)).headers.get('location') ?? '';
    }
    // With no account to carry on with, the provider asks for a sign-in rather than issuing a code.
    expect(next).toMatch(/^\/login\//);
    const login = await browser.send(`/interaction/${next.split('/').pop()}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'eve', password: PASSWORD }),
    });
    expect(login.status).toBe(HttpStatus.Forbidden);
  });

  it('refuses a disabled user and ends their tokens', async () => {
    const tokens = await signInForTokens(app, client, 'ada', 'openid offline_access');
    expect(tokens.refresh_token).toEqual(expect.any(String));
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(
      admin,
      'mutation($id: ID!) { setUserDisabled(id: $id, disabled: true) { disabled } }',
      {
        id: adaId,
      },
    );
    expect(reply.data.setUserDisabled.disabled).toBe(true);
    expect(await userinfoStatus(app, tokens.access_token)).toBe(HttpStatus.Unauthorized);
    const refresh = await fetch(`${app.services.issuer}/token`, {
      method: 'POST',
      headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token ?? '' }),
    });
    expect(refresh.status).toBe(HttpStatus.BadRequest);
    const login = await tryLogin(app, client.clientId, 'ada');
    expect(login.status).toBe(HttpStatus.Forbidden);
    expect(login.error).toContain('disabled');
  });

  it('refuses to disable the last admin', async () => {
    const admin = await signInAsAdmin(app);
    const root = app.services.users.list().find((user) => user.username === 'root');
    const reply = await adminGql(admin, 'mutation($id: ID!) { setUserDisabled(id: $id, disabled: true) { id } }', {
      id: root?.id,
    });
    expect(reply.errors[0].message).toContain(ADMIN_DEFAULTS.group);
  });

  it('releases custom claims and groups under the name the client reads', async () => {
    const admin = await signInAsAdmin(app);
    const setClaims = await adminGql(
      admin,
      'mutation($id: ID!, $input: UserInput!) { updateUser(id: $id, input: $input) { claims } }',
      {
        id: adaId,
        input: { username: 'ada', email: '', name: 'Ada', groups: ['family'], claims: [{ name: 'quota', value: '5' }] },
      },
    );
    expect(setClaims.data.updateUser.claims).toEqual({ quota: '5' });
    await adminGql(
      admin,
      'mutation($id: ID!, $input: ClientInput!) { updateClient(clientId: $id, input: $input) { groupsClaim } }',
      {
        id: client.clientId,
        input: {
          name: client.name,
          authMethod: 'CLIENT_SECRET_BASIC',
          redirectUris: [REDIRECT_URI],
          postLogoutRedirectUris: [],
          groupsClaim: 'roles',
        },
      },
    );
    const tokens = await signInForTokens(app, client, 'ada');
    const claims = payloadOf(tokens.id_token);
    expect(claims).toMatchObject({ quota: '5', roles: ['family'] });
    expect(claims).not.toHaveProperty('groups');
  });

  it('refuses a custom claim the provider sets itself', async () => {
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(
      admin,
      'mutation($id: ID!, $input: UserInput!) { updateUser(id: $id, input: $input) { id } }',
      { id: adaId, input: { username: 'ada', email: '', name: '', groups: [], claims: [{ name: 'sub', value: 'x' }] } },
    );
    expect(reply.errors[0].message).toContain('set by the provider');
  });

  it('issues client credentials tokens that introspect as active', async () => {
    const service = await app.services.clients.create({
      name: 'Backup job',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowClientCredentials: true,
    });
    const tokenRes = await fetch(`${app.services.issuer}/token`, {
      method: 'POST',
      headers: { authorization: basicAuth(service), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    expect(tokenRes.status).toBe(HttpStatus.Ok);
    const { access_token: token } = await tokenRes.json();
    const introspect = await fetch(`${app.services.issuer}/token/introspection`, {
      method: 'POST',
      headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    expect(await introspect.json()).toMatchObject({ active: true, client_id: service.clientId });
    expect((await app.services.audit.list({ types: [AuditType.MachineTokenIssued] })).entries[0]).toMatchObject({
      actor: null,
      target: { id: service.clientId, name: 'Backup job' },
    });
  });

  it('gives a client the token lifetimes set for it, and the defaults to others', async () => {
    const lifetimes = { accessTokenSeconds: 300, idTokenSeconds: 600, refreshTokenSeconds: 2_419_200 };
    const own = await app.services.clients.update(client.clientId, { ...client, tokenLifetimes: lifetimes });
    const tokens = await signInForTokens(app, own, 'ada', 'openid offline_access');
    expect(tokens.expires_in).toBe(lifetimes.accessTokenSeconds);
    const idToken = payloadOf(tokens.id_token);
    expect(Number(idToken.exp) - Number(idToken.iat)).toBe(lifetimes.idTokenSeconds);
    const introspect = await fetch(`${app.services.issuer}/token/introspection`, {
      method: 'POST',
      headers: { authorization: basicAuth(own), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token ?? '' }),
    });
    const refresh = await introspect.json();
    expect(refresh.exp - refresh.iat).toBe(lifetimes.refreshTokenSeconds);
    // The grant outlives its refresh token's default, so the refresh token still works.
    const refreshed = await fetch(`${app.services.issuer}/token`, {
      method: 'POST',
      headers: { authorization: basicAuth(own), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token ?? '' }),
    });
    expect((await refreshed.json()).expires_in).toBe(lifetimes.accessTokenSeconds);

    const other = await app.services.clients.create({
      name: 'Notes',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    expect((await signInForTokens(app, other, 'ada')).expires_in).toBe(TOKEN_LIFETIME_DEFAULTS.accessTokenSeconds);
  });

  it('gives client credentials tokens the client’s access token lifetime', async () => {
    const service = await app.services.clients.create({
      name: 'Backup job',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowClientCredentials: true,
    });
    const machineToken = async () => {
      const res = await fetch(`${app.services.issuer}/token`, {
        method: 'POST',
        headers: { authorization: basicAuth(service), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });
      return res.json();
    };
    expect((await machineToken()).expires_in).toBe(TOKEN_LIFETIME_DEFAULTS.clientCredentialsSeconds);
    const accessTokenSeconds = 7200;
    await app.services.clients.update(service.clientId, {
      ...service,
      tokenLifetimes: { accessTokenSeconds, idTokenSeconds: null, refreshTokenSeconds: null },
    });
    expect((await machineToken()).expires_in).toBe(accessTokenSeconds);
  });

  it('refuses client credentials to a client not allowed them', async () => {
    const tokenRes = await fetch(`${app.services.issuer}/token`, {
      method: 'POST',
      headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    expect(tokenRes.status).toBe(HttpStatus.BadRequest);
    expect((await app.services.audit.list({ types: [AuditType.AppTokenRefused] })).entries[0]).toMatchObject({
      target: { id: client.clientId },
      detail: { error: 'invalid_request', grantType: 'client_credentials' },
    });
  });

  it('lists and ends a user’s sessions', async () => {
    const tokens = await signInForTokens(app, client, 'ada');
    const admin = await signInAsAdmin(app);
    const SESSIONS = 'query($id: String!) { user(where: { id: { eq: $id } }) { sessions { id clientNames } } }';
    const listed = await adminGql(admin, SESSIONS, { id: adaId });
    const [session] = listed.data.user.sessions;
    expect(session.clientNames).toEqual(['Photos']);
    const ended = await adminGql(
      admin,
      'mutation($id: ID!, $sessionId: ID!) { endUserSession(id: $id, sessionId: $sessionId) { id } }',
      { id: adaId, sessionId: session.id },
    );
    expect(ended.errors).toBeUndefined();
    expect((await adminGql(admin, SESSIONS, { id: adaId })).data.user.sessions).toEqual([]);
    expect(await userinfoStatus(app, tokens.access_token)).toBe(HttpStatus.Unauthorized);
  });

  it('rotates the signing key and keeps the old one published', async () => {
    const before = await signInForTokens(app, client, 'ada');
    const oldKid = JSON.parse(Buffer.from(before.id_token.split('.')[0] ?? '', 'base64url').toString()).kid;
    const admin = await signInAsAdmin(app);
    const rotated = await adminGql(admin, 'mutation { rotateKeys { signingKeys { kid isCurrent } } }');
    const [current, previous] = rotated.data.rotateKeys.signingKeys;
    expect(previous).toEqual({ kid: oldKid, isCurrent: false });
    const jwks = await (await fetch(`${app.services.issuer}/jwks`)).json();
    expect(jwks.keys.map((key: { kid: string }) => key.kid)).toEqual([current.kid, oldKid]);
    const after = await signInForTokens(app, client, 'ada');
    expect(JSON.parse(Buffer.from(after.id_token.split('.')[0] ?? '', 'base64url').toString()).kid).toBe(current.kid);
    // The admin's session cookie and the provider's own still work after the rebuild.
    expect((await adminGql(admin, '{ viewer { username } }')).data.viewer.username).toBe('root');
    await expect(signInAsAdmin(app)).resolves.toBeDefined();
  });
});
