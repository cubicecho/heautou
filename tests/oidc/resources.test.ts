import { createPublicKey, type JsonWebKeyInput, verify } from 'node:crypto';
import { API_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { TOKEN_FORMAT_OPAQUE } from '../../server/store/apis.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import { createTestUser, startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, basicAuth, PASSWORD, payloadOf, REDIRECT_URI, signIn, signInAsAdmin } from './browser.ts';

const PHOTOS_API = 'https://photos-api.home.lan';
const NOTES_API = 'https://notes-api.home.lan';

/**
 * Checks a JWT's signature against the provider's published keys, as an API would.
 *
 * @param app - The running app.
 * @param jwt - The token.
 * @returns Whether a key in the JWKS signed it.
 */
async function isSignedByProvider(app: TestApp, jwt: string): Promise<boolean> {
  const [header = '', payload = '', signature = ''] = jwt.split('.');
  const { kid, alg } = JSON.parse(Buffer.from(header, 'base64url').toString());
  expect(alg).toBe('RS256');
  const jwks: { keys: Array<JsonWebKeyInput['key'] & { kid: string }> } = await (
    await fetch(`${app.services.issuer}/jwks`)
  ).json();
  const jwk = jwks.keys.find((key) => key.kid === kid);
  if (jwk === undefined) {
    return false;
  }
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  return verify('sha256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'));
}

/**
 * Asks the token endpoint for something.
 *
 * @param app - The running app.
 * @param client - The client, with its secret.
 * @param body - The form.
 * @returns The status and the JSON reply.
 */
async function tokenRequest(
  app: TestApp,
  client: OidcClient,
  body: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${app.services.issuer}/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Signs ada in to a client with a resource indicator and swaps the code, with no resource at the token endpoint.
 *
 * @param app - The running app.
 * @param client - The client.
 * @param resource - The API asked for.
 * @param scope - The scopes asked for.
 * @returns The callback URL and, when it carried a code, the token reply.
 */
async function signInFor(app: TestApp, client: OidcClient, resource: string, scope: string) {
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    resource,
  });
  const callback = await signIn(app, `/oidc/auth?${query}`, 'ada', PASSWORD);
  const code = callback.searchParams.get('code');
  const tokens =
    code === null
      ? null
      : await tokenRequest(app, client, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  return { callback, tokens };
}

