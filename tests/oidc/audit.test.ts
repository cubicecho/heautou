import { KEY_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType, actorOf } from '../../server/store/audit.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import {
  adminGql,
  adminSubscribe,
  type Browser,
  basicAuth,
  createBrowser,
  PASSWORD,
  REDIRECT_URI,
  signIn,
  signInAsAdmin,
  signInForTokens,
} from './browser.ts';

/** One day, in milliseconds. */
const DAY_MS = 86_400_000;

const AUDIT_LOG = /* GraphQL */ `
  query ($limit: Int, $after: String, $where: AuditEntryFilters) {
    auditEntries(limit: $limit, after: $after, where: $where) {
      type
      actorUserId
      actorUsername
      ip
      targetKind
      targetId
      targetName
      detail
      cursor
    }
  }
`;

describe('the audit log', () => {
  let app: TestApp;
  let admin: Browser;
  let client: { clientId: string; clientSecret: string | null };

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
    await app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
    client = await app.services.clients.create({
      name: 'Test app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
  });

  afterAll(() => app.close());

  /**
   * Reads every entry as the log holds it, newest first.
   *
   * @returns The entries, and all of them as one string to search for secrets.
   */
  const everything = async () => {
    const { entries } = await app.services.audit.list({ first: 200 });
    return { entries, text: JSON.stringify(entries) };
  };

  /**
   * Builds an authorize path for the test client.
   *
   * @returns The path and query.
   */
  const authorizePath = (): string =>
    `/oidc/auth?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
    })}`;

  it('records a sign-in through the code flow against its client, with no secrets', async () => {
    const tokens = await signInForTokens(app, client, 'ada', 'openid');
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    const { entries, text } = await everything();
    expect(entries.slice(0, 2)).toMatchObject([
      {
        type: AuditType.AppSignedIn,
        actor: { userId: ada?.id, username: 'ada' },
        target: { kind: 'client', id: client.clientId, name: 'Test app' },
        detail: { via: 'password', redirectUri: REDIRECT_URI },
      },
      {
        type: AuditType.SignInSucceeded,
        actor: { userId: ada?.id, username: 'ada' },
        ip: expect.any(String),
        target: { kind: 'client', id: client.clientId, name: 'Test app' },
      },
    ]);
    for (const secret of [PASSWORD, client.clientSecret ?? '', tokens.access_token, tokens.id_token]) {
      expect(text).not.toContain(secret);
    }
  });

  it('records an app sign-in that reused the session, with where the browser was sent', async () => {
    const browser = createBrowser(app.base);
    await signIn(app, authorizePath(), 'ada', PASSWORD, browser);
    const before = (await everything()).entries.length;
    const callback = await signIn(app, authorizePath(), 'ada', 'never asked', browser);
    expect(callback.searchParams.get('code')).toEqual(expect.any(String));
    const { entries } = await everything();
    expect(entries.length).toBe(before + 1);
    expect(entries[0]).toMatchObject({
      type: AuditType.AppSignedIn,
      actor: { username: 'ada' },
      target: { id: client.clientId },
      detail: { via: 'session', redirectUri: REDIRECT_URI },
    });
    // The admin UI's own sign-ins are WebSignedIn, not app sign-ins.
    expect(entries.some((entry) => entry.type === AuditType.AppSignedIn && entry.target?.id === 'heautou-admin')).toBe(
      false,
    );
  });

  it('records a sign-in request or token request the provider refused, but not a silent session check', async () => {
    const browser = createBrowser(app.base);
    const wrongRedirect = `/oidc/auth?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: 'http://elsewhere.example/callback',
      response_type: 'code',
      scope: 'openid',
    })}`;
    await browser.send(wrongRedirect);
    expect((await everything()).entries[0]).toMatchObject({
      type: AuditType.AppSignInFailed,
      target: { id: client.clientId, name: 'Test app' },
      detail: { error: 'invalid_redirect_uri', redirectUri: 'http://elsewhere.example/callback' },
    });

    const before = (await everything()).entries.length;
    const res = await browser.send(`${authorizePath()}&prompt=none`);
    expect(res.headers.get('location')).toContain('error=login_required');
    expect((await everything()).entries.length).toBe(before);

    const tokenRes = await fetch(`${app.services.issuer}/token`, {
      method: 'POST',
      headers: {
        authorization: basicAuth({ ...client, clientSecret: 'not-the-secret' }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'made-up', redirect_uri: REDIRECT_URI }),
    });
    expect(tokenRes.status).toBe(HttpStatus.Unauthorized);
    const { entries, text } = await everything();
    expect(entries[0]).toMatchObject({
      type: AuditType.AppTokenRefused,
      actor: null,
      target: { id: client.clientId },
      detail: { error: 'invalid_client', grantType: 'authorization_code' },
    });
    expect(text).not.toContain('not-the-secret');
  });

  it('records keys rotated at boot once they are due', async () => {
    let time = Date.now();
    const now = () => time;
    const first = await startTestApp({ now });
    try {
      expect((await first.services.audit.list({ types: [AuditType.KeysRotated] })).entries).toEqual([]);
      time += (KEY_DEFAULTS.rotationDays + 1) * DAY_MS;
      const reopened = await startTestApp({ database: first.database, now });
      try {
        expect((await reopened.services.audit.list({ types: [AuditType.KeysRotated] })).entries).toMatchObject([
          { actor: null, target: { kind: 'keys' }, detail: { reason: 'scheduled' } },
        ]);
      } finally {
        await reopened.close();
      }
    } finally {
      await first.close();
    }
  });

  it('streams new entries to a subscription, filtered the way the log is', async () => {
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    const subscription = /* GraphQL */ `
      subscription ($type: AuditType, $userId: ID) {
        auditEntryAdded(type: $type, userId: $userId) { type actorUsername targetName }
      }
    `;
    const all = await adminSubscribe(admin, subscription);
    const failures = await adminSubscribe(admin, subscription, { type: 'SIGN_IN_FAILED', userId: ada?.id });
    expect(all.res.status).toBe(HttpStatus.Ok);
    expect(all.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    try {
      await signInForTokens(app, client, 'ada', 'openid');
      await expect(signIn(app, authorizePath(), 'ada', 'wrong horse')).rejects.toThrow();
      expect((await all.subscription.next())?.data?.auditEntryAdded).toEqual({
        type: 'SIGN_IN_SUCCEEDED',
        actorUsername: 'ada',
        targetName: 'Test app',
      });
      expect((await all.subscription.next())?.data?.auditEntryAdded).toMatchObject({ type: 'APP_SIGNED_IN' });
      expect((await failures.subscription.next())?.data?.auditEntryAdded).toMatchObject({ type: 'SIGN_IN_FAILED' });
    } finally {
      all.subscription.close();
      failures.subscription.close();
    }
    const anonymous = await adminSubscribe(createBrowser(app.base), subscription);
    expect(anonymous.res.status).toBe(HttpStatus.Unauthorized);
  });

  it('records a failed sign-in, by the account it named or by the username typed', async () => {
    await expect(signIn(app, authorizePath(), 'ada', 'wrong horse')).rejects.toMatchObject({
      actual: HttpStatus.Unauthorized,
    });
    expect((await everything()).entries[0]).toMatchObject({
      type: AuditType.SignInFailed,
      actor: { username: 'ada' },
      target: { id: client.clientId },
    });
    await expect(signIn(app, authorizePath(), 'nobody', 'guess one')).rejects.toMatchObject({
      actual: HttpStatus.Unauthorized,
    });
    const { entries, text } = await everything();
    expect(entries[0]).toMatchObject({ type: AuditType.SignInFailed, actor: null, detail: { username: 'nobody' } });
    expect(text).not.toContain('wrong horse');
    expect(text).not.toContain('guess one');
  });

  it('records a mutation with the admin who made it, and never the secret or link it returns', async () => {
    const created = await adminGql(
      admin,
      `mutation ($input: NewClientInput!) { createClient(input: $input) { clientId clientSecret } }`,
      {
        input: {
          name: 'Audited',
          authMethod: 'CLIENT_SECRET_BASIC',
          redirectUris: [REDIRECT_URI],
          postLogoutRedirectUris: [],
        },
      },
    );
    const { clientId, clientSecret } = created.data.createClient;
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    const link = await adminGql(admin, 'mutation ($id: ID!) { createPasswordLink(id: $id) { url } }', { id: ada?.id });
    const { url } = link.data.createPasswordLink;

    const { data } = await adminGql(admin, AUDIT_LOG, { limit: 2 });
    expect(data.auditEntries).toMatchObject([
      { type: 'PASSWORD_LINK_CREATED', actorUsername: 'root', targetKind: 'USER', targetName: 'ada' },
      {
        type: 'CLIENT_CREATED',
        actorUsername: 'root',
        targetKind: 'CLIENT',
        targetId: clientId,
        targetName: 'Audited',
      },
    ]);
    const { text } = await everything();
    expect(text).not.toContain(clientSecret);
    expect(text).not.toContain(new URL(url).hash.slice(1));
  });

  it('filters by type and by user, a page at a time', async () => {
    const grace = await app.services.users.create({
      username: 'grace',
      password: PASSWORD,
      email: '',
      name: '',
      groups: [],
    });
    const actor = actorOf(grace);
    app.services.audit.record({ type: AuditType.SignInFailed, actor, ip: null });
    app.services.audit.record({ type: AuditType.SignInFailed, actor, ip: null });
    app.services.audit.record({ type: AuditType.SignInSucceeded, actor, ip: null });
    await app.services.audit.settled();
    const byGrace = {
      OR: [{ actorUserId: { eq: grace.id } }, { targetKind: { eq: 'USER' }, targetId: { eq: grace.id } }],
    };
    const failed = await adminGql(admin, AUDIT_LOG, { where: { ...byGrace, type: { eq: 'SIGN_IN_FAILED' } } });
    expect(failed.data.auditEntries.map((entry: { type: string }) => entry.type)).toEqual([
      'SIGN_IN_FAILED',
      'SIGN_IN_FAILED',
    ]);
    const first = await adminGql(admin, AUDIT_LOG, { where: byGrace, limit: 1 });
    expect(first.data.auditEntries).toHaveLength(1);
    const [firstEntry] = first.data.auditEntries;
    expect(firstEntry.cursor).toEqual(expect.any(String));
    const next = await adminGql(admin, AUDIT_LOG, { where: byGrace, limit: 1, after: firstEntry.cursor });
    expect(next.data.auditEntries).toHaveLength(1);
    expect(next.data.auditEntries[0]).not.toEqual(firstEntry);
  });

  it('is only for admins', async () => {
    const anonymous = await createBrowser(app.base).send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: AUDIT_LOG }),
    });
    expect(anonymous.status).toBe(HttpStatus.Unauthorized);
    const user = await signInAsAdmin(app, 'ada');
    const refused = await user.send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: AUDIT_LOG }),
    });
    expect(refused.status).toBe(HttpStatus.Forbidden);
  });

  it('shows a user their own recent sign-ins on their account page', async () => {
    const ada = await signInAsAdmin(app, 'ada');
    const res = await ada.send('/api/account/activity');
    expect(res.status).toBe(HttpStatus.Ok);
    const { entries } = await res.json();
    expect(entries[0]).toMatchObject({ type: AuditType.WebSignedIn, clientName: null });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: AuditType.AppSignedIn, clientName: 'Test app' }),
        expect.objectContaining({ type: AuditType.SignInFailed, clientName: 'Test app' }),
      ]),
    );
    expect(entries.some((entry: { type: string }) => entry.type === AuditType.PasswordLinkCreated)).toBe(false);
    expect(entries.some((entry: { type: string }) => entry.type === AuditType.SignInSucceeded)).toBe(false);
    expect((await createBrowser(app.base).send('/api/account/activity')).status).toBe(HttpStatus.Unauthorized);
  });
});
