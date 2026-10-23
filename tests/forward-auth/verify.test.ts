import { FORWARD_AUTH_DEFAULTS } from '../../server/core/defaults.ts';
import { newTotpSecret, totpStepAt } from '../../server/core/totp.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { PROXY_COOKIE } from '../../server/forward-auth/client.ts';
import { REMOTE_HEADER } from '../../server/forward-auth/routes.ts';
import { PAGE_PARAM, WEB_PAGE } from '../../server/oidc/pages.ts';
import { AuditType } from '../../server/store/audit.ts';
import type { ProtectedSite } from '../../server/store/protected-sites.ts';
import {
  adminGql,
  type Browser,
  createBrowser,
  PASSWORD,
  type SecondFactorAnswer,
  signIn,
  signInAsAdmin,
} from '../browser.ts';
import { createTestUser, startTestApp, type TestApp } from '../helpers.ts';
import { withTotp } from '../oidc/authenticator.ts';

const SITE_HOST = 'sonarr.home.lan';
const SITE_URL = `https://${SITE_HOST}/series?sort=new`;

/** The headers Traefik, Caddy and the HAProxy recipe send for one request to the site. */
const forwardedFor = (url: string, method = 'GET'): Record<string, string> => {
  const parsed = new URL(url);
  return {
    'x-forwarded-proto': parsed.protocol.slice(0, -1),
    'x-forwarded-host': parsed.host,
    'x-forwarded-uri': `${parsed.pathname}${parsed.search}`,
    'x-forwarded-method': method,
  };
};

/**
 * Asks the verify endpoint about a request, as a proxy does.
 *
 * @param browser - Whose cookies the proxy passes on.
 * @param headers - The forwarded headers.
 * @param [query] - The verify endpoint's own query.
 * @returns The answer.
 */
function verify(browser: Browser, headers: Record<string, string>, query = ''): Promise<Response> {
  return browser.send(`/auth/verify${query}`, { headers });
}

/**
 * Signs a browser in to the protected sites through the sign-in URL a 401 named.
 *
 * @param app - The running app.
 * @param browser - The browser.
 * @param signInUrl - The `Location` of the 401.
 * @param username - Who signs in.
 * @param [secondFactor] - Answers the second factor.
 * @returns Where the callback sent the browser.
 */
async function signInToSites(
  app: TestApp,
  browser: Browser,
  signInUrl: string,
  username: string,
  secondFactor?: SecondFactorAnswer,
): Promise<string | null> {
  const start = signInUrl.slice(app.base.length);
  const callbackBase = `${app.base}/auth/callback`;
  const callback = await signIn(app, start, username, PASSWORD, browser, callbackBase, secondFactor);
  const res = await browser.send(callback.pathname + callback.search);
  expect(res.status).toBe(HttpStatus.SeeOther);
  return res.headers.get('location');
}

