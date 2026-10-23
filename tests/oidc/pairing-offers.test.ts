import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAIRING_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus, MS_PER_SECOND } from '../../server/core/wire.ts';
import { DEVICE_CODE_GRANT } from '../../server/oidc/adapter.ts';
import { SETUP_URL_TOKEN } from '../../server/oidc/pairing.ts';
import { metadataUrlFor } from '../../server/oidc/pairing-offers.ts';
import { AuditType } from '../../server/store/audit.ts';
import { adminGql, type Browser, REDIRECT_URI, signInAsAdmin } from '../browser.ts';
import { startTestApp, type TestApp } from '../helpers.ts';

// The second step of pairing: what an app offers besides its sign-in (a device client it registered with the setup
// URL, an API its protected resource metadata describes), which waits for the operator to turn it on.

const START_PAIRING = /* GraphQL */ `
  mutation ($input: PairingInput!) { startPairing(input: $input) { setupUrl pairing { id } } }
`;
const OFFERS = /* GraphQL */ `
  query ($id: ID!) {
    pairing(id: $id) {
      finished
      offers {
        deviceClient { clientId allowDeviceFlow }
        api { identifier name scopes existing { identifier } }
      }
    }
  }
`;
const FINISH = /* GraphQL */ `
  mutation ($id: ID!, $input: FinishPairingInput!) {
    finishPairing(id: $id, input: $input) { finished offers { api { identifier } } }
  }
`;

/** Where the app is, on the host of its redirect URI. */
const APP_ORIGIN = new URL(REDIRECT_URI).origin;
const API = `${APP_ORIGIN}/graphql`;

/** What the app registers its sign-in client as. */
const APP_METADATA = {
  client_name: 'Telos',
  client_uri: APP_ORIGIN,
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'client_secret_basic',
  grant_types: ['authorization_code'],
  response_types: ['code'],
};

/** What the app registers its device client as. */
const DEVICE_METADATA = {
  client_name: 'Telos devices',
  client_uri: APP_ORIGIN,
  redirect_uris: [],
  token_endpoint_auth_method: 'none',
  grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
  response_types: [],
};

