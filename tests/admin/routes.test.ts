import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus, MS_PER_SECOND } from '../../server/core/wire.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, createBrowser, PASSWORD, signIn, signInAsAdmin } from '../oidc/browser.ts';

const VIEWER = '{ viewer { username } }';

describe('admin sign-in', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  const postGraphql = (headers: Record<string, string>, body = JSON.stringify({ query: VIEWER })) =>
    admin.send('/graphql', { method: 'POST', headers, body });

  it('lets a signed-in admin use the API', async () => {
    const { data } = await adminGql(admin, VIEWER);
    expect(data.viewer).toEqual({ username: 'root' });
  });

  it('refuses the API without a session', async () => {
    const res = await createBrowser(app.base).send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: VIEWER }),
    });
    expect(res.status).toBe(HttpStatus.Unauthorized);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('refuses the API from another origin, even with the cookie', async () => {
    const foreign = await postGraphql({ 'content-type': 'application/json', origin: 'http://evil.example' });
    expect(foreign.status).toBe(HttpStatus.Forbidden);
    const crossSite = await postGraphql({ 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(HttpStatus.Forbidden);
    const same = await postGraphql({ 'content-type': 'application/json', origin: app.base });
    expect(same.status).toBe(HttpStatus.Ok);
  });

  it('refuses form posts and GETs to the API', async () => {
    const form = await postGraphql({ 'content-type': 'text/plain' });
    expect(form.status).toBe(HttpStatus.UnsupportedMediaType);
    const get = await admin.send(`/graphql?query=${encodeURIComponent(VIEWER)}`, {
      headers: { accept: 'application/json' },
    });
    expect(get.status).toBe(HttpStatus.MethodNotAllowed);
  });

  it('answers no CORS preflight', async () => {
    const res = await fetch(`${app.base}/graphql`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends a user outside the admin group to their account, not the admin API', async () => {
    app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
    const browser = createBrowser(app.base);
    const callback = await signIn(app, '/admin/login', 'ada', PASSWORD, browser, `${app.base}/admin/callback`);
    const res = await browser.send(callback.pathname + callback.search);
    expect(res.headers.get('location')).toBe('/account');
    const gql = await browser.send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: VIEWER }),
    });
    expect(gql.status).toBe(HttpStatus.Forbidden);
    expect((await browser.send('/admin/login')).headers.get('location')).toBe('/account');
  });

  it('takes the admin API from an admin taken out of the group', async () => {
    const { users } = app.services;
    const bob = users.create({
      username: 'bob',
      password: PASSWORD,
      email: '',
      name: '',
      groups: [ADMIN_DEFAULTS.group],
    });
    const browser = await signInAsAdmin(app, 'bob');
    expect((await adminGql(browser, VIEWER)).data.viewer.username).toBe('bob');
    users.update(bob.id, { username: 'bob', email: '', name: '', groups: [] });
    const res = await browser.send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: VIEWER }),
    });
    expect(res.status).toBe(HttpStatus.Forbidden);
  });

  it('returns only to paths on this origin', async () => {
    const goTo = async (asked: string): Promise<string | null> => {
      const browser = createBrowser(app.base);
      const callback = await signIn(
        app,
        `/admin/login?return=${encodeURIComponent(asked)}`,
        'root',
        PASSWORD,
        browser,
        `${app.base}/admin/callback`,
      );
      return (await browser.send(callback.pathname + callback.search)).headers.get('location');
    };
    expect(await goTo('/users')).toBe('/users');
    expect(await goTo('//evil.example')).toBe('/');
    expect(await goTo('https://evil.example')).toBe('/');
  });

  it('refuses a callback the browser did not start', async () => {
    const res = await createBrowser(app.base).send('/admin/callback?state=made-up&code=made-up');
    expect(res.headers.get('location')).toMatch(/^\/error\?error=admin_sign_in_failed/);
  });

  it('signs out', async () => {
    const browser = await signInAsAdmin(app);
    const res = await browser.send('/admin/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect((await res.json()).redirectTo).toBe(
      `${app.services.issuer}/session/end?client_id=${ADMIN_DEFAULTS.clientId}`,
    );
    expect(
      (await browser.send('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' } })).status,
    ).toBe(HttpStatus.Unauthorized);
  });

  it('keeps the admin client out of the client list and reserves its ID', async () => {
    const { data } = await adminGql(admin, '{ clients { clientId } }');
    expect(data.clients).toEqual([]);
    const created = await adminGql(
      admin,
      'mutation ($input: NewClientInput!) { createClient(input: $input) { clientId } }',
      {
        input: {
          clientId: ADMIN_DEFAULTS.clientId,
          name: 'Mine',
          authMethod: 'NONE',
          redirectUris: ['https://app.example/cb'],
          postLogoutRedirectUris: [],
        },
      },
    );
    expect(created.errors[0].message).toMatch(ADMIN_DEFAULTS.clientId);
  });

  it('sets the security headers', async () => {
    const res = await fetch(`${app.base}/healthz`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('first admin setup', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(() => app.close());

  const postSetup = (body: Record<string, string>) =>
    fetch(`${app.base}/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sends sign-ins to the setup page while there is no admin', async () => {
    const res = await fetch(`${app.base}/admin/login`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/setup');
    expect(await (await fetch(`${app.base}/admin/setup`)).json()).toEqual({ needed: true, tokenRequired: false });
  });

  it('refuses the wrong token', async () => {
    const res = await postSetup({ token: 'guess', username: 'root', password: PASSWORD });
    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(app.services.users.hasAdmin()).toBe(false);
  });

  it('makes an existing user an admin only with their password', async () => {
    const { token } = app.services.setup;
    app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: ['family'] });
    const wrong = await postSetup({ token, username: 'ada', password: 'wrong horse' });
    expect(wrong.status).toBe(HttpStatus.Unauthorized);
    const right = await postSetup({ token, username: 'ada', password: PASSWORD });
    expect(await right.json()).toEqual({ redirectTo: '/admin/login' });
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    expect(ada?.groups).toEqual(['family', ADMIN_DEFAULTS.group]);
  });

  it('closes once there is an admin', async () => {
    const res = await postSetup({ token: app.services.setup.token, username: 'eve', password: PASSWORD });
    expect(res.status).toBe(HttpStatus.Conflict);
    const login = await fetch(`${app.base}/admin/login`, { redirect: 'manual' });
    expect(login.headers.get('location')).toMatch(/\/oidc\/auth\?/);
  });
});

describe('first admin setup without a token', () => {
  let now = 0;
  let app: TestApp;

  beforeEach(async () => {
    now = Date.now();
    app = await startTestApp({ now: () => now });
  });

  afterEach(() => app.close());

  const postSetup = (body: Record<string, string>) =>
    fetch(`${app.base}/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('makes a new admin while the window is open', async () => {
    const res = await postSetup({ username: 'root', password: PASSWORD });
    expect(await res.json()).toEqual({ redirectTo: '/admin/login' });
    expect(app.services.users.hasAdmin()).toBe(true);
  });

  it('never promotes an existing user without the token', async () => {
    app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
    const res = await postSetup({ username: 'ada', password: PASSWORD });
    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(app.services.users.hasAdmin()).toBe(false);
  });

  it('needs the token once the window has closed', async () => {
    now += ADMIN_DEFAULTS.setupWindowSeconds * MS_PER_SECOND;
    expect(await (await fetch(`${app.base}/admin/setup`)).json()).toEqual({ needed: true, tokenRequired: true });
    const without = await postSetup({ username: 'root', password: PASSWORD });
    expect(without.status).toBe(HttpStatus.Forbidden);
    const withToken = await postSetup({ token: app.services.setup.token, username: 'root', password: PASSWORD });
    expect(withToken.status).toBe(HttpStatus.Ok);
  });
});