describe('forward auth', () => {
  let app: TestApp;
  let site: ProtectedSite;
  let adaId: string;

  beforeEach(async () => {
    app = await startTestApp();
    const { protectedSites } = app.services;
    const ada = await createTestUser(app, {
      username: 'ada',
      email: 'ada@home.lan',
      name: 'Ada Lovelace',
      groups: ['media', 'staff'],
    });
    adaId = ada.id;
    await createTestUser(app, { username: 'bob' });
    site = await protectedSites.create({ name: 'Sonarr', host: SITE_HOST, allowedGroups: ['media'] });
  });

  afterEach(() => app.close());

  /**
   * Signs ada (or another user) in to the site from a fresh browser.
   *
   * @param [username] - Who signs in.
   * @returns The browser, holding the proxy cookie.
   */
  const signedIn = async (username = 'ada'): Promise<Browser> => {
    const browser = createBrowser(app.base);
    const refused = await verify(browser, forwardedFor(SITE_URL));
    await signInToSites(app, browser, refused.headers.get('location') ?? '', username);
    return browser;
  };

  it('sends nobody signed in to sign in, with the original URL as rd', async () => {
    const res = await verify(createBrowser(app.base), forwardedFor(SITE_URL));
    expect(res.status).toBe(HttpStatus.Unauthorized);
    const location = new URL(res.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${app.base}/auth/sign-in`);
    expect(location.searchParams.get('rd')).toBe(SITE_URL);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers a browser GET with a 302 in the redirect form, and anything else with a 401', async () => {
    const browser = createBrowser(app.base);
    const get = await verify(browser, forwardedFor(SITE_URL), '?redirect=1');
    expect(get.status).toBe(HttpStatus.Found);
    expect(get.headers.get('location')).toContain('/auth/sign-in?rd=');
    const post = await verify(browser, forwardedFor(SITE_URL, 'POST'), '?redirect=1');
    expect(post.status).toBe(HttpStatus.Unauthorized);
  });

  it('signs in through the usual sign-in page and lets the user through with the Remote headers', async () => {
    const browser = createBrowser(app.base);
    const refused = await verify(browser, forwardedFor(SITE_URL));
    const landed = await signInToSites(app, browser, refused.headers.get('location') ?? '', 'ada');
    expect(landed).toBe(SITE_URL);

    const res = await verify(browser, forwardedFor(SITE_URL));
    expect(res.status).toBe(HttpStatus.Ok);
    expect(res.headers.get(REMOTE_HEADER.user)).toBe('ada');
    expect(res.headers.get(REMOTE_HEADER.name)).toBe('Ada Lovelace');
    expect(res.headers.get(REMOTE_HEADER.email)).toBe('ada@home.lan');
    expect(res.headers.get(REMOTE_HEADER.groups)).toBe('media,staff');
    const [entry] = (await app.services.audit.list({ types: [AuditType.ProxySignedIn] })).entries;
    expect(entry).toMatchObject({ actor: { username: 'ada' }, target: { id: site.id }, detail: { host: SITE_HOST } });
    // The provider's own sign-in is not logged twice as an app sign-in.
    expect((await app.services.audit.list({ types: [AuditType.AppSignedIn] })).entries).toEqual([]);
  });

  it('takes the nginx form, X-Original-URL, alone', async () => {
    const browser = await signedIn();
    const res = await verify(browser, { 'x-original-url': SITE_URL, 'x-original-method': 'GET' });
    expect(res.status).toBe(HttpStatus.Ok);
  });

  it('refuses a user outside the site’s groups, logging it once', async () => {
    const browser = await signedIn('bob');
    const first = await verify(browser, forwardedFor(SITE_URL));
    const second = await verify(browser, forwardedFor(`https://${SITE_HOST}/style.css`));
    expect(first.status).toBe(HttpStatus.Forbidden);
    expect(second.status).toBe(HttpStatus.Forbidden);
    const refusals = (await app.services.audit.list({ types: [AuditType.ProxyRefused] })).entries;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ actor: { username: 'bob' }, detail: { reason: 'not_in_allowed_groups' } });
  });

  it('refuses a host no site covers, and paths outside a site’s prefix', async () => {
    const browser = await signedIn();
    const other = await verify(browser, forwardedFor('https://radarr.home.lan/'));
    expect(other.status).toBe(HttpStatus.Forbidden);
    await app.services.protectedSites.update(site.id, { name: 'Sonarr', host: SITE_HOST, pathPrefix: '/admin' });
    expect((await verify(browser, forwardedFor(`https://${SITE_HOST}/admin/x`))).status).toBe(HttpStatus.Ok);
    expect((await verify(browser, forwardedFor(`https://${SITE_HOST}/administrator`))).status).toBe(
      HttpStatus.Forbidden,
    );
  });

  it('refuses forwarded headers it cannot use or that disagree', async () => {
    const browser = createBrowser(app.base);
    expect((await verify(browser, {})).status).toBe(HttpStatus.BadRequest);
    const conflicting = { ...forwardedFor(SITE_URL), 'x-original-url': 'https://radarr.home.lan/' };
    expect((await verify(browser, conflicting)).status).toBe(HttpStatus.BadRequest);
    const chained = { ...forwardedFor(SITE_URL), 'x-forwarded-host': `${SITE_HOST}, evil.example` };
    expect((await verify(browser, chained)).status).toBe(HttpStatus.BadRequest);
    const scheme = { ...forwardedFor(SITE_URL), 'x-forwarded-proto': 'javascript' };
    expect((await verify(browser, scheme)).status).toBe(HttpStatus.BadRequest);
  });

  it('asks for a second factor where the site requires one', async () => {
    const { protectedSites, factors } = app.services;
    await protectedSites.update(site.id, {
      name: 'Sonarr',
      host: SITE_HOST,
      allowedGroups: ['media'],
      requireSecondFactor: true,
    });
    const browser = await signedIn();
    const withoutFactor = await verify(browser, forwardedFor(SITE_URL));
    expect(withoutFactor.status).toBe(HttpStatus.Forbidden);
    expect((await app.services.audit.list({ types: [AuditType.ProxyRefused] })).entries[0]).toMatchObject({
      detail: { reason: 'no_second_factor' },
    });

    const secret = newTotpSecret();
    await factors.setTotp(adaId, secret, totpStepAt(Date.now()) - 1);
    const stepUp = await verify(browser, forwardedFor(SITE_URL));
    expect(stepUp.status).toBe(HttpStatus.Unauthorized);
    const signInUrl = stepUp.headers.get('location') ?? '';
    expect(new URL(signInUrl).searchParams.get('mfa')).toBe('1');
    await signInToSites(app, browser, signInUrl, 'ada', withTotp(secret));
    expect((await verify(browser, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Ok);
  });

  it('ends the proxy session when the user signs out at the provider', async () => {
    const browser = await signedIn();
    const logout = await browser.send(`/oidc/session/end?client_id=${FORWARD_AUTH_DEFAULTS.clientId}`);
    const logoutPage = new URL(logout.headers.get('location') ?? '', app.base);
    expect(logoutPage.pathname).toBe(WEB_PAGE.logout);
    expect(logoutPage.searchParams.get(PAGE_PARAM.client)).toBe('Protected sites');
    const confirmed = await browser.send('/oidc/session/end/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf: logoutPage.searchParams.get(PAGE_PARAM.xsrf) ?? '', logout: 'yes' }),
    });
    expect(confirmed.status).toBe(HttpStatus.SeeOther);
    expect((await verify(browser, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Unauthorized);
  });

  it('ends the proxy session at its own sign-out, and sends the browser to the provider’s', async () => {
    const browser = await signedIn();
    const out = await browser.send('/auth/sign-out');
    expect(out.headers.get('location')).toBe(
      `${app.services.issuer}/session/end?client_id=${FORWARD_AUTH_DEFAULTS.clientId}`,
    );
    expect((await verify(browser, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Unauthorized);
    expect((await app.services.audit.list({ types: [AuditType.ProxySignedOut] })).entries).toHaveLength(1);
  });

  it('ends the proxy session when the user is disabled, or an admin signs them out', async () => {
    const browser = await signedIn();
    await app.services.users.setDisabled(adaId, true);
    expect((await verify(browser, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Unauthorized);

    await app.services.users.setDisabled(adaId, false);
    const again = await signedIn();
    expect((await verify(again, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Ok);
    const admin = await signInAsAdmin(app);
    const ended = await adminGql(admin, 'mutation ($id: ID!) { signOutUser(id: $id) { id } }', { id: adaId });
    expect(ended.errors).toBeUndefined();
    expect((await verify(again, forwardedFor(SITE_URL))).status).toBe(HttpStatus.Unauthorized);
  });

  it('refuses to return anywhere but a protected site or the cookie domain', async () => {
    const browser = createBrowser(app.base);
    const attempts = [
      'https://evil.example/',
      `https://${SITE_HOST}.evil.example/`,
      `https://user:pass@${SITE_HOST}/`,
      'javascript:alert(1)',
      `//${SITE_HOST}/`,
    ];
    for (const rd of attempts) {
      const res = await browser.send(`/auth/sign-in?rd=${encodeURIComponent(rd)}`);
      const location = new URL(res.headers.get('location') ?? '', app.base);
      expect(location.pathname).toBe(WEB_PAGE.error);
      expect(location.searchParams.get(PAGE_PARAM.error)).toBe('proxy_return_refused');
    }
    const allowed = await browser.send(`/auth/sign-in?rd=${encodeURIComponent(SITE_URL)}`);
    expect(new URL(allowed.headers.get('location') ?? '').pathname).toBe('/oidc/auth');
  });

  it('sets no cookie on another domain than the configured one', async () => {
    const browser = createBrowser(app.base);
    const refused = await verify(browser, forwardedFor(SITE_URL));
    const start = (refused.headers.get('location') ?? '').slice(app.base.length);
    const callback = await signIn(app, start, 'ada', PASSWORD, browser, `${app.base}/auth/callback`);
    const res = await browser.send(callback.pathname + callback.search);
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith(`${PROXY_COOKIE.session}=`)) ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });
});

describe('forward auth behind a configured proxy list', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp({ trustedProxies: ['10.0.0.5', '172.18.0.0/16'], proxyCookieDomain: 'home.lan' });
    await app.services.protectedSites.create({ name: 'Sonarr', host: SITE_HOST });
  });

  afterAll(() => app.close());

  it('believes no forwarded headers from an address off the list', async () => {
    const res = await verify(createBrowser(app.base), forwardedFor(SITE_URL));
    expect(res.status).toBe(HttpStatus.Forbidden);
    expect(res.headers.get('location')).toBeNull();
  });

  it('lets an rd under the cookie domain through', async () => {
    const res = await createBrowser(app.base).send(`/auth/sign-in?rd=${encodeURIComponent('https://wiki.home.lan/')}`);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/oidc/auth');
  });
});

describe('protected sites in the admin API', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  it('adds, changes and removes a site, auditing each', async () => {
    const created = await adminGql(
      admin,
      'mutation ($input: ProtectedSiteInput!) { createProtectedSite(input: $input) { id host pathPrefix allowedGroups requireSecondFactor } }',
      { input: { name: 'Wiki', host: 'Wiki.Home.Lan', pathPrefix: '/admin/', allowedGroups: ['staff'] } },
    );
    const { id, ...fields } = created.data.createProtectedSite;
    expect(fields).toEqual({
      host: 'wiki.home.lan',
      pathPrefix: '/admin',
      allowedGroups: ['staff'],
      requireSecondFactor: false,
    });
    const groups = await adminGql(admin, '{ groups { name } }');
    expect(groups.data.groups.map((group: { name: string }) => group.name)).toContain('staff');
    const refusedDelete = await adminGql(admin, 'mutation { deleteGroup(name: "staff") }');
    expect(refusedDelete.errors?.[0]?.message).toContain('Wiki');

    const updated = await adminGql(
      admin,
      'mutation ($id: ID!, $input: ProtectedSiteInput!) { updateProtectedSite(id: $id, input: $input) { requireSecondFactor } }',
      { id, input: { name: 'Wiki', host: 'wiki.home.lan', requireSecondFactor: true } },
    );
    expect(updated.data.updateProtectedSite.requireSecondFactor).toBe(true);
    const bad = await adminGql(
      admin,
      'mutation ($input: ProtectedSiteInput!) { createProtectedSite(input: $input) { id } }',
      { input: { name: 'Bad', host: 'https://x.home.lan/' } },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    await adminGql(admin, 'mutation ($id: ID!) { deleteProtectedSite(id: $id) { id } }', { id });
    const { entries } = await app.services.audit.list({
      types: [AuditType.ProtectedSiteCreated, AuditType.ProtectedSiteUpdated, AuditType.ProtectedSiteDeleted],
    });
    const types = entries.map((entry) => entry.type);
    expect(types).toEqual([
      AuditType.ProtectedSiteDeleted,
      AuditType.ProtectedSiteUpdated,
      AuditType.ProtectedSiteCreated,
    ]);
  });

  it('sets the cookie domain only to one that covers Heautou’s host', async () => {
    const refused = await adminGql(
      admin,
      'mutation { setForwardAuthCookieDomain(domain: "home.lan") { cookieDomain } }',
    );
    // The test server is on 127.0.0.1, which no domain covers.
    expect(refused.errors?.[0]?.message).toContain('127.0.0.1');
    const cleared = await adminGql(
      admin,
      '{ forwardAuth { cookieDomain isCookieDomainFromEnvironment verifyUrl verifyRedirectUrl } }',
    );
    expect(cleared.data.forwardAuth).toEqual({
      cookieDomain: null,
      isCookieDomainFromEnvironment: false,
      verifyUrl: `${app.base}/auth/verify`,
      verifyRedirectUrl: `${app.base}/auth/verify?redirect=1`,
    });
  });
});
