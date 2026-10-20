import { DEVICE_FLOW_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { DEVICE_CODE_GRANT } from '../../server/oidc/adapter.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import type { PublicUser } from '../../server/store/users.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { type Browser, createBrowser, PASSWORD, payloadOf } from './browser.ts';

const TELOS_API = 'https://telos.home.lan/api';
/** An access token lifetime the API sets, unlike any default. */
const API_SECONDS = 900;
/** What the Home Assistant integration asks for. */
const SCOPE = 'openid email offline_access';
/** More hops than approving a device takes: the code page, the confirm, the sign-in, consent and back. */
const MAX_HOPS = 12;

/** The device authorization response (RFC 8628, section 3.2). */
interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * POSTs a form to the provider, as a device does.
 *
 * @param app - The running app.
 * @param path - The path under the issuer.
 * @param body - The form.
 * @returns The status and the JSON reply.
 */
async function postForm(
  app: TestApp,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${app.services.issuer}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Starts the device flow for a public client.
 *
 * @param app - The running app.
 * @param client - The client.
 * @param [resource] - The API asked for.
 * @returns The status and the reply.
 */
function startDevice(app: TestApp, client: OidcClient, resource: string = TELOS_API) {
  return postForm(app, '/device/auth', { client_id: client.clientId, scope: SCOPE, resource });
}

/**
 * Polls the token endpoint, as the device does.
 *
 * @param app - The running app.
 * @param client - The client.
 * @param deviceCode - The device code.
 * @returns The status and the reply.
 */
function poll(app: TestApp, client: OidcClient, deviceCode: string) {
  return postForm(app, '/token', {
    grant_type: DEVICE_CODE_GRANT,
    device_code: deviceCode,
    client_id: client.clientId,
  });
}

/**
 * Reads a redirect's target as a URL on the app.
 *
 * @param app - The running app.
 * @param res - The response.
 * @returns The URL it sends the browser to.
 */
function locationOf(app: TestApp, res: Response): URL {
  const location = res.headers.get('location');
  if (location === null) {
    throw new Error(`Expected a redirect, got ${res.status}.`);
  }
  return new URL(location, app.base);
}

/**
 * Does what the web app's `/device` page does to reach its confirm step: fetches the form secret, then posts the
 * code.
 *
 * @param app - The running app.
 * @param browser - The user's browser.
 * @param userCode - The code the device shows.
 * @returns The confirm step's URL.
 */
async function enterCode(app: TestApp, browser: Browser, userCode: string): Promise<URL> {
  const page = locationOf(app, await browser.send('/oidc/device'));
  expect(page.pathname).toBe('/device');
  const xsrf = page.searchParams.get('xsrf') ?? '';
  const posted = await browser.send('/oidc/device', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ xsrf, user_code: userCode }),
  });
  expect(posted.status).toBe(HttpStatus.SeeOther);
  return locationOf(app, posted);
}

/**
 * Presses a button on the confirm step: Continue or Cancel.
 *
 * @param app - The running app.
 * @param browser - The user's browser.
 * @param confirm - The confirm step's URL.
 * @param button - Which button.
 * @returns Where the provider sends the browser.
 */
async function press(app: TestApp, browser: Browser, confirm: URL, button: 'confirm' | 'abort'): Promise<URL> {
  const posted = await browser.send('/oidc/device', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      xsrf: confirm.searchParams.get('xsrf') ?? '',
      user_code: confirm.searchParams.get('user_code') ?? '',
      [button]: 'yes',
    }),
  });
  return locationOf(app, posted);
}

/**
 * Walks the browser from the confirm step through the sign-in to the device page's last step.
 *
 * @param app - The running app.
 * @param browser - The user's browser.
 * @param confirm - The confirm step's URL.
 * @param username - Who signs in.
 * @returns The page it ends on.
 */
