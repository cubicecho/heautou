import { ADMIN_DEFAULTS, TWO_FACTOR_DEFAULTS } from '../../server/core/defaults.ts';
import { totpCode, totpStepAt } from '../../server/core/totp.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod, type OidcClient } from '../../server/store/clients.ts';
import {
  adminGql,
  type Browser,
  basicAuth,
  createBrowser,
  PASSWORD,
  payloadOf,
  postJson,
  REDIRECT_URI,
  type SecondFactorAnswer,
  signIn,
  signInAsAdmin,
  signInToWebApp,
} from '../browser.ts';
import { createTestUser, startTestApp, type TestApp } from '../helpers.ts';
import { createSoftwareAuthenticator, withTotp } from './authenticator.ts';

/**
 * Signs a user in to a client and swaps the code for an ID token.
 *
 * @param app - The running app.
 * @param client - The client.
 * @param username - Who signs in.
 * @param [secondFactor] - Answers the second factor.
 * @returns The ID token's claims.
 */
async function idTokenFor(
  app: TestApp,
  client: OidcClient,
  username: string,
  secondFactor?: SecondFactorAnswer,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
  });
  const browser = createBrowser(app.base);
  const callback = await signIn(app, `/oidc/auth?${query}`, username, PASSWORD, browser, REDIRECT_URI, secondFactor);
  const tokenRes = await fetch(`${app.services.issuer}/token`, {
    method: 'POST',
    headers: { authorization: basicAuth(client), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT_URI,
    }),
  });
  expect(tokenRes.status).toBe(HttpStatus.Ok);
  return payloadOf((await tokenRes.json()).id_token);
}

/**
 * Starts a sign-in to a client and stops at the sign-in page.
 *
 * @param app - The running app.
 * @param client - The client.
 * @returns The browser and the interaction's uid.
 */
async function startSignIn(app: TestApp, client: OidcClient): Promise<{ browser: Browser; uid: string }> {
  const browser = createBrowser(app.base);
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
  });
  let location = (await browser.send(`/oidc/auth?${query}`)).headers.get('location') ?? '';
  location = (await browser.send(location)).headers.get('location') ?? '';
  return { browser, uid: location.split('/').pop() ?? '' };
}

/**
 * Sets up an authenticator app from the account page.
 *
 * @param browser - The user's account browser.
 * @returns The secret and the recovery codes the server handed back.
 */
async function enrolTotp(browser: Browser): Promise<{ secret: string; recoveryCodes: string[] }> {
  const { secret } = await (await postJson(browser, '/api/account/totp/start', {})).json();
  // The step before now, so the code the sign-in uses next is a later one.
  const code = totpCode(secret, totpStepAt(Date.now()) - 1);
  const confirmed = await postJson(browser, '/api/account/totp/confirm', { code });
  expect(confirmed.status).toBe(HttpStatus.Ok);
  return { secret, recoveryCodes: (await confirmed.json()).recoveryCodes };
}

