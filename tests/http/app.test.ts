import { PASSWORD_RULE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { MAX_PASSWORD_SCORE } from '../../server/store/settings.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, signInAsAdmin } from '../oidc/browser.ts';

const CLIENT_FIELDS = '{ clientId name clientSecret authMethod redirectUris }';
const CREATE_USER = 'mutation ($input: NewUserInput!) { createUser(input: $input) { id } }';
const SET_PASSWORD = 'mutation ($id: ID!, $password: String!) { setUserPassword(id: $id, password: $password) { id } }';
const SET_RULES = `mutation ($minScore: Int, $checkBreaches: Boolean) {
  setPasswordRules(minScore: $minScore, checkBreaches: $checkBreaches) { minScore checkBreaches }
}`;
/** Scores 3: enough for the default rule, not for the strictest. */
const HARD = 'correct horse';

describe('app', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  const gql = (query: string, variables: Record<string, unknown> = {}) => adminGql(admin, query, variables);

  it('answers health checks', async () => {
    const res = await fetch(`${app.base}/healthz`);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) });
  });

  it('tells the operator where discovery is', async () => {
    const { data } = await gql('{ provider { issuer discoveryUrl } }');
    expect(data.provider).toEqual({
      issuer: app.services.issuer,
      discoveryUrl: `${app.services.issuer}/.well-known/openid-configuration`,
    });
  });

  it('creates, changes and deletes a client', async () => {
    const created = await gql(`mutation ($input: NewClientInput!) { createClient(input: $input) ${CLIENT_FIELDS} }`, {
      input: {
        clientId: 'grafana',
        name: 'Grafana',
        authMethod: 'CLIENT_SECRET_POST',
        redirectUris: ['https://grafana.example/cb'],
        postLogoutRedirectUris: [],
      },
    });
    expect(created.data.createClient).toMatchObject({ clientId: 'grafana', authMethod: 'CLIENT_SECRET_POST' });

    const updated = await gql(
      `mutation ($input: ClientInput!) { updateClient(clientId: "grafana", input: $input) ${CLIENT_FIELDS} }`,
      {
        input: {
          name: 'Grafana',
          authMethod: 'NONE',
          redirectUris: ['https://grafana.example/cb'],
          postLogoutRedirectUris: [],
        },
      },
    );
    expect(updated.data.updateClient.clientSecret).toBeNull();

    await gql('mutation { deleteClient(clientId: "grafana") { clientId } }');
    const missing = await gql('{ client(clientId: "grafana") { clientId } }');
    expect(missing.errors[0].extensions.code).toBe(ErrorCode.NotFound);
  });

  it('creates a user without ever returning a password', async () => {
    const { data } = await gql(
      'mutation ($input: NewUserInput!) { createUser(input: $input) { id username groups } }',
      { input: { username: 'ada', password: 'correct horse', email: '', name: '', groups: ['a', 'a'] } },
    );
    expect(data.createUser).toMatchObject({ username: 'ada', groups: ['a'] });
    const typeRes = await gql('{ __type(name: "User") { fields { name } } }');
    const fields = typeRes.data.__type.fields.map((field: { name: string }) => field.name);
    expect(fields).not.toContain('passwordHash');
  });

  it('says why bad input was refused', async () => {
    const { errors } = await gql('mutation ($input: NewUserInput!) { createUser(input: $input) { id } }', {
      input: { username: 'bob', password: 'short', email: '', name: '', groups: [] },
    });
    expect(errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    expect(errors[0].message).toMatch(/password/);
  });

  it('refuses a weak password when an admin adds a user or sets one', async () => {
    const created = await gql(CREATE_USER, {
      input: { username: 'cy', password: 'password1', email: '', name: '', groups: [] },
    });
    expect(created.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    expect(created.errors[0].message).toMatch(/too easy to guess/);
    expect(app.services.users.list().some((user) => user.username === 'cy')).toBe(false);

    const { id } = app.services.users.create({ username: 'dee', email: '', name: '', groups: [] });
    const set = await gql(SET_PASSWORD, { id, password: 'password1' });
    expect(set.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    expect(app.services.users.find(id)?.hasPassword).toBe(false);
  });

  it('applies a new minimum strength to the next password, and records the change', async () => {
    const { data } = await gql('{ passwordRules { minScore checkBreaches } }');
    expect(data.passwordRules).toEqual({
      minScore: PASSWORD_RULE_DEFAULTS.minScore,
      checkBreaches: PASSWORD_RULE_DEFAULTS.checkBreaches,
    });
    const { id } = app.services.users.create({ username: 'eve', email: '', name: '', groups: [] });
    const changed = await gql(SET_RULES, { minScore: MAX_PASSWORD_SCORE });
    expect(changed.data.setPasswordRules).toEqual({ minScore: MAX_PASSWORD_SCORE, checkBreaches: false });
    expect((await gql(SET_PASSWORD, { id, password: HARD })).errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
    expect(await (await fetch(`${app.base}/admin/password-rules`)).json()).toEqual({ minScore: MAX_PASSWORD_SCORE });
    const [entry] = app.services.audit.list({ first: 1, types: [AuditType.PasswordRulesSet] }).entries;
    expect(entry?.detail).toEqual({ minScore: String(MAX_PASSWORD_SCORE), breachCheck: 'off' });

    await gql(SET_RULES, { minScore: PASSWORD_RULE_DEFAULTS.minScore });
    expect((await gql(SET_PASSWORD, { id, password: HARD })).data.setUserPassword.id).toBe(id);
  });

  it('refuses a minimum strength zxcvbn never gives', async () => {
    const { errors } = await gql(SET_RULES, { minScore: MAX_PASSWORD_SCORE + 1 });
    expect(errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
  });
});
