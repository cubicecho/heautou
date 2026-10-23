import { HttpStatus } from '../../server/core/wire.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import { UnknownIdentity, UpstreamKind } from '../../server/store/upstreams.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { createBrowser, REDIRECT_URI } from '../oidc/browser.ts';

const GITHUB_USER = { id: 583231, login: 'octocat', name: 'The Octocat' };

/**
 * Answers as GitHub's token endpoint and API do, for the one code it hands out.
 *
 * @param seen - Collects each request's URL, method and body.
 * @returns The fetch.
 */
function fakeGitHub(seen: { url: string; body: string }[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push({ url, body: String(init?.body ?? '') });
    const json = (body: unknown, status: number = HttpStatus.Ok): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://github.com/login/oauth/access_token') {
      const params = new URLSearchParams(String(init?.body ?? ''));
      return params.get('code') === 'good-code'
        ? json({ access_token: 'gho_token', token_type: 'bearer', scope: 'read:user,user:email' })
        : json({ error: 'bad_verification_code' }, HttpStatus.BadRequest);
    }
    if (url === 'https://api.github.com/user') {
      return json(GITHUB_USER);
    }
    if (url === 'https://api.github.com/user/emails') {
      return json([
        { email: 'old@example.com', primary: false, verified: true },
        { email: 'octo@example.com', primary: true, verified: true },
      ]);
    }
    return json({ message: 'Not Found' }, HttpStatus.NotFound);
  };
}

describe('signing in with GitHub', () => {
  let app: TestApp;
  let client: OidcClient;
  let seen: { url: string; body: string }[];

  /**
   * Starts a sign-in and follows the GitHub button to GitHub's authorize URL.
   *
   * @returns The browser, the interaction and the authorize URL.
   */
  const toGitHub = async () => {
    const browser = createBrowser(app.base);
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    });
    let location = (await browser.send(`/oidc/auth?${query}`)).headers.get('location') ?? '';
    location = (await browser.send(location)).headers.get('location') ?? '';
    const uid = location.split('/').pop() ?? '';
    const res = await browser.send(`/interaction/${uid}/upstream/github`);
    expect(res.status).toBe(HttpStatus.SeeOther);
    return { browser, uid, authorize: new URL(res.headers.get('location') ?? '') };
  };

  beforeEach(async () => {
    seen = [];
    app = await startTestApp({ fetchUpstream: fakeGitHub(seen) });
    await app.services.upstreams.create({
      id: 'github',
      name: 'GitHub',
      kind: UpstreamKind.GitHub,
      clientId: 'Iv1.client',
      clientSecret: 'gh-secret',
      unknownIdentity: UnknownIdentity.Create,
    });
    client = await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterEach(() => app.close());

  it('sends the browser to GitHub with PKCE and a state, and signs the account in from its API', async () => {
    const { browser, uid, authorize } = await toGitHub();
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'Iv1.client',
      redirect_uri: `${app.base}/upstream/github/callback`,
      scope: 'read:user user:email',
      code_challenge_method: 'S256',
    });
    expect(authorize.searchParams.get('nonce')).toBeNull();
    const state = authorize.searchParams.get('state') ?? '';

    const back = await browser.send(`/upstream/github/callback?code=good-code&state=${state}`);
    expect(back.headers.get('location')).toBe(`/interaction/${uid}/upstream-return`);
    const done = await browser.send(back.headers.get('location') ?? '');
    expect(done.status).toBe(HttpStatus.SeeOther);
    expect(done.headers.get('location')).toMatch(/\/oidc\/auth\//);

    const token = seen.find((request) => request.url.endsWith('/access_token'));
    expect(new URLSearchParams(token?.body).get('code_verifier')).toBeTruthy();
    const made = app.services.users.list().find((user) => user.username === 'octocat');
    expect(made).toMatchObject({ email: 'octo@example.com', name: 'The Octocat' });
    expect(app.services.upstreams.linksOf(made?.id ?? '')).toEqual([
      expect.objectContaining({ subject: String(GITHUB_USER.id), issuer: 'https://github.com', label: 'octocat' }),
    ]);

    // The state works once.
    const replay = await browser.send(`/upstream/github/callback?code=good-code&state=${state}`);
    expect(replay.status).toBe(HttpStatus.BadRequest);
  });

  it('turns back a forged state, and a code GitHub refuses', async () => {
    const { browser, uid, authorize } = await toGitHub();
    const forged = await browser.send('/upstream/github/callback?code=good-code&state=not-the-one');
    expect(forged.status).toBe(HttpStatus.BadRequest);

    const state = authorize.searchParams.get('state') ?? '';
    const back = await browser.send(`/upstream/github/callback?code=bad-code&state=${state}`);
    const page = await browser.send(back.headers.get('location') ?? '');
    const login = new URL(page.headers.get('location') ?? '', app.base);
    expect(login.pathname).toBe(`/login/${uid}`);
    expect(login.searchParams.get('error')).toMatch(/Signing in with GitHub did not work/);
    expect(app.services.users.list()).toHaveLength(0);
  });

  it('tells the user when they cancelled at GitHub', async () => {
    const { browser, authorize } = await toGitHub();
    const state = authorize.searchParams.get('state') ?? '';
    const back = await browser.send(`/upstream/github/callback?error=access_denied&state=${state}`);
    const page = await browser.send(back.headers.get('location') ?? '');
    expect(new URL(page.headers.get('location') ?? '', app.base).searchParams.get('error')).toMatch(
      /GitHub did not sign you in: access_denied/,
    );
  });
});