describe('two-factor sign-in', () => {
  let app: TestApp;
  let client: OidcClient;
  let adaId: string;

  beforeEach(async () => {
    app = await startTestApp();
    await createTestUser(app, { username: 'root', groups: [ADMIN_DEFAULTS.group] });
    adaId = (await createTestUser(app, { username: 'ada', name: 'Ada', groups: ['family'] })).id;
    client = await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterEach(() => app.close());

  it('says a password alone was used when the user has no second factor', async () => {
    const claims = await idTokenFor(app, client, 'ada');
    expect(claims).toMatchObject({ amr: ['pwd'], acr: 'pwd' });
  });

  it('asks for the authenticator code after the password, and says so in the token', async () => {
    const { secret, recoveryCodes } = await enrolTotp((await signInToWebApp(app, 'ada')).browser);
    expect(recoveryCodes).toHaveLength(TWO_FACTOR_DEFAULTS.recoveryCodeCount);

    const { browser, uid } = await startSignIn(app, client);
    const login = await postJson(browser, `/interaction/${uid}/login`, { username: 'ada', password: PASSWORD });
    expect(await login.json()).toEqual({ secondFactor: { totp: true, passkey: false, recoveryCode: true } });
    const wrong = await postJson(browser, `/interaction/${uid}/second-factor`, { code: '000000' });
    expect(wrong.status).toBe(HttpStatus.Unauthorized);
    expect((await app.services.audit.list({ types: [AuditType.SecondFactorFailed] })).entries).toHaveLength(1);

    const claims = await idTokenFor(app, client, 'ada', withTotp(secret));
    expect(claims).toMatchObject({ amr: ['pwd', 'otp', 'mfa'], acr: 'mfa' });
    expect((await app.services.audit.list({ types: [AuditType.SignInSucceeded] })).entries[0]?.detail).toEqual({
      method: 'password_totp',
    });
  });

  it('takes a recovery code once', async () => {
    const { recoveryCodes } = await enrolTotp((await signInToWebApp(app, 'ada')).browser);
    const [code = ''] = recoveryCodes;
    const withRecovery: SecondFactorAnswer = (uid, browser) =>
      postJson(browser, `/interaction/${uid}/second-factor`, { code });
    await expect(idTokenFor(app, client, 'ada', withRecovery)).resolves.toMatchObject({ acr: 'mfa' });
    await expect(idTokenFor(app, client, 'ada', withRecovery)).rejects.toThrow();
  });

  it('makes the sign-in start again after too many wrong codes', async () => {
    await enrolTotp((await signInToWebApp(app, 'ada')).browser);
    const { browser, uid } = await startSignIn(app, client);
    await postJson(browser, `/interaction/${uid}/login`, { username: 'ada', password: PASSWORD });
    let last: Response | null = null;
    for (let attempt = 0; attempt < TWO_FACTOR_DEFAULTS.maxAttempts; attempt += 1) {
      last = await postJson(browser, `/interaction/${uid}/second-factor`, { code: '000000' });
    }
    expect(await last?.json()).toMatchObject({ restart: true });
    const after = await postJson(browser, `/interaction/${uid}/second-factor`, { code: '000000' });
    expect(await after.json()).toMatchObject({ restart: true });
  });

  it('needs the password to remove the authenticator app', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    await enrolTotp(browser);
    const refused = await postJson(browser, '/api/account/totp/remove', { password: 'wrong' });
    expect(refused.status).toBe(HttpStatus.Forbidden);
    const removed = await postJson(browser, '/api/account/totp/remove', { password: PASSWORD });
    expect(await removed.json()).toEqual({ hasTotp: false, recoveryCodesLeft: 0, passkeys: [] });
  });

  it('registers a passkey, and signs in with it after the password or on its own', async () => {
    const authenticator = createSoftwareAuthenticator(app.base);
    const { browser: account } = await signInToWebApp(app, 'ada');
    const { options } = await (await postJson(account, '/api/account/passkeys/options', {})).json();
    const added = await postJson(account, '/api/account/passkeys', {
      name: 'Laptop',
      response: authenticator.create(options),
    });
    expect(added.status).toBe(HttpStatus.Ok);
    expect((await added.json()).recoveryCodes).toHaveLength(TWO_FACTOR_DEFAULTS.recoveryCodeCount);

    const withPasskey: SecondFactorAnswer = async (uid, browser) => {
      const asked = await (await postJson(browser, `/interaction/${uid}/passkey/options`, {})).json();
      expect(asked.options.allowCredentials).toEqual([
        { id: authenticator.id, type: 'public-key', transports: ['internal'] },
      ]);
      return postJson(browser, `/interaction/${uid}/passkey`, { response: authenticator.get(asked.options, false) });
    };
    await expect(idTokenFor(app, client, 'ada', withPasskey)).resolves.toMatchObject({
      amr: ['pwd', 'hwk', 'mfa'],
    });

    const { browser, uid } = await startSignIn(app, client);
    const asked = await (await postJson(browser, `/interaction/${uid}/passkey/options`, {})).json();
    expect(asked.options.allowCredentials).toBeUndefined();
    expect(asked.options.userVerification).toBe('required');
    const answered = await postJson(browser, `/interaction/${uid}/passkey`, {
      response: authenticator.get(asked.options),
    });
    expect(answered.status).toBe(HttpStatus.Ok);
    const { redirectTo } = await answered.json();
    expect(redirectTo).toContain(`/oidc/auth/${uid}`);
    expect(app.services.factors.passkeysOf(adaId)[0]?.lastUsedAt).not.toBeNull();
  });

  it('refuses a passkey alone when it did not check the user, or its user is disabled', async () => {
    const authenticator = createSoftwareAuthenticator(app.base);
    const { browser: account } = await signInToWebApp(app, 'ada');
    const { options } = await (await postJson(account, '/api/account/passkeys/options', {})).json();
    await postJson(account, '/api/account/passkeys', { name: 'Key', response: authenticator.create(options) });

    const tryAlone = async (userVerified: boolean): Promise<Response> => {
      const { browser, uid } = await startSignIn(app, client);
      const asked = await (await postJson(browser, `/interaction/${uid}/passkey/options`, {})).json();
      return postJson(browser, `/interaction/${uid}/passkey`, {
        response: authenticator.get(asked.options, userVerified),
      });
    };
    expect((await tryAlone(false)).status).toBe(HttpStatus.Unauthorized);
    await signInAsAdmin(app);
    await app.services.users.setDisabled(adaId, true);
    expect((await tryAlone(true)).status).toBe(HttpStatus.Forbidden);
  });

  it('refuses another user’s passkey after the password', async () => {
    const theirs = createSoftwareAuthenticator(app.base);
    await createTestUser(app, { username: 'bob' });
    const { browser: bob } = await signInToWebApp(app, 'bob');
    const { options } = await (await postJson(bob, '/api/account/passkeys/options', {})).json();
    await postJson(bob, '/api/account/passkeys', { name: 'Bob’s', response: theirs.create(options) });
    await enrolTotp((await signInToWebApp(app, 'ada')).browser);

    const { browser, uid } = await startSignIn(app, client);
    await postJson(browser, `/interaction/${uid}/login`, { username: 'ada', password: PASSWORD });
    const asked = await (await postJson(browser, `/interaction/${uid}/passkey/options`, {})).json();
    const answered = await postJson(browser, `/interaction/${uid}/passkey`, { response: theirs.get(asked.options) });
    expect(answered.status).toBe(HttpStatus.Unauthorized);
  });

  it('lets an admin see and reset a user’s second factors', async () => {
    await enrolTotp((await signInToWebApp(app, 'ada')).browser);
    const admin = await signInAsAdmin(app);
    const shown = await adminGql(
      admin,
      'query($id: String!) { user(where: { id: { eq: $id } }) { secondFactors { hasTotp recoveryCodesLeft passkeyCount } } }',
      { id: adaId },
    );
    expect(shown.data.user.secondFactors).toEqual({ hasTotp: true, recoveryCodesLeft: 10, passkeyCount: 0 });
    const reset = await adminGql(
      admin,
      'mutation($id: ID!) { resetSecondFactors(id: $id) { secondFactors { hasTotp } } }',
      { id: adaId },
    );
    expect(reset.data.resetSecondFactors.secondFactors.hasTotp).toBe(false);
    await expect(idTokenFor(app, client, 'ada')).resolves.toMatchObject({ acr: 'pwd' });
    expect((await app.services.audit.list({ types: [AuditType.UserSecondFactorsReset] })).entries).toHaveLength(1);
  });
});
