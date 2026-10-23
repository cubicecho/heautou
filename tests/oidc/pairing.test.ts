import { PAIRING_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus, MS_PER_SECOND } from '../../server/core/wire.ts';
import { SETUP_URL_NAME, SETUP_URL_TOKEN } from '../../server/oidc/pairing.ts';
import { AuditType } from '../../server/store/audit.ts';
import { CLIENT_SOURCE_PAIRED, ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import {
  adminGql,
  adminSubscribe,
  type Browser,
  PASSWORD,
  payloadOf,
  REDIRECT_URI,
  signInAsAdmin,
  signInForTokens,
} from './browser.ts';

const START_PAIRING = /* GraphQL */ `
  mutation ($input: PairingInput!) {
    startPairing(input: $input) {
      setupUrl
      pairing { id status expiresAt }
    }
  }
`;
const PAIRING = /* GraphQL */ `
  query ($id: ID!) {
    pairing(id: $id) { status allowedGroups groupsClaim client { clientId name source logoUri } }
  }
`;

/** What an app registers as, the way the spec in docs/pairing.md has it. */
const APP_METADATA = {
  client_name: 'Telos',
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'client_secret_basic',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  logo_uri: 'https://app.example/logo.png',
};

/** What a registration answers with. */
interface Registered {
  client_id: string;
  client_secret: string;
  registration_access_token: string;
  registration_client_uri: string;
}

describe('pairing an app with a setup URL', () => {
  let app: TestApp;
  let admin: Browser;
  let time = Date.now();

  beforeAll(async () => {
    app = await startTestApp({ now: () => time });
    admin = await signInAsAdmin(app);
    await app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: ['family'] });
    await app.services.users.create({ username: 'bob', password: PASSWORD, email: '', name: '', groups: [] });
  });

  afterAll(() => app.close());

  /**
   * Starts a pairing as the admin and reads the setup URL apart, as an app does.
   *
   * @param [input] - What the client gets.
   * @returns The pairing's id, the setup URL's parts and the registration endpoint.
   */
  const startPairing = async (input: Record<string, unknown> = {}) => {
    const { data } = await adminGql(admin, START_PAIRING, { input });
    const setupUrl = new URL(data.startPairing.setupUrl);
    const fragment = new URLSearchParams(setupUrl.hash.slice(1));
    setupUrl.hash = '';
    const discovery = await (await fetch(`${setupUrl}/.well-known/openid-configuration`)).json();
    return {
      id: data.startPairing.pairing.id as string,
      issuer: setupUrl.toString(),
      token: fragment.get(SETUP_URL_TOKEN) ?? '',
      name: fragment.get(SETUP_URL_NAME),
      endpoint: discovery.registration_endpoint as string,
      discovery,
    };
  };

  /**
   * Registers as an app does.
   *
   * @param endpoint - The registration endpoint.
   * @param token - The initial access token.
   * @param [metadata] - The client metadata.
   * @returns The response.
   */
  const register = (endpoint: string, token: string, metadata: object = APP_METADATA) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    });

  it('registers an app once, with the groups the admin chose, and signs its users in', async () => {
    const pairing = await startPairing({ allowedGroups: ['family'], groupsClaim: 'roles' });
    expect(pairing.issuer).toBe(app.services.issuer);
    expect(pairing.name).toBe('Heautou');
    expect(pairing.endpoint).toBe(`${app.services.issuer}/reg`);

    const res = await register(pairing.endpoint, pairing.token);
    expect(res.status).toBe(HttpStatus.Created);
    const registered: Registered = await res.json();
    const client = app.services.clients.find(registered.client_id);
    expect(client).toMatchObject({
      name: 'Telos',
      source: CLIENT_SOURCE_PAIRED,
      allowedGroups: ['family'],
      groupsClaim: 'roles',
      clientSecret: registered.client_secret,
      logoUri: APP_METADATA.logo_uri,
    });

    const { data } = await adminGql(admin, PAIRING, { id: pairing.id });
    expect(data.pairing).toMatchObject({ status: 'PAIRED', client: { name: 'Telos', source: 'PAIRED' } });

    expect((await register(pairing.endpoint, pairing.token)).status).toBe(HttpStatus.Unauthorized);

    const tokens = await signInForTokens(
      app,
      { clientId: registered.client_id, clientSecret: registered.client_secret },
      'ada',
    );
    expect(payloadOf(tokens.id_token)).toMatchObject({ aud: registered.client_id });
    const me = await (
      await fetch(`${app.services.issuer}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    ).json();
    expect(me.roles).toEqual(['family']);
    await expect(
      signInForTokens(app, { clientId: registered.client_id, clientSecret: registered.client_secret }, 'bob'),
    ).rejects.toThrow();
  });

  it('streams the pairing as it changes, and null once it is cancelled', async () => {
    const watched = /* GraphQL */ `
      subscription ($id: ID!) { pairingChanged(id: $id) { status client { name } } }
    `;
    const paired = await startPairing();
    const watch = await adminSubscribe(admin, watched, { id: paired.id });
    try {
      expect((await watch.subscription.next())?.data?.pairingChanged).toEqual({ status: 'WAITING', client: null });
      expect((await register(paired.endpoint, paired.token)).status).toBe(HttpStatus.Created);
      expect((await watch.subscription.next())?.data?.pairingChanged).toEqual({
        status: 'PAIRED',
        client: { name: 'Telos' },
      });
    } finally {
      watch.subscription.close();
    }

    const cancelled = await startPairing();
    const ended = await adminSubscribe(admin, watched, { id: cancelled.id });
    expect((await ended.subscription.next())?.data?.pairingChanged).toMatchObject({ status: 'WAITING' });
    await adminGql(admin, 'mutation ($id: ID!) { cancelPairing(id: $id) }', { id: cancelled.id });
    expect((await ended.subscription.next())?.data?.pairingChanged).toBeNull();
    expect(await ended.subscription.next()).toBeNull();
  });

  it('lets the app update and remove itself', async () => {
    const pairing = await startPairing();
    const registered: Registered = await (await register(pairing.endpoint, pairing.token)).json();
    const manage = (method: string, token: string, body?: object) =>
      fetch(registered.registration_client_uri, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const updateRes = await manage('PUT', registered.registration_access_token, {
      ...APP_METADATA,
      client_id: registered.client_id,
      client_name: 'Telos (home)',
      redirect_uris: [REDIRECT_URI, 'http://app.example/other'],
    });
    expect(updateRes.status).toBe(HttpStatus.Ok);
    const updated: Registered = await updateRes.json();
    expect(updated.client_secret).toBe(registered.client_secret);
    expect(updated.registration_access_token).not.toBe(registered.registration_access_token);
    expect(app.services.clients.find(registered.client_id)).toMatchObject({
      name: 'Telos (home)',
      redirectUris: [REDIRECT_URI, 'http://app.example/other'],
    });

    expect((await manage('DELETE', updated.registration_access_token)).status).toBe(HttpStatus.NoContent);
    expect(app.services.clients.find(registered.client_id)).toBeNull();
    const recorded = (await app.services.audit.list({ first: 3 })).entries.filter(
      (entry) => entry.target?.id === registered.client_id,
    );
    expect(recorded.map((entry) => entry.type)).toEqual([
      AuditType.RegistrationDeleted,
      AuditType.RegistrationUpdated,
      AuditType.PairingCompleted,
    ]);
    // Named as the client store names it, as every other entry is: an update by the name it was given.
    expect(recorded.map((entry) => entry.target?.name)).toEqual([
      'Telos (home)',
      'Telos (home)',
      APP_METADATA.client_name,
    ]);
    expect(JSON.stringify(recorded)).not.toContain(registered.registration_access_token);
  });

  it('turns away a setup URL that is missing, cancelled or expired', async () => {
    const { endpoint } = await startPairing();
    expect((await register(endpoint, 'not-a-token')).status).toBe(HttpStatus.Unauthorized);

    const cancelled = await startPairing();
    const { data } = await adminGql(admin, 'mutation ($id: ID!) { cancelPairing(id: $id) }', { id: cancelled.id });
    expect(data.cancelPairing).toBe(true);
    expect((await register(endpoint, cancelled.token)).status).toBe(HttpStatus.Unauthorized);

    const expired = await startPairing();
    time += PAIRING_DEFAULTS.linkSeconds * MS_PER_SECOND + 1;
    expect((await adminGql(admin, PAIRING, { id: expired.id })).data.pairing).toBeNull();
    time = Date.now();
  });

  it('refuses metadata it cannot hold, without spending the setup URL', async () => {
    const pairing = await startPairing();
    const refused = await register(pairing.endpoint, pairing.token, {
      ...APP_METADATA,
      token_endpoint_auth_method: 'private_key_jwt',
    });
    expect(refused.status).toBe(HttpStatus.BadRequest);
    expect((await refused.json()).error).toBe('invalid_client_metadata');
    const noRedirect = await register(pairing.endpoint, pairing.token, { ...APP_METADATA, redirect_uris: [] });
    expect(noRedirect.status).toBe(HttpStatus.BadRequest);
    expect((await register(pairing.endpoint, pairing.token)).status).toBe(HttpStatus.Created);
  });

  it('refuses a plain http redirect URI once the admin requires https, without spending the setup URL', async () => {
    const httpRedirects = 'query { httpRedirects { isAllowed isSet isIssuerHttp } }';
    const setHttpRedirects = /* GraphQL */ `
      mutation ($allowed: Boolean) { setHttpRedirects(allowed: $allowed) { isAllowed isSet isIssuerHttp } }
    `;
    // The test issuer is plain http, so plain http redirect URIs are allowed until the admin says otherwise.
    expect((await adminGql(admin, httpRedirects)).data.httpRedirects).toEqual({
      isAllowed: true,
      isSet: false,
      isIssuerHttp: true,
    });
    const earlier = await app.services.clients.create({
      name: 'Old app',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    const required = await adminGql(admin, setHttpRedirects, { allowed: false });
    expect(required.data.setHttpRedirects).toEqual({ isAllowed: false, isSet: true, isIssuerHttp: true });

    const pairing = await startPairing();
    const refused = await register(pairing.endpoint, pairing.token);
    expect(refused.status).toBe(HttpStatus.BadRequest);
    const body = await refused.json();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toMatch(/plain http/);
    const secure = { ...APP_METADATA, redirect_uris: ['https://app.example/callback'] };
    expect((await register(pairing.endpoint, pairing.token, secure)).status).toBe(HttpStatus.Created);

    // A client saved before the rule keeps working, and is flagged.
    const { data } = await adminGql(
      admin,
      'query ($id: String!) { client(where: { clientId: { eq: $id } }) { refusedRedirectUris } }',
      {
        id: earlier.clientId,
      },
    );
    expect(data.client.refusedRedirectUris).toEqual([REDIRECT_URI]);

    const reset = await adminGql(admin, setHttpRedirects, { allowed: null });
    expect(reset.data.setHttpRedirects).toEqual({ isAllowed: true, isSet: false, isIssuerHttp: true });
    const changes = (await app.services.audit.list({ first: 50, types: [AuditType.HttpRedirectsSet] })).entries.map(
      (entry) => entry.detail,
    );
    expect(changes).toEqual([
      { httpRedirects: 'allowed', chosenBy: 'issuer' },
      { httpRedirects: 'refused', chosenBy: 'operator' },
    ]);
  });

  it('takes a back-channel logout URI, refusing one the store cannot hold', async () => {
    const pairing = await startPairing();
    const backchannel = {
      ...APP_METADATA,
      backchannel_logout_uri: 'https://app.example/backchannel-logout',
      backchannel_logout_session_required: true,
    };
    const refused = await register(pairing.endpoint, pairing.token, {
      ...backchannel,
      backchannel_logout_uri: `${backchannel.backchannel_logout_uri}#fragment`,
    });
    expect(refused.status).toBe(HttpStatus.BadRequest);
    expect((await refused.json()).error).toBe('invalid_client_metadata');

    const res = await register(pairing.endpoint, pairing.token, backchannel);
    expect(res.status).toBe(HttpStatus.Created);
    const registered = await res.json();
    expect(registered.backchannel_logout_uri).toBe(backchannel.backchannel_logout_uri);
    expect(app.services.clients.find(registered.client_id)).toMatchObject({
      backchannelLogoutUri: backchannel.backchannel_logout_uri,
      backchannelLogoutSessionRequired: true,
    });
  });

  it('gives a public client no secret', async () => {
    const pairing = await startPairing();
    const res = await register(pairing.endpoint, pairing.token, {
      ...APP_METADATA,
      token_endpoint_auth_method: 'none',
    });
    const registered = await res.json();
    expect(registered.client_secret).toBeUndefined();
    expect(app.services.clients.find(registered.client_id)?.clientSecret).toBeNull();
  });
});