describe('what a paired app offers', () => {
  let app: TestApp;
  let admin: Browser;
  /** What the app's metadata answers with; null answers 404. */
  let metadata: Record<string, unknown> | null;
  /** The addresses heautou fetched. */
  let fetched: string[];
  let time = Date.now();

  beforeAll(async () => {
    app = await startTestApp({
      now: () => time,
      fetchPairing: async (input) => {
        const url = String(input);
        fetched.push(url);
        return metadata !== null && url === metadataUrlFor(APP_ORIGIN)
          ? Response.json(metadata)
          : new Response('', { status: HttpStatus.NotFound });
      },
    });
    admin = await signInAsAdmin(app);
  });

  beforeEach(() => {
    fetched = [];
    metadata = {
      resource: API,
      resource_name: 'Telos API',
      authorization_servers: [app.services.issuer],
      scopes_supported: ['todos', 'openid', 'bad scope'],
    };
  });

  afterAll(() => app.close());

  /**
   * Starts a pairing as the admin.
   *
   * @returns The pairing's id, its token and the registration endpoint.
   */
  const startPairing = async () => {
    const { data } = await adminGql(admin, START_PAIRING, { input: {} });
    const setupUrl = new URL(data.startPairing.setupUrl);
    return {
      id: data.startPairing.pairing.id as string,
      token: new URLSearchParams(setupUrl.hash.slice(1)).get(SETUP_URL_TOKEN) ?? '',
      endpoint: `${app.services.issuer}/reg`,
    };
  };

  /**
   * Registers as an app does.
   *
   * @param endpoint - The registration endpoint.
   * @param token - The initial access token.
   * @param body - The client metadata.
   * @returns The response.
   */
  const register = (endpoint: string, token: string, body: object) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /**
   * Pairs an app's sign-in client and its device client.
   *
   * @returns The pairing's id, and the device client's registration.
   */
  const pairBoth = async () => {
    const pairing = await startPairing();
    expect((await register(pairing.endpoint, pairing.token, APP_METADATA)).status).toBe(HttpStatus.Created);
    const res = await register(pairing.endpoint, pairing.token, DEVICE_METADATA);
    expect(res.status).toBe(HttpStatus.Created);
    return { id: pairing.id, token: pairing.token, endpoint: pairing.endpoint, device: await res.json() };
  };

  /**
   * Starts the device flow as a device does.
   *
   * @param clientId - The device client.
   * @returns The response.
   */
  const startDeviceFlow = (clientId: string) =>
    fetch(`${app.services.issuer}/device/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope: 'openid' }),
    });

  it('registers a device client with the same setup URL, which waits for the operator', async () => {
    const { id, token, endpoint, device } = await pairBoth();
    // The answer says what the client has: nothing yet.
    expect(device.grant_types).toEqual([]);
    expect(device.client_secret).toBeUndefined();
    expect(app.services.clients.find(device.client_id)).toMatchObject({
      name: 'Telos devices',
      allowDeviceFlow: false,
      source: 'paired',
    });
    expect((await startDeviceFlow(device.client_id)).ok).toBe(false);

    const { data } = await adminGql(admin, OFFERS, { id });
    expect(data.pairing).toEqual({
      finished: false,
      offers: {
        deviceClient: { clientId: device.client_id, allowDeviceFlow: false },
        api: { identifier: API, name: 'Telos API', scopes: ['todos'], existing: null },
      },
    });

    // The token is spent now.
    expect((await register(endpoint, token, DEVICE_METADATA)).status).toBe(HttpStatus.Unauthorized);
  });

  it('turns the device flow on and adds the API when the operator finishes', async () => {
    const { id, device } = await pairBoth();
    const { data } = await adminGql(admin, FINISH, { id, input: { deviceFlow: true, api: true } });
    expect(data.finishPairing).toEqual({ finished: true, offers: null });

    expect(app.services.clients.find(device.client_id)?.allowDeviceFlow).toBe(true);
    const api = app.services.apis.find(API);
    expect(api).toMatchObject({ name: 'Telos API', scopes: ['todos'], tokenFormat: 'jwt' });
    expect(api?.allowedClientIds).toContain(device.client_id);
    expect(api?.allowedClientIds).toHaveLength(2);
    expect((await startDeviceFlow(device.client_id)).ok).toBe(true);

    // The device client shows the one API it may get tokens to, and the app it belongs to.
    const listed = await adminGql(
      admin,
      '{ clients(limit: 20) { clientId app { id uri } apis(limit: 10) { identifier } } }',
    );
    const appClients = listed.data.clients.filter((c: { app: { id: string } | null }) => c.app?.id === id);
    expect(appClients).toHaveLength(2);
    const deviceClient = appClients.find((c: { clientId: string }) => c.clientId === device.client_id);
    expect(deviceClient).toEqual({
      clientId: device.client_id,
      app: { id, uri: APP_ORIGIN },
      apis: [{ identifier: API }],
    });

    // The app reads its registration (RFC 7592) and sees the device flow.
    const read = await fetch(device.registration_client_uri, {
      headers: { authorization: `Bearer ${device.registration_access_token}` },
    });
    expect((await read.json()).grant_types).toContain(DEVICE_CODE_GRANT);

    const finished = (await app.services.audit.list({ first: 5, types: [AuditType.PairingFinished] })).entries[0];
    expect(finished?.detail).toEqual({ deviceFlow: 'on', api: API });
    const again = await adminGql(admin, FINISH, { id, input: { deviceFlow: true, api: true } });
    expect(again.errors?.[0]?.message).toMatch(/finished already/);
  });

  it('removes the device client and adds nothing the operator turns off', async () => {
    await app.services.apis.remove(API);
    const { id, device } = await pairBoth();
    await adminGql(admin, FINISH, { id, input: { deviceFlow: false, api: false } });
    expect(app.services.clients.find(device.client_id)).toBeNull();
    expect(app.services.apis.find(API)).toBeNull();
  });

  it('allows the clients on an API that is already there', async () => {
    const { id, device } = await pairBoth();
    const { data } = await adminGql(admin, OFFERS, { id });
    expect(data.pairing.offers.api.existing).toBeNull();
    await app.services.apis.create({ identifier: API, name: 'Mine', scopes: [], allowedClientIds: [] });
    await adminGql(admin, FINISH, { id, input: { deviceFlow: true, api: true } });
    expect(app.services.apis.find(API)).toMatchObject({ name: 'Mine' });
    expect(app.services.apis.find(API)?.allowedClientIds).toContain(device.client_id);
  });

  it('places a client paired before its pairing was recorded by the API it is allowed on', async () => {
    const fields = { name: 'Old app', authMethod: 'client_secret_basic' as const, redirectUris: [REDIRECT_URI] };
    const old = await app.services.clients.create({ ...fields, postLogoutRedirectUris: [], source: 'paired' });
    const handMade = await app.services.clients.create({ ...fields, postLogoutRedirectUris: [] });
    await app.services.apis.create({
      identifier: 'https://old.example/graphql',
      name: 'Old API',
      scopes: [],
      allowedClientIds: [old.clientId, handMade.clientId],
    });
    const { data } = await adminGql(admin, '{ clients { clientId app { id uri } } }');
    const appOf = (clientId: string) => data.clients.find((c: { clientId: string }) => c.clientId === clientId).app;
    expect(appOf(old.clientId)).toEqual({ id: 'api:https://old.example', uri: 'https://old.example' });
    // One the operator added belongs to no app.
    expect(appOf(handMade.clientId)).toBeNull();
  });

  it('offers no API the metadata does not tie to this provider and the app', async () => {
    const offeredFor = async () => {
      const { id } = await pairBoth();
      return (await adminGql(admin, OFFERS, { id })).data.pairing.offers.api;
    };
    metadata = { resource: API, authorization_servers: ['https://other.example/oidc'] };
    expect(await offeredFor()).toBeNull();
    metadata = { resource: 'https://other.example/graphql', authorization_servers: [app.services.issuer] };
    expect(await offeredFor()).toBeNull();
    metadata = null;
    expect(await offeredFor()).toBeNull();
  });

  it('looks again for an API the app describes only once it has finished pairing', async () => {
    // The app answers before it has started using this provider, so its metadata names none yet.
    metadata = { resource: API, authorization_servers: [] };
    const { id } = await pairBoth();
    expect((await adminGql(admin, OFFERS, { id })).data.pairing.offers.api).toBeNull();

    metadata = { resource: API, resource_name: 'Telos API', authorization_servers: [app.services.issuer] };
    // An empty answer is believed for a few seconds, so reading again straight away does not fetch.
    const fetches = fetched.length;
    expect((await adminGql(admin, OFFERS, { id })).data.pairing.offers.api).toBeNull();
    expect(fetched).toHaveLength(fetches);

    time += PAIRING_DEFAULTS.discoveryRetrySeconds * MS_PER_SECOND + 1;
    expect((await adminGql(admin, OFFERS, { id })).data.pairing.offers.api).toMatchObject({ identifier: API });
    // Found, it is kept.
    expect((await adminGql(admin, OFFERS, { id })).data.pairing.offers.api).toMatchObject({ identifier: API });
    expect(fetched).toHaveLength(fetches + 1);
  });

  it('never fetches a client_uri off the redirect URIs host', async () => {
    const pairing = await startPairing();
    const elsewhere = { ...APP_METADATA, client_uri: 'http://169.254.169.254' };
    expect((await register(pairing.endpoint, pairing.token, elsewhere)).status).toBe(HttpStatus.Created);
    const { data } = await adminGql(admin, OFFERS, { id: pairing.id });
    expect(data.pairing.offers).toEqual({ deviceClient: null, api: null });
    expect(fetched).toEqual([]);
  });

  it('turns away a second registration that is not a device client', async () => {
    const pairing = await startPairing();
    expect((await register(pairing.endpoint, pairing.token, APP_METADATA)).status).toBe(HttpStatus.Created);
    const confidential = { ...DEVICE_METADATA, token_endpoint_auth_method: 'client_secret_basic' };
    expect((await register(pairing.endpoint, pairing.token, confidential)).status).toBe(HttpStatus.Unauthorized);
    const withCode = { ...DEVICE_METADATA, grant_types: [DEVICE_CODE_GRANT, 'authorization_code'] };
    expect((await register(pairing.endpoint, pairing.token, withCode)).status).not.toBe(HttpStatus.Created);
  });

  it('builds the metadata address RFC 9728 gives a resource', () => {
    expect(metadataUrlFor('https://telos.example')).toBe('https://telos.example/.well-known/oauth-protected-resource');
    expect(metadataUrlFor('https://example.com/telos/')).toBe(
      'https://example.com/.well-known/oauth-protected-resource/telos',
    );
  });
});
