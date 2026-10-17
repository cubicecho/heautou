import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import {
  adminGql,
  type Browser,
  createBrowser,
  PASSWORD,
  REDIRECT_URI,
  signIn,
  signInAsAdmin,
  signInForTokens,
} from './browser.ts';

const AUDIT_LOG = /* GraphQL */ `
  query ($first: Int, $after: String, $type: AuditType, $userId: ID) {
    auditLog(first: $first, after: $after, type: $type, userId: $userId) {
      entries {
        type
        actor { userId username }
        ip
        target { kind id name }
        detail { name value }
      }
      nextCursor
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
   * Reads every entry as the file holds it, newest first.
   *
   * @returns The entries, and all of them as one string to search for secrets.
   */
  const everything = () => {
    const { entries } = app.services.audit.list({ first: 200 });
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
    const { entries, text } = everything();
    expect(entries[0]).toMatchObject({
      type: AuditType.SignInSucceeded,
      actor: { userId: ada?.id, username: 'ada' },
      ip: expect.any(String),
      target: { kind: 'client', id: client.clientId, name: 'Test app' },
    });
    for (const secret of [PASSWORD, client.clientSecret ?? '', tokens.access_token, tokens.id_token]) {
      expect(text).not.toContain(secret);
    }
  });

  it('records a failed sign-in, by the account it named or by the username typed', async () => {
    await expect(signIn(app, authorizePath(), 'ada', 'wrong horse')).rejects.toThrow(/expected 401 to be 200/);
    expect(everything().entries[0]).toMatchObject({
      type: AuditType.SignInFailed,
      actor: { username: 'ada' },
      target: { id: client.clientId },
    });
    await expect(signIn(app, authorizePath(), 'nobody', 'guess one')).rejects.toThrow(/expected 401 to be 200/);
    const { entries, text } = everything();
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

    const { data } = await adminGql(admin, AUDIT_LOG, { first: 2 });
    expect(data.auditLog.entries).toMatchObject([
      { type: 'PASSWORD_LINK_CREATED', actor: { username: 'root' }, target: { kind: 'USER', name: 'ada' } },
      {
        type: 'CLIENT_CREATED',
        actor: { username: 'root' },
        target: { kind: 'CLIENT', id: clientId, name: 'Audited' },
      },
    ]);
    const { text } = everything();
    expect(text).not.toContain(clientSecret);
    expect(text).not.toContain(new URL(url).hash.slice(1));
  });

  it('filters by type and by user, a page at a time', async () => {
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    const failed = await adminGql(admin, AUDIT_LOG, { type: 'SIGN_IN_FAILED' });
    expect(failed.data.auditLog.entries.map((entry: { type: string }) => entry.type)).toEqual([
      'SIGN_IN_FAILED',
      'SIGN_IN_FAILED',
    ]);
    const first = await adminGql(admin, AUDIT_LOG, { userId: ada?.id, first: 1 });
    expect(first.data.auditLog.entries).toHaveLength(1);
    expect(first.data.auditLog.nextCursor).toEqual(expect.any(String));
    const next = await adminGql(admin, AUDIT_LOG, { userId: ada?.id, first: 1, after: first.data.auditLog.nextCursor });
    expect(next.data.auditLog.entries[0]).not.toEqual(first.data.auditLog.entries[0]);
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
    const res = await ada.send('/admin/account/activity');
    expect(res.status).toBe(HttpStatus.Ok);
    const { entries } = await res.json();
    expect(entries[0]).toMatchObject({ type: AuditType.WebSignedIn, clientName: null });
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: AuditType.SignInSucceeded, clientName: 'Test app' }),
        expect.objectContaining({ type: AuditType.SignInFailed, clientName: 'Test app' }),
      ]),
    );
    expect(entries.some((entry: { type: string }) => entry.type === AuditType.PasswordLinkCreated)).toBe(false);
    expect((await createBrowser(app.base).send('/admin/account/activity')).status).toBe(HttpStatus.Unauthorized);
  });
});
