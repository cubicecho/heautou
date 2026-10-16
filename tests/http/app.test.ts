import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, signInAsAdmin } from '../oidc/browser.ts';

const CLIENT_FIELDS = '{ clientId name clientSecret authMethod redirectUris }';

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
});
