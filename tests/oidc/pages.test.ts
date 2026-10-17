import { HttpStatus } from '../../server/core/wire.ts';
import { PAGE_PARAM, WEB_PAGE } from '../../server/oidc/pages.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { createBrowser, PASSWORD, REDIRECT_URI, signIn } from './browser.ts';

/** What a browser sends when it navigates, so the provider answers with a page rather than JSON. */
const NAVIGATION = { accept: 'text/html' };

/**
 * Reads where a redirect points, as a URL against the app.
 *
 * @param app - The running app.
 * @param res - A redirect.
 * @returns Its location.
 */
function locationOf(app: TestApp, res: Response): URL {
  expect(res.status).toBe(HttpStatus.SeeOther);
  return new URL(res.headers.get('location') ?? '', app.base);
}

describe('pages the provider sends a browser to', () => {
  let app: TestApp;
  let client: OidcClient;

  beforeAll(async () => {
    app = await startTestApp();
    app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
    client = app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterAll(() => app.close());

  /**
   * Builds the authorize URL a client sends a browser to.
   *
   * @param redirectUri - Where the client asks to be sent back.
   * @returns A root-relative URL.
   */
  const authorizeUrl = (redirectUri = REDIRECT_URI): string =>
    `/oidc/auth?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid',
    })}`;

  it('asks on the logout page, then signs the user out', async () => {
    const browser = createBrowser(app.base);
    await signIn(app, authorizeUrl(), 'ada', PASSWORD, browser);

    const logout = locationOf(app, await browser.send(`/oidc/session/end?client_id=${client.clientId}`));
    expect(logout.pathname).toBe(WEB_PAGE.logout);
    expect(logout.searchParams.get(PAGE_PARAM.client)).toBe('Test app');
    const xsrf = logout.searchParams.get(PAGE_PARAM.xsrf) ?? '';
    expect(xsrf).not.toBe('');

    // What the logout page's form posts.
    const confirmed = await browser.send('/oidc/session/end/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf, logout: 'yes' }),
    });
    const success = locationOf(app, confirmed);
    const loggedOut = locationOf(app, await browser.send(success.pathname + success.search));
    expect(loggedOut.pathname).toBe(WEB_PAGE.loggedOut);
    expect(app.services.audit.list({ types: [AuditType.AppSignedOut] }).entries[0]).toMatchObject({
      actor: { username: 'ada' },
      target: { id: client.clientId, name: 'Test app' },
    });

    // Signed out: the next sign-in asks for the password again.
    const again = locationOf(app, await browser.send(authorizeUrl()));
    const interaction = locationOf(app, await browser.send(again.pathname));
    expect(interaction.pathname).toMatch(/^\/login\//);
  });

  it('refuses a logout form without its secret', async () => {
    const browser = createBrowser(app.base);
    await signIn(app, authorizeUrl(), 'ada', PASSWORD, browser);
    await browser.send('/oidc/session/end');

    const forged = await browser.send('/oidc/session/end/confirm', {
      method: 'POST',
      headers: { ...NAVIGATION, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf: 'guessed', logout: 'yes' }),
    });
    expect(locationOf(app, forged).pathname).toBe(WEB_PAGE.error);
  });

  it('shows an unregistered redirect URI on the error page, naming the client', async () => {
    const browser = createBrowser(app.base);
    const res = await browser.send(authorizeUrl('http://elsewhere.example/callback'), { headers: NAVIGATION });
    const page = locationOf(app, res);
    expect(page.pathname).toBe(WEB_PAGE.error);
    expect(page.searchParams.get(PAGE_PARAM.error)).toBe('invalid_redirect_uri');
    expect(page.searchParams.get(PAGE_PARAM.description)).toEqual(expect.any(String));
    expect(page.searchParams.get(PAGE_PARAM.client)).toBe('Test app');
    expect(page.searchParams.get(PAGE_PARAM.redirectUri)).toBe('http://elsewhere.example/callback');
  });

  it('shows an unknown client on the error page', async () => {
    const browser = createBrowser(app.base);
    const res = await browser.send('/oidc/auth?client_id=nobody&response_type=code&scope=openid', {
      headers: NAVIGATION,
    });
    const page = locationOf(app, res);
    expect(page.pathname).toBe(WEB_PAGE.error);
    expect(page.searchParams.get(PAGE_PARAM.error)).toBe('invalid_client');
  });

  it('still answers an app calling the token endpoint with JSON', async () => {
    const res = await fetch(`${app.base}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'x', client_id: 'nobody' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(HttpStatus.Unauthorized);
    expect(await res.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('sends an expired sign-in to the error page', async () => {
    const res = await createBrowser(app.base).send('/interaction/expired-uid');
    const page = locationOf(app, res);
    expect(page.pathname).toBe(WEB_PAGE.error);
    expect(page.searchParams.get(PAGE_PARAM.error)).toBe('interaction_failed');
  });
});
