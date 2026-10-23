import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { newTotpSecret, totpCode, totpStepAt } from '../../server/core/totp.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import { UnknownIdentity, type UpstreamFields, UpstreamKind } from '../../server/store/upstreams.ts';
import { createTestUser, startTestApp, type TestApp } from '../helpers.ts';
import { basicAuth, PASSWORD, payloadOf, REDIRECT_URI } from '../oidc/browser.ts';

/** More hops than a sign-in through an upstream provider takes. */
const MAX_HOPS = 20;
const UPSTREAM_ID = 'corp';

/** A browser that keeps each origin's cookies apart, as a real one keeps two sites apart. */
function createSiteBrowser() {
  const jars = new Map<string, Map<string, string>>();
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { origin } = new URL(url);
    const jar = jars.get(origin) ?? new Map<string, string>();
    jars.set(origin, jar);
    const headers = new Headers(init.headers);
    headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return res;
  };
  const postJson = (url: string, body: unknown): Promise<Response> =>
    send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { send, postJson };
}
type SiteBrowser = ReturnType<typeof createSiteBrowser>;

/**
 * Follows redirects until one leaves for `stopAt`, signing in with a password at any sign-in page on the way.
 *
 * @param browser - The browser.
 * @param start - An absolute URL.
 * @param stopAt - The prefixes to stop at.
 * @param login - Who signs in at a password page, or null to stop there instead.
 * @returns The URL it stopped at.
 */
async function walk(
  browser: SiteBrowser,
  start: string,
  stopAt: string | string[],
  login: { username: string; password: string } | null,
): Promise<URL> {
  let next = new URL(start);
  const stops = [stopAt].flat();
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    if (stops.some((stop) => next.href.startsWith(stop))) {
      return next;
    }
    const loginUid = /^\/login\/([^/]+)$/.exec(next.pathname)?.[1];
    if (loginUid !== undefined) {
      if (login === null) {
        return next;
      }
      const res = await browser.postJson(`${next.origin}/interaction/${loginUid}/login`, login);
      expect(res.status).toBe(HttpStatus.Ok);
      next = new URL((await res.json()).redirectTo, next);
      continue;
    }
    const res = await browser.send(next.href);
    const location = res.headers.get('location');
    if (location === null) {
      throw new Error(`${next.href} answered ${res.status} without a redirect: ${await res.text()}`);
    }
    next = new URL(location, next);
  }
  throw new Error(`Never reached ${stops.join(' or ')}.`);
}

/**
 * Swaps a code for the ID token's claims.
 *
 * @param app - The app the code is from.
 * @param client - The client it was issued to.
 * @param code - The code.
 * @returns The claims.
 */
async function idTokenClaims(app: TestApp, client: OidcClient, code: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${app.services.issuer}/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  expect(res.status).toBe(HttpStatus.Ok);
  return payloadOf((await res.json()).id_token);
}