describe('access tokens for a named API (resource indicators)', () => {
  let app: TestApp;
  let client: OidcClient;
  let service: OidcClient;

  beforeEach(async () => {
    app = await startTestApp();
    await createTestUser(app, { username: 'ada', name: 'Ada' });
    client = await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    service = await app.services.clients.create({
      name: 'Backup job',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowClientCredentials: true,
    });
    await app.services.apis.create({
      identifier: PHOTOS_API,
      name: 'Photos API',
      scopes: ['photos:read', 'photos:write'],
      allowedClientIds: [client.clientId, service.clientId],
    });
  });

  afterEach(() => app.close());

  it('gives a JWT access token whose audience is the API, verifiable with the JWKS', async () => {
    const { tokens } = await signInFor(app, client, PHOTOS_API, 'openid profile photos:read');
    expect(tokens?.status).toBe(HttpStatus.Ok);
    const accessToken = String(tokens?.body.access_token);
    expect(await isSignedByProvider(app, accessToken)).toBe(true);
    expect(payloadOf(accessToken)).toMatchObject({
      iss: app.services.issuer,
      aud: PHOTOS_API,
      client_id: client.clientId,
      scope: 'photos:read',
    });
    expect(tokens?.body.expires_in).toBe(TOKEN_LIFETIME_DEFAULTS.accessTokenSeconds);
    // The ID token is still for the app.
    expect(payloadOf(String(tokens?.body.id_token)).aud).toBe(client.clientId);

    const introspect = await fetch(`${app.services.issuer}/token/introspection`, {
      method: 'POST',
      headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }),
    });
    // The API checks a JWT itself; oidc-provider does not introspect one.
    expect(await introspect.json()).toMatchObject({ error: 'unsupported_token_type' });

    const [signedIn] = (await app.services.audit.list({ types: [AuditType.AppSignedIn] })).entries;
    expect(signedIn?.detail).toMatchObject({ resource: PHOTOS_API });
  });

  it('gives an opaque token to an API that asks for one, and introspection names the API', async () => {
    await app.services.apis.update(PHOTOS_API, { tokenFormat: TOKEN_FORMAT_OPAQUE });
    const { tokens } = await signInFor(app, client, PHOTOS_API, 'openid photos:write');
    const accessToken = String(tokens?.body.access_token);
    expect(accessToken.split('.')).toHaveLength(1);
    const introspect = await fetch(`${app.services.issuer}/token/introspection`, {
      method: 'POST',
      headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }),
    });
    expect(await introspect.json()).toMatchObject({ active: true, aud: PHOTOS_API, scope: 'photos:write' });
  });

  it('refuses an API the client is not allowed, and one that does not exist', async () => {
    await app.services.apis.create({ identifier: NOTES_API, name: 'Notes API', scopes: ['notes'] });
    const refused = await signInFor(app, client, NOTES_API, 'openid notes');
    expect(refused.callback.searchParams.get('error')).toBe('invalid_target');
    const unknown = await signInFor(app, client, 'https://nowhere.home.lan', 'openid');
    expect(unknown.callback.searchParams.get('error')).toBe('invalid_target');
    const machine = await tokenRequest(app, service, { grant_type: 'client_credentials', resource: NOTES_API });
    expect(machine).toMatchObject({ status: HttpStatus.BadRequest, body: { error: 'invalid_target' } });

    const failed = (await app.services.audit.list({ types: [AuditType.AppSignInFailed] })).entries;
    expect(failed.map((entry) => entry.detail)).toContainEqual(
      expect.objectContaining({ error: 'invalid_target', resource: NOTES_API }),
    );
    const [tokenRefused] = (await app.services.audit.list({ types: [AuditType.AppTokenRefused] })).entries;
    expect(tokenRefused?.detail).toMatchObject({ error: 'invalid_target', resource: NOTES_API });
  });

  it('gives a machine client a token to an API with client credentials', async () => {
    const machine = await tokenRequest(app, service, {
      grant_type: 'client_credentials',
      resource: PHOTOS_API,
      scope: 'photos:read openid',
    });
    expect(machine.status).toBe(HttpStatus.Ok);
    const accessToken = String(machine.body.access_token);
    expect(await isSignedByProvider(app, accessToken)).toBe(true);
    expect(payloadOf(accessToken)).toMatchObject({
      aud: PHOTOS_API,
      client_id: service.clientId,
      scope: 'photos:read',
    });
    expect(machine.body.expires_in).toBe(TOKEN_LIFETIME_DEFAULTS.clientCredentialsSeconds);
    const [issued] = (await app.services.audit.list({ types: [AuditType.MachineTokenIssued] })).entries;
    expect(issued?.detail).toMatchObject({ resource: PHOTOS_API });

    // Its only API is the one it gets when it names none.
    const defaulted = await tokenRequest(app, service, { grant_type: 'client_credentials' });
    expect(payloadOf(String(defaulted.body.access_token)).aud).toBe(PHOTOS_API);
  });

  it('takes the API’s lifetime over the client’s, and the client’s over the server’s', async () => {
    const clientSeconds = 900;
    const apiSeconds = 300;
    await app.services.clients.update(client.clientId, {
      ...client,
      tokenLifetimes: { accessTokenSeconds: clientSeconds, idTokenSeconds: null, refreshTokenSeconds: null },
    });
    await app.services.clients.update(service.clientId, {
      ...service,
      tokenLifetimes: { accessTokenSeconds: clientSeconds, idTokenSeconds: null, refreshTokenSeconds: null },
    });
    const withClients = await signInFor(app, client, PHOTOS_API, 'openid photos:read');
    expect(withClients.tokens?.body.expires_in).toBe(clientSeconds);

    await app.services.apis.update(PHOTOS_API, { accessTokenSeconds: apiSeconds });
    const withApi = await signInFor(app, client, PHOTOS_API, 'openid photos:read');
    expect(withApi.tokens?.body.expires_in).toBe(apiSeconds);
    const jwt = payloadOf(String(withApi.tokens?.body.access_token));
    expect(Number(jwt.exp) - Number(jwt.iat)).toBe(apiSeconds);
    const machine = await tokenRequest(app, service, { grant_type: 'client_credentials', resource: PHOTOS_API });
    expect(machine.body.expires_in).toBe(apiSeconds);

    // A token with no API keeps the client's own.
    await app.services.apis.update(PHOTOS_API, { allowedClientIds: [client.clientId] });
    const noApi = await tokenRequest(app, service, { grant_type: 'client_credentials' });
    expect(noApi.body.expires_in).toBe(clientSeconds);
  });

  it('caps a token for an API that sets no lifetime at the API maximum, however long the client’s own', async () => {
    const longSeconds = API_DEFAULTS.maxAccessTokenSeconds * 30;
    await app.services.clients.update(client.clientId, {
      ...client,
      tokenLifetimes: { accessTokenSeconds: longSeconds, idTokenSeconds: null, refreshTokenSeconds: null },
    });
    const capped = await signInFor(app, client, PHOTOS_API, 'openid photos:read');
    expect(capped.tokens?.body.expires_in).toBe(API_DEFAULTS.maxAccessTokenSeconds);
  });

  it('manages APIs over GraphQL, audited, and drops a deleted client from them', async () => {
    const admin = await signInAsAdmin(app);
    const created = await adminGql(
      admin,
      'mutation($input: NewApiInput!) { createApi(input: $input) { identifier tokenFormat allowedClients { clientId } } }',
      {
        input: {
          identifier: NOTES_API,
          name: 'Notes API',
          scopes: ['notes'],
          tokenFormat: 'OPAQUE',
          accessTokenSeconds: API_DEFAULTS.minAccessTokenSeconds,
          allowedClientIds: [client.clientId],
        },
      },
    );
    expect(created.data.createApi).toEqual({
      identifier: NOTES_API,
      tokenFormat: 'OPAQUE',
      allowedClients: [{ clientId: client.clientId }],
    });
    const tooLong = await adminGql(
      admin,
      'mutation($id: ID!, $input: ApiInput!) { updateApi(identifier: $id, input: $input) { name } }',
      { id: NOTES_API, input: { name: 'Notes', accessTokenSeconds: API_DEFAULTS.maxAccessTokenSeconds + 1 } },
    );
    expect(tooLong.errors[0].message).toContain('accessTokenSeconds');

    const deleted = await adminGql(admin, 'mutation($id: ID!) { deleteClient(clientId: $id) { clientId } }', {
      id: client.clientId,
    });
    expect(deleted.errors).toBeUndefined();
    const listed = await adminGql(admin, '{ apis(limit: 10) { identifier allowedClients(limit: 10) { clientId } } }');
    expect(listed.data.apis).toEqual([
      { identifier: PHOTOS_API, allowedClients: [{ clientId: service.clientId }] },
      { identifier: NOTES_API, allowedClients: [] },
    ]);
    await adminGql(admin, 'mutation($id: ID!) { deleteApi(identifier: $id) { identifier } }', { id: NOTES_API });
    expect(app.services.apis.find(NOTES_API)).toBeNull();
    const types = (await app.services.audit.list({})).entries.map((entry) => entry.type);
    expect(types).toEqual(expect.arrayContaining([AuditType.ApiCreated, AuditType.ApiDeleted]));
  });
});
