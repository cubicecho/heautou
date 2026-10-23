import { createPublicKey, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import {
  adminGql,
  type Browser,
  createBrowser,
  payloadOf,
  REDIRECT_URI,
  signInAsAdmin,
  signInForTokens,
  signInToWebApp,
} from '../browser.ts';
import { createTestUser, portOf, startTestApp, type TestApp } from '../helpers.ts';

/** The event a logout token carries, as OpenID Connect Back-Channel Logout 1.0 names it. */
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
/** The path the stand-in app takes logout tokens on. */
const LOGOUT_PATH = '/backchannel-logout';
/** The algorithm the provider signs with. */
const RS256 = 'RS256';

/** A stand-in for an application: an HTTP server that keeps the logout tokens posted to it. */
interface StandInApp {
  /** Its back-channel logout URI. */
  logoutUri: string;
  /** The logout tokens it was sent, oldest first. */
  tokens: string[];
  close: () => Promise<void>;
}

/**
 * Starts a stand-in application on a loopback port.
 *
 * @returns The app.
 */
async function startStandInApp(): Promise<StandInApp> {
  const tokens: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const isLogout = req.method === 'POST' && req.url === LOGOUT_PATH;
      const isForm = req.headers['content-type'] === 'application/x-www-form-urlencoded';
      if (isLogout && isForm) {
        tokens.push(new URLSearchParams(body).get('logout_token') ?? '');
      }
      res.writeHead(isLogout ? HttpStatus.Ok : HttpStatus.NotFound).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return {
    logoutUri: `http://127.0.0.1:${portOf(server)}${LOGOUT_PATH}`,
    tokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Finds a loopback URI nothing listens on, by starting a server and closing it.
 *
 * @returns The URI.
 */
async function unreachableUri(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}${LOGOUT_PATH}`;
}

/**
 * Checks a logout token's signature against the provider's published keys, as an application does.
 *
 * @param app - The running app.
 * @param token - The logout token.
 * @returns Its claims, once the signature is checked.
 */
async function verifiedClaims(app: TestApp, token: string): Promise<Record<string, unknown>> {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString());
  expect(alg).toBe(RS256);
  const { keys }: { keys: (JsonWebKey & { kid: string })[] } = await (
    await fetch(`${app.services.issuer}/jwks`)
  ).json();
  const jwk = keys.find((candidate) => candidate.kid === kid);
  expect(jwk).toBeDefined();
  const key = createPublicKey({ key: jwk ?? {}, format: 'jwk' });
  const isSigned = verify('sha256', Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'));
  expect(isSigned).toBe(true);
  return payloadOf(token);
}

describe('back-channel logout', () => {
  let app: TestApp;
  let standIn: StandInApp;
  let admin: Browser;
  let client: OidcClient;
  let adaId: string;

  beforeAll(async () => {
    app = await startTestApp();
    standIn = await startStandInApp();
    admin = await signInAsAdmin(app);
    adaId = (await createTestUser(app, { username: 'ada' })).id;
    client = await app.services.clients.create({
      name: 'Notes',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
      backchannelLogoutUri: standIn.logoutUri,
    });
  });

  afterAll(async () => {
    await standIn.close();
    await app.close();
  });

  beforeEach(() => {
    standIn.tokens.length = 0;
  });

  /**
   * Signs ada in to a client and reads the session ID her ID token carries.
   *
   * @param [to] - The client.
   * @param [browser] - Her browser.
   * @returns The `sid` claim.
   */
  const signInAda = async (to: OidcClient = client, browser: Browser = createBrowser(app.base)): Promise<string> => {
    const tokens = await signInForTokens(app, to, 'ada', 'openid', browser);
    const { sid } = payloadOf(tokens.id_token);
    expect(sid).toEqual(expect.any(String));
    return String(sid);
  };

  /**
   * Checks the stand-in app was sent one valid logout token for ada's session.
   *
   * @param sid - The session ID her ID token carried.
   */
  const expectLoggedOut = async (sid: string): Promise<void> => {
    expect(standIn.tokens).toHaveLength(1);
    const claims = await verifiedClaims(app, standIn.tokens[0] ?? '');
    expect(claims).toMatchObject({
      iss: app.services.issuer,
      aud: client.clientId,
      sub: adaId,
      sid,
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    });
    expect(claims.nonce).toBeUndefined();
  };

  it('says it supports back-channel logout', async () => {
    const discovery = await (await fetch(`${app.services.issuer}/.well-known/openid-configuration`)).json();
    expect(discovery).toMatchObject({ backchannel_logout_supported: true, backchannel_logout_session_supported: true });
  });

  it('tells the app when the user signs out at the provider', async () => {
    const browser = createBrowser(app.base);
    const sid = await signInAda(client, browser);

    const logout = await browser.send(`/oidc/session/end?client_id=${client.clientId}`);
    const logoutPage = new URL(logout.headers.get('location') ?? '', app.base);
    const confirmed = await browser.send('/oidc/session/end/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf: logoutPage.searchParams.get('xsrf') ?? '', logout: 'yes' }),
    });
    expect(confirmed.status).toBe(HttpStatus.SeeOther);
    await expectLoggedOut(sid);
  });

  it('tells the app when an admin ends the session', async () => {
    const sid = await signInAda();
    const [session] = app.services.sessions.sessionsOf(adaId);
    const ended = await adminGql(
      admin,
      'mutation ($id: ID!, $sessionId: ID!) { endUserSession(id: $id, sessionId: $sessionId) { id } }',
      { id: adaId, sessionId: session?.id },
    );
    expect(ended.errors).toBeUndefined();
    await expectLoggedOut(sid);
  });

  it('tells the app when an admin signs the user out everywhere', async () => {
    const sid = await signInAda();
    const out = await adminGql(admin, 'mutation ($id: ID!) { signOutUser(id: $id) { id } }', { id: adaId });
    expect(out.errors).toBeUndefined();
    await expectLoggedOut(sid);
  });

  it('tells the app when the user signs out everywhere from their account page', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    const sid = await signInAda(client, browser);
    const res = await browser.send('/api/account/sign-out-everywhere', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(HttpStatus.Ok);
    await expectLoggedOut(sid);
  });

  it('records an app it cannot reach, without failing the sign-out', async () => {
    const offline = await app.services.clients.create({
      name: 'Offline app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
      backchannelLogoutUri: await unreachableUri(),
    });
    const browser = createBrowser(app.base);
    await signInAda(offline, browser);
    await signInAda(client, browser);

    const out = await adminGql(admin, 'mutation ($id: ID!) { signOutUser(id: $id) { id } }', { id: adaId });
    expect(out.errors).toBeUndefined();
    expect(standIn.tokens).toHaveLength(1);
    expect(app.services.sessions.sessionsOf(adaId)).toEqual([]);

    const [failure] = (await app.services.audit.list({ types: [AuditType.AppLogoutFailed] })).entries;
    expect(failure).toMatchObject({
      actor: { userId: adaId, username: 'ada' },
      target: { id: offline.clientId, name: 'Offline app' },
      detail: { error: expect.any(String) },
    });
    expect(JSON.stringify(failure)).not.toContain('logout_token');
  });

  it('records an app it cannot reach when the user signs out at the provider', async () => {
    const offline = await app.services.clients.create({
      name: 'Gone app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
      backchannelLogoutUri: await unreachableUri(),
    });
    const browser = createBrowser(app.base);
    await signInAda(offline, browser);

    const logout = await browser.send(`/oidc/session/end?client_id=${offline.clientId}`);
    const logoutPage = new URL(logout.headers.get('location') ?? '', app.base);
    const confirmed = await browser.send('/oidc/session/end/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf: logoutPage.searchParams.get('xsrf') ?? '', logout: 'yes' }),
    });
    expect(confirmed.status).toBe(HttpStatus.SeeOther);
    const [failure] = (await app.services.audit.list({ types: [AuditType.AppLogoutFailed] })).entries;
    expect(failure).toMatchObject({ target: { id: offline.clientId, name: 'Gone app' }, ip: expect.any(String) });
  });
});