async function approve(app: TestApp, browser: Browser, confirm: URL, username: string): Promise<URL> {
  let next = await press(app, browser, confirm, 'confirm');
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (next.pathname === '/device') {
      return next;
    }
    const loginUid = /^\/login\/([^/]+)$/.exec(next.pathname)?.[1];
    if (loginUid !== undefined) {
      const res = await browser.send(`/interaction/${loginUid}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD }),
      });
      if (res.status !== HttpStatus.Ok) {
        throw new Error(`The sign-in answered ${res.status}.`);
      }
      next = new URL((await res.json()).redirectTo, app.base);
      continue;
    }
    next = locationOf(app, await browser.send(next.pathname + next.search));
  }
  throw new Error('The approval never came back to the device page.');
}

/**
 * Reads a JWT's header.
 *
 * @param jwt - The token.
 * @returns Its header.
 */
function headerOf(jwt: string): Record<string, unknown> {
  const [header = ''] = jwt.split('.');
  return JSON.parse(Buffer.from(header, 'base64url').toString());
}

describe('device flow', () => {
  let app: TestApp;
  let ada: PublicUser;
  let hub: OidcClient;

  beforeEach(async () => {
    app = await startTestApp();
    ada = app.services.users.create({
      username: 'ada',
      password: PASSWORD,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      groups: [],
    });
    hub = app.services.clients.create({
      name: 'Home Assistant',
      authMethod: ClientAuthMethod.None,
      redirectUris: [],
      postLogoutRedirectUris: [],
      allowDeviceFlow: true,
    });
    app.services.apis.create({ identifier: TELOS_API, name: 'Telos', scopes: [], allowedClientIds: [hub.clientId] });
  });

  afterEach(() => app.close());

  it('publishes the device authorization endpoint and grant', async () => {
    const discovery = await (await fetch(`${app.services.issuer}/.well-known/openid-configuration`)).json();
    expect(discovery.device_authorization_endpoint).toBe(`${app.services.issuer}/device/auth`);
    expect(discovery.grant_types_supported).toContain(DEVICE_CODE_GRANT);
  });

  it('answers pending, then slow_down, then gives a JWT for the API, an ID token and a refresh token', async () => {
    const started = await startDevice(app, hub);
    expect(started.status).toBe(HttpStatus.Ok);
    const device = started.body as unknown as DeviceAuthorization;
    expect(device).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/),
      verification_uri: `${app.base}/device`,
      verification_uri_complete: `${app.base}/device?user_code=${encodeURIComponent(device.user_code)}`,
      expires_in: DEVICE_FLOW_DEFAULTS.codeSeconds,
      interval: DEVICE_FLOW_DEFAULTS.pollSeconds,
    });

    expect(await poll(app, hub, device.device_code)).toMatchObject({
      status: HttpStatus.BadRequest,
      body: { error: 'authorization_pending' },
    });
    expect(await poll(app, hub, device.device_code)).toMatchObject({
      status: HttpStatus.BadRequest,
      body: { error: 'slow_down' },
    });

    const browser = createBrowser(app.base);
    const confirm = await enterCode(app, browser, device.user_code);
    expect(confirm.pathname).toBe('/device');
    expect(Object.fromEntries(confirm.searchParams)).toMatchObject({
      step: 'confirm',
      user_code: device.user_code,
      client: 'Home Assistant',
    });
    const done = await approve(app, browser, confirm, 'ada');
    expect(Object.fromEntries(done.searchParams)).toEqual({ step: 'done', client: 'Home Assistant' });

    const tokens = await poll(app, hub, device.device_code);
    expect(tokens.status).toBe(HttpStatus.Ok);
    const accessToken = String(tokens.body.access_token);
    expect(headerOf(accessToken)).toMatchObject({ typ: 'at+jwt' });
    expect(payloadOf(accessToken)).toMatchObject({
      iss: app.services.issuer,
      aud: TELOS_API,
      sub: ada.id,
      client_id: hub.clientId,
      exp: expect.any(Number),
    });
    // An access token for an API carries only the API's own scopes, and this one has none.
    expect(payloadOf(accessToken)).not.toHaveProperty('scope');
    expect(payloadOf(String(tokens.body.id_token))).toMatchObject({ sub: ada.id, email: 'ada@example.com' });
    expect(tokens.body.refresh_token).toEqual(expect.any(String));

    const refreshed = await postForm(app, '/token', {
      grant_type: 'refresh_token',
      refresh_token: String(tokens.body.refresh_token),
      client_id: hub.clientId,
      resource: TELOS_API,
    });
    expect(refreshed.status).toBe(HttpStatus.Ok);
    expect(headerOf(String(refreshed.body.access_token))).toMatchObject({ typ: 'at+jwt' });
    expect(payloadOf(String(refreshed.body.access_token))).toMatchObject({ aud: TELOS_API, sub: ada.id });
    // A public client's refresh token is rotated on every use.
    expect(refreshed.body.refresh_token).toEqual(expect.any(String));
    expect(refreshed.body.refresh_token).not.toBe(tokens.body.refresh_token);

    // The code works once, and using it again ends the grant it gave, as a replayed code does.
    expect((await poll(app, hub, device.device_code)).body.error).toBe('invalid_grant');
    const replayed = await postForm(app, '/token', {
      grant_type: 'refresh_token',
      refresh_token: String(refreshed.body.refresh_token),
      client_id: hub.clientId,
    });
    expect(replayed.body.error).toBe('invalid_grant');
  });

  it('puts the API scopes the device asked for and the API lifetime in the access token', async () => {
    app.services.apis.update(TELOS_API, {
      name: 'Telos',
      scopes: ['todos'],
      allowedClientIds: [hub.clientId],
      accessTokenSeconds: API_SECONDS,
    });
    const started = await postForm(app, '/device/auth', {
      client_id: hub.clientId,
      scope: `${SCOPE} todos`,
      resource: TELOS_API,
    });
    const device = started.body as unknown as DeviceAuthorization;
    const browser = createBrowser(app.base);
    await approve(app, browser, await enterCode(app, browser, device.user_code), 'ada');
    const tokens = await poll(app, hub, device.device_code);
    const claims = payloadOf(String(tokens.body.access_token));
    expect(claims).toMatchObject({ aud: TELOS_API, scope: 'todos' });
    // The API's own lifetime wins over the client's and the server's.
    expect(Number(claims.exp) - Number(claims.iat)).toBe(API_SECONDS);
    expect(tokens.body.refresh_token).toEqual(expect.any(String));
  });

  it('opens the confirm step from verification_uri_complete', async () => {
    const device = (await startDevice(app, hub)).body as unknown as DeviceAuthorization;
    const browser = createBrowser(app.base);
    // The page has no form secret yet, so it goes to the provider's /device with the code, which posts it on.
    const res = await browser.send(`/oidc/device?user_code=${encodeURIComponent(device.user_code)}`);
    expect(res.status).toBe(HttpStatus.Ok);
    const html = await res.text();
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
    const posted = await browser.send('/oidc/device', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf, user_code: device.user_code }),
    });
    expect(locationOf(app, posted).searchParams.get('step')).toBe('confirm');
  });

  it('tells the device access_denied when the user cancels', async () => {
    const device = (await startDevice(app, hub)).body as unknown as DeviceAuthorization;
    const browser = createBrowser(app.base);
    const confirm = await enterCode(app, browser, device.user_code);
    const cancelled = await press(app, browser, confirm, 'abort');
    expect(cancelled.pathname).toBe('/device');
    expect(cancelled.searchParams.get('error')).toBe('aborted');
    expect((await poll(app, hub, device.device_code)).body.error).toBe('access_denied');
  });

  it('asks for a code again when it is wrong', async () => {
    const browser = createBrowser(app.base);
    const again = await enterCode(app, browser, 'BBBB-BBBB');
    expect(again.searchParams.get('error')).toBe('not_found');
    expect(again.searchParams.get('xsrf')).toEqual(expect.any(String));
  });

  it('tells the device expired_token once its code has run out', async () => {
    const device = (await startDevice(app, hub)).body as unknown as DeviceAuthorization;
    const provider = app.services.host.current();
    const code = await provider.DeviceCode.find(device.device_code);
    if (code === undefined) {
      throw new Error('The device code was not stored.');
    }
    code.exp = Math.floor(Date.now() / 1000) - 1;
    await code.save();
    expect((await poll(app, hub, device.device_code)).body.error).toBe('expired_token');
    const again = await enterCode(app, createBrowser(app.base), device.user_code);
    expect(again.searchParams.get('error')).toBe('expired');
  });

  it('refuses a client the operator did not allow the device flow', async () => {
    const app2 = app.services.clients.create({
      name: 'Browser app',
      authMethod: ClientAuthMethod.None,
      redirectUris: ['http://127.0.0.1/callback'],
      postLogoutRedirectUris: [],
    });
    const refused = await postForm(app, '/device/auth', { client_id: app2.clientId, scope: SCOPE });
    // oidc-provider answers invalid_request, naming the grant.
    expect(refused).toMatchObject({
      status: HttpStatus.BadRequest,
      body: { error: 'invalid_request', error_description: `${DEVICE_CODE_GRANT} is not allowed for this client` },
    });
  });

  it('refuses an API that does not list the client', async () => {
    app.services.apis.create({ identifier: 'https://notes.home.lan', name: 'Notes', scopes: [] });
    const refused = await startDevice(app, hub, 'https://notes.home.lan');
    expect(refused).toMatchObject({ status: HttpStatus.BadRequest, body: { error: 'invalid_target' } });
  });

  it('refuses a user outside the client’s groups at sign-in', async () => {
    app.services.clients.update(hub.clientId, { ...hub, allowedGroups: ['family'] });
    const device = (await startDevice(app, hub)).body as unknown as DeviceAuthorization;
    const browser = createBrowser(app.base);
    const confirm = await enterCode(app, browser, device.user_code);
    await expect(approve(app, browser, confirm, 'ada')).rejects.toThrow(`answered ${HttpStatus.Forbidden}`);
    expect((await poll(app, hub, device.device_code)).body.error).toBe('authorization_pending');
  });

  it('revokes the refresh token when the user’s session is ended', async () => {
    const device = (await startDevice(app, hub)).body as unknown as DeviceAuthorization;
    const browser = createBrowser(app.base);
    await approve(app, browser, await enterCode(app, browser, device.user_code), 'ada');
    const tokens = await poll(app, hub, device.device_code);
    expect(tokens.status).toBe(HttpStatus.Ok);

    const [session] = app.services.sessions.sessionsOf(ada.id);
    expect(session?.clientIds).toContain(hub.clientId);
    await app.services.sessions.endSession(ada.id, session?.id ?? '', null);
    const refreshed = await postForm(app, '/token', {
      grant_type: 'refresh_token',
      refresh_token: String(tokens.body.refresh_token),
      client_id: hub.clientId,
      resource: TELOS_API,
    });
    expect(refreshed).toMatchObject({ status: HttpStatus.BadRequest, body: { error: 'invalid_grant' } });
  });

  it('keeps clients saved before the device flow as they were', () => {
    const before = app.services.clients.create({
      name: 'Old app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: ['https://old.example/callback'],
      postLogoutRedirectUris: [],
    });
    expect(before.allowDeviceFlow).toBe(false);
    expect(() =>
      app.services.clients.create({
        name: 'Nowhere',
        authMethod: ClientAuthMethod.None,
        redirectUris: [],
        postLogoutRedirectUris: [],
      }),
    ).toThrow(/redirect URI/);
  });
});