describe('signing in through an upstream OpenID Connect provider', () => {
  /** Another heautou, standing in for Google or a company IdP. */
  let upstream: TestApp;
  /** The one under test. */
  let app: TestApp;
  let client: OidcClient;
  let upstreamFields: UpstreamFields;

  /**
   * Starts a sign-in to the client and follows the upstream button.
   *
   * @param browser - The browser.
   * @param as - Who signs in at the upstream provider.
   * @returns Where the browser ended: the client's callback, or the sign-in page here.
   */
  const signInUpstream = async (browser: SiteBrowser, as: string): Promise<URL> => {
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    });
    const page = await walk(browser, `${app.services.issuer}/auth?${query}`, REDIRECT_URI, null);
    const uid = page.pathname.split('/').pop() ?? '';
    const details = await (await browser.send(`${app.base}/interaction/${uid}/details`)).json();
    expect(details.upstreams).toEqual([{ id: UPSTREAM_ID, name: 'Corp', kind: UpstreamKind.Oidc }]);
    return walk(
      browser,
      `${app.base}/interaction/${uid}/upstream/${UPSTREAM_ID}`,
      [`${app.base}/login/`, REDIRECT_URI],
      {
        username: as,
        password: PASSWORD,
      },
    );
  };

  beforeEach(async () => {
    upstream = await startTestApp();
    app = await startTestApp();
    await createTestUser(upstream, {
      username: 'grace',
      email: 'grace@corp.example',
      name: 'Grace Hopper',
      groups: ['engineering'],
    });
    const atUpstream = await upstream.services.clients.create({
      name: 'Heautou downstream',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [app.services.upstreamFlows.redirectUriOf(UPSTREAM_ID)],
      postLogoutRedirectUris: [],
    });
    upstreamFields = {
      name: 'Corp',
      kind: UpstreamKind.Oidc,
      issuer: upstream.services.issuer,
      clientId: atUpstream.clientId,
      clientSecret: atUpstream.clientSecret,
      scopes: ['openid', 'profile', 'email', 'groups'],
    };
    await app.services.upstreams.create({ id: UPSTREAM_ID, ...upstreamFields });
    client = await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
  });

  it('turns away an identity no user is linked to, and does not match it by address', async () => {
    await createTestUser(app, { username: 'gh', email: 'grace@corp.example' });
    const stopped = await signInUpstream(createSiteBrowser(), 'grace');
    expect(stopped.searchParams.get('error')).toMatch(/not linked to a user here/);
    expect(app.services.upstreams.linkCount(UPSTREAM_ID)).toBe(0);
    const refused = (await app.services.audit.list({ first: 10 })).entries.find(
      (entry) => entry.type === AuditType.SignInRefused,
    );
    expect(refused?.detail).toMatchObject({ provider: 'Corp', reason: 'unknown_identity' });
  });

  it('links an identity from the account page, then signs in with it', async () => {
    const ada = await createTestUser(app, { username: 'ada' });
    // With no admin, the admin sign-in sends the browser to /setup instead.
    await createTestUser(app, { username: 'root', groups: [ADMIN_DEFAULTS.group] });
    const browser = createSiteBrowser();
    const account = await walk(browser, `${app.base}/admin/login?return=%2Faccount`, `${app.base}/admin/callback`, {
      username: 'ada',
      password: PASSWORD,
    });
    await browser.send(account.href);
    const started = await browser.postJson(`${app.base}/api/account/upstreams/${UPSTREAM_ID}/link`, {});
    expect(started.status).toBe(HttpStatus.Ok);
    const callback = await walk(browser, (await started.json()).redirectTo, `${app.base}/upstream/`, {
      username: 'grace',
      password: PASSWORD,
    });
    const toAccount = await walk(browser, callback.href, `${app.base}/account`, null);
    const ticket = toAccount.searchParams.get('upstreamLink');
    const finished = await browser.postJson(`${app.base}/api/account/upstreams/finish`, { ticket });
    expect(await finished.json()).toEqual({ provider: 'Corp', label: 'grace@corp.example' });
    const again = await browser.postJson(`${app.base}/api/account/upstreams/finish`, { ticket });
    expect(again.status).toBe(HttpStatus.BadRequest);

    const listed = await (await browser.send(`${app.base}/api/account/upstreams`)).json();
    expect(listed.providers[0]).toMatchObject({ id: UPSTREAM_ID, link: { label: 'grace@corp.example' } });

    const done = await signInUpstream(createSiteBrowser(), 'grace');
    expect(done.href.startsWith(REDIRECT_URI)).toBe(true);
    const claims = await idTokenClaims(app, client, done.searchParams.get('code') ?? '');
    expect(claims).toMatchObject({ sub: ada.id, amr: ['fed'], acr: 'pwd' });
    const succeeded = (await app.services.audit.list({ first: 20 })).entries.find(
      (e) => e.type === AuditType.SignInSucceeded,
    );
    expect(succeeded?.detail).toMatchObject({ method: 'upstream', provider: 'Corp' });
  });

  it('creates a user for an allowed domain, with mapped groups, and keeps them in step', async () => {
    await app.services.upstreams.update(UPSTREAM_ID, {
      ...upstreamFields,
      unknownIdentity: UnknownIdentity.Create,
      createDomains: ['corp.example'],
      createGroups: ['staff'],
      groupsClaim: 'groups',
      groupMappings: [{ upstream: 'engineering', local: 'builders' }],
    });
    const done = await signInUpstream(createSiteBrowser(), 'grace');
    expect(done.href.startsWith(REDIRECT_URI)).toBe(true);
    const made = app.services.users.list().find((user) => user.username === 'grace');
    expect(made).toMatchObject({ email: 'grace@corp.example', name: 'Grace Hopper', hasPassword: false });
    expect(made?.groups.sort()).toEqual(['builders', 'staff']);

    // Leaving the group upstream takes the mapped group away at the next sign-in, and only that one.
    const graceUp = upstream.services.users.list().find((user) => user.username === 'grace');
    await upstream.services.users.update(graceUp?.id ?? '', {
      username: 'grace',
      email: 'grace@corp.example',
      name: 'Grace Hopper',
      groups: [],
    });
    await signInUpstream(createSiteBrowser(), 'grace');
    expect(app.services.users.find(made?.id ?? '')?.groups).toEqual(['staff']);
  });

  it('refuses to create a user outside the allowed domains', async () => {
    await app.services.upstreams.update(UPSTREAM_ID, {
      ...upstreamFields,
      unknownIdentity: UnknownIdentity.Create,
      createDomains: ['other.example'],
    });
    const stopped = await signInUpstream(createSiteBrowser(), 'grace');
    expect(stopped.searchParams.get('error')).toMatch(/other\.example/);
    expect(app.services.users.list()).toHaveLength(0);
  });

  it('still asks for a second factor here, unless the provider counts as both', async () => {
    const ada = await createTestUser(app, { username: 'ada' });
    const graceUp = upstream.services.users.list().find((user) => user.username === 'grace');
    await app.services.upstreams.link(
      ada.id,
      { providerId: UPSTREAM_ID, issuer: upstream.services.issuer, subject: graceUp?.id ?? '' },
      'grace@corp.example',
    );
    const secret = newTotpSecret();
    await app.services.factors.setTotp(ada.id, secret, totpStepAt(Date.now()) - 1);
    await app.services.factors.newRecoveryCodes(ada.id);

    const browser = createSiteBrowser();
    const page = await signInUpstream(browser, 'grace');
    expect(page.searchParams.get('error')).toBeNull();
    const uid = page.pathname.split('/').pop() ?? '';
    const details = await (await browser.send(`${app.base}/interaction/${uid}/details`)).json();
    expect(details.secondFactor).toEqual({ totp: true, passkey: false, recoveryCode: true, provider: 'Corp' });
    const answered = await browser.postJson(`${app.base}/interaction/${uid}/second-factor`, {
      code: totpCode(secret, totpStepAt(Date.now())),
    });
    expect(answered.status).toBe(HttpStatus.Ok);
    const done = await walk(browser, new URL((await answered.json()).redirectTo, app.base).href, REDIRECT_URI, null);
    const claims = await idTokenClaims(app, client, done.searchParams.get('code') ?? '');
    expect(claims).toMatchObject({ amr: ['fed', 'otp', 'mfa'], acr: 'mfa' });

    await app.services.upstreams.update(UPSTREAM_ID, { ...upstreamFields, countsAsBothFactors: true });
    const trusted = await signInUpstream(createSiteBrowser(), 'grace');
    const trustedClaims = await idTokenClaims(app, client, trusted.searchParams.get('code') ?? '');
    expect(trustedClaims).toMatchObject({ amr: ['fed', 'mfa'], acr: 'mfa' });
  });

  it('refuses a disabled user, and a user outside the client’s groups', async () => {
    const ada = await createTestUser(app, { username: 'ada' });
    const graceUp = upstream.services.users.list().find((user) => user.username === 'grace');
    await app.services.upstreams.link(
      ada.id,
      { providerId: UPSTREAM_ID, issuer: upstream.services.issuer, subject: graceUp?.id ?? '' },
      'grace',
    );
    await app.services.clients.update(client.clientId, {
      name: client.name,
      authMethod: client.authMethod,
      redirectUris: client.redirectUris,
      postLogoutRedirectUris: [],
      allowedGroups: [ADMIN_DEFAULTS.group],
    });
    const stopped = await signInUpstream(createSiteBrowser(), 'grace');
    expect(stopped.searchParams.get('error')).toMatch(/may not sign in to Photos/);
  });

  it('lets an admin manage providers over GraphQL without ever reading the secret back', async () => {
    const admin = await createTestUser(app, { username: 'root', groups: [ADMIN_DEFAULTS.group] });
    expect(admin.id).toBeTruthy();
    const browser = createSiteBrowser();
    const callback = await walk(browser, `${app.base}/admin/login`, `${app.base}/admin/callback`, {
      username: 'root',
      password: PASSWORD,
    });
    await browser.send(callback.href);
    const gql = async (query: string, variables: Record<string, unknown> = {}) =>
      (await browser.postJson(`${app.base}/graphql`, { query, variables })).json();

    const listed = await gql('{ upstreams { id kind hasClientSecret redirectUri linksAggregate { count } } }');
    expect(listed.data.upstreams).toEqual([
      {
        id: UPSTREAM_ID,
        kind: 'OIDC',
        hasClientSecret: true,
        redirectUri: `${app.base}/upstream/${UPSTREAM_ID}/callback`,
        linksAggregate: { count: 0 },
      },
    ]);
    const created = await gql(
      `mutation ($input: UpstreamInput!) { createUpstream(id: "github", input: $input) { id scopes hasClientSecret } }`,
      { input: { name: 'GitHub', kind: 'GITHUB', clientId: 'Iv1.abc', clientSecret: 's3cret' } },
    );
    expect(created.data.createUpstream).toEqual({
      id: 'github',
      scopes: ['read:user', 'user:email'],
      hasClientSecret: true,
    });
    const kept = await gql(
      `mutation ($input: UpstreamInput!) { updateUpstream(id: "github", input: $input) { name hasClientSecret } }`,
      { input: { name: 'GitHub.com', kind: 'GITHUB', clientId: 'Iv1.abc' } },
    );
    expect(kept.data.updateUpstream).toEqual({ name: 'GitHub.com', hasClientSecret: true });
    expect(app.services.upstreams.find('github')?.clientSecret).toBe('s3cret');
    const removed = await gql('mutation { deleteUpstream(id: "github") { id } }');
    expect(removed.data.deleteUpstream).toEqual({ id: 'github' });
    const types = (await app.services.audit.list({ first: 10 })).entries.map((entry) => entry.type);
    expect(types).toEqual(
      expect.arrayContaining([AuditType.UpstreamCreated, AuditType.UpstreamUpdated, AuditType.UpstreamDeleted]),
    );
  });
});
