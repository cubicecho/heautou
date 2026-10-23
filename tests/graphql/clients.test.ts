import { CLIENT_TOKEN_LIFETIME_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { AuditTargetKind, AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { adminGql, type Browser, signInAsAdmin } from '../browser.ts';
import { startTestApp, type TestApp } from '../helpers.ts';

const ROTATE = 'mutation ($clientId: ID!) { rotateClientSecret(clientId: $clientId) { clientId clientSecret } }';

describe('the clients part of the admin API', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  it('replaces a client secret, returning the new one and recording it without the secret', async () => {
    const before = await app.services.clients.create({
      clientId: 'grafana',
      name: 'Grafana',
      authMethod: ClientAuthMethod.SecretPost,
      redirectUris: ['https://grafana.example/cb'],
      postLogoutRedirectUris: [],
    });

    const { data } = await adminGql(admin, ROTATE, { clientId: 'grafana' });

    const after = app.services.clients.find('grafana');
    expect(data.rotateClientSecret).toEqual({ clientId: 'grafana', clientSecret: after?.clientSecret });
    expect(after?.clientSecret).toEqual(expect.any(String));
    expect(after?.clientSecret).not.toBe(before.clientSecret);
    const [entry] = (await app.services.audit.list({ first: 1, types: [AuditType.ClientSecretRotated] })).entries;
    expect(entry?.target).toEqual({ kind: AuditTargetKind.Client, id: 'grafana', name: 'Grafana' });
    expect(JSON.stringify(entry)).not.toContain(String(after?.clientSecret));
  });

  it('refuses to rotate the secret of a client that does not exist', async () => {
    const { errors } = await adminGql(admin, ROTATE, { clientId: 'nobody' });
    expect(errors[0].extensions.code).toBe(ErrorCode.NotFound);
  });

  it('gives the server token lifetimes and the bounds on a client’s own', async () => {
    const { data } = await adminGql(
      admin,
      `{ tokenLifetimeDefaults {
        accessTokenSeconds clientCredentialsSeconds idTokenSeconds refreshTokenSeconds minSeconds maxSeconds
      } }`,
    );
    expect(data.tokenLifetimeDefaults).toEqual({
      accessTokenSeconds: TOKEN_LIFETIME_DEFAULTS.accessTokenSeconds,
      clientCredentialsSeconds: TOKEN_LIFETIME_DEFAULTS.clientCredentialsSeconds,
      idTokenSeconds: TOKEN_LIFETIME_DEFAULTS.idTokenSeconds,
      refreshTokenSeconds: TOKEN_LIFETIME_DEFAULTS.refreshTokenSeconds,
      minSeconds: CLIENT_TOKEN_LIFETIME_DEFAULTS.minSeconds,
      maxSeconds: CLIENT_TOKEN_LIFETIME_DEFAULTS.maxSeconds,
    });
  });
});
