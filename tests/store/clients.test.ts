import { CLIENT_TOKEN_LIFETIME_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { loosen, openDocument, replaceDocument } from '../../server/db/document.ts';
import { CLIENTS_DOCUMENT } from '../../server/db/documents.ts';
import {
  ClientAuthMethod,
  type ClientStore,
  type ClientStoreOptions,
  createClientStore,
  DEFAULT_CLIENT_TOKEN_LIFETIMES,
} from '../../server/store/clients.ts';
import { createTestStore, type TestStore } from '../db.ts';

const FIELDS = {
  name: 'Grafana',
  authMethod: ClientAuthMethod.SecretBasic,
  redirectUris: ['https://grafana.example/login/generic_oauth'],
  postLogoutRedirectUris: [],
};

describe('client store', () => {
  let db: TestStore;
  let store: ClientStore;

  /**
   * Opens a client store on the test database.
   *
   * @param options - The store's options.
   * @returns The store.
   */
  async function open(options: ClientStoreOptions = {}): Promise<ClientStore> {
    return createClientStore(await openDocument(db, CLIENTS_DOCUMENT), options);
  }

  /**
   * Writes the clients an older version saved straight into the tables, as its file held them.
   *
   * @param older - The clients, in the older shape.
   */
  async function writeOlder(older: unknown): Promise<void> {
    await db.db.transaction((tx) => replaceDocument(tx, loosen(CLIENTS_DOCUMENT), older));
  }

  beforeEach(async () => {
    db = await createTestStore();
    store = await open();
  });

  afterEach(() => db.close());

  it('gives a confidential client a secret and keeps it in the database', async () => {
    const created = await store.create({ ...FIELDS, clientId: 'grafana' });
    expect(created.clientSecret).toMatch(/^[\w-]{40,}$/);
    const reopened = await open();
    expect(reopened.find('grafana')).toEqual(created);
  });

  it('makes up an ID when none is given', async () => {
    expect((await store.create({ ...FIELDS, clientId: '' })).clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second client with the same ID', async () => {
    await store.create({ ...FIELDS, clientId: 'grafana' });
    await expect(store.create({ ...FIELDS, clientId: 'grafana' })).rejects.toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.BadUserInput }) }),
    );
  });

  it('keeps a client on the default token lifetimes until it is given its own', async () => {
    const { clientId } = await store.create({ ...FIELDS, clientId: 'grafana' });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(DEFAULT_CLIENT_TOKEN_LIFETIMES);
    const tokenLifetimes = { accessTokenSeconds: 900, idTokenSeconds: null, refreshTokenSeconds: 2_592_000 };
    await store.update(clientId, { ...FIELDS, tokenLifetimes });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(tokenLifetimes);
    await store.update(clientId, { ...FIELDS, name: 'Grafana 2' });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(tokenLifetimes);
    expect((await open()).find(clientId)?.tokenLifetimes).toEqual(tokenLifetimes);
  });

  it('refuses a token lifetime outside the bounds', async () => {
    const { minSeconds, maxSeconds } = CLIENT_TOKEN_LIFETIME_DEFAULTS;
    const lifetimes = (accessTokenSeconds: number) => ({ ...FIELDS, tokenLifetimes: { accessTokenSeconds } });
    await expect(store.create(lifetimes(minSeconds - 1))).rejects.toThrow(/accessTokenSeconds/);
    await expect(store.create(lifetimes(maxSeconds + 1))).rejects.toThrow(/accessTokenSeconds/);
    await expect(store.create(lifetimes(minSeconds + 0.5))).rejects.toThrow(/whole number/);
  });

  it('reads a client saved before lifetimes existed as on the defaults', async () => {
    const saved = await store.create({ ...FIELDS, clientId: 'old' });
    const { tokenLifetimes: _dropped, ...older } = saved;
    await writeOlder([older]);
    expect((await open()).find('old')?.tokenLifetimes).toEqual(DEFAULT_CLIENT_TOKEN_LIFETIMES);
  });

  it('refuses a redirect URI that is not a URL', async () => {
    await expect(store.create({ ...FIELDS, redirectUris: ['not a url'] })).rejects.toThrow(/redirectUris/);
  });

  it('refuses a plain http redirect URI unless the operator allows it, checking it on save only', async () => {
    let allowsHttp = true;
    const checked = await open({ allowsHttpRedirects: () => allowsHttp });
    const http = { ...FIELDS, redirectUris: ['http://nas.lan:31001/login'] };
    const { clientId } = await checked.create(http);
    allowsHttp = false;
    expect(checked.find(clientId)?.redirectUris).toEqual(http.redirectUris);
    await expect(checked.update(clientId, http)).rejects.toThrow(/redirectUris: .*plain http/);
    await expect(checked.create(http)).rejects.toThrow(/plain http/);
    await expect(checked.create({ ...FIELDS, postLogoutRedirectUris: ['http://nas.lan/bye'] })).rejects.toThrow(
      /postLogoutRedirectUris/,
    );
    expect((await checked.create({ ...FIELDS, redirectUris: ['http://localhost:8080/cb'] })).clientId).toBeTruthy();
  });

  it('holds a back-channel logout URI to the https rule, keeps it on update and clears it when blank', async () => {
    let allowsHttp = false;
    const checked = await open({ allowsHttpRedirects: () => allowsHttp });
    const backchannelLogoutUri = 'https://grafana.example/logout/backchannel';
    const { clientId } = await checked.create({ ...FIELDS, backchannelLogoutUri });
    expect(checked.find(clientId)).toMatchObject({ backchannelLogoutUri, backchannelLogoutSessionRequired: true });
    await checked.update(clientId, { ...FIELDS, name: 'Grafana 2' });
    expect(checked.find(clientId)?.backchannelLogoutUri).toBe(backchannelLogoutUri);
    await checked.update(clientId, { ...FIELDS, backchannelLogoutUri: '' });
    expect(checked.find(clientId)?.backchannelLogoutUri).toBeNull();

    const http = { ...FIELDS, backchannelLogoutUri: 'http://nas.lan:31001/logout' };
    await expect(checked.create(http)).rejects.toThrow(/backchannelLogoutUri: .*plain http/);
    await expect(checked.create({ ...FIELDS, backchannelLogoutUri: 'com.example.app:/logout' })).rejects.toThrow(
      /backchannelLogoutUri/,
    );
    await expect(checked.create({ ...FIELDS, backchannelLogoutUri: `${backchannelLogoutUri}#x` })).rejects.toThrow(
      /fragment/,
    );
    const loopback = await checked.create({ ...FIELDS, backchannelLogoutUri: 'http://localhost:8080/logout' });
    expect(loopback.clientId).toBeTruthy();
    allowsHttp = true;
    expect((await checked.create(http)).backchannelLogoutUri).toBe(http.backchannelLogoutUri);
  });

  it('reads a client saved before back-channel logout existed as having none', async () => {
    const saved = await store.create({ ...FIELDS, clientId: 'old' });
    const { backchannelLogoutUri: _uri, backchannelLogoutSessionRequired: _sid, ...older } = saved;
    await writeOlder([older]);
    expect((await open()).find('old')).toMatchObject({
      backchannelLogoutUri: null,
      backchannelLogoutSessionRequired: true,
    });
  });

  it('remembers the preset a client was started from, keeps it on update and clears it when blank', async () => {
    const { clientId } = await store.create({ ...FIELDS, preset: 'mealie' });
    expect(store.find(clientId)?.preset).toBe('mealie');
    await store.update(clientId, FIELDS);
    expect(store.find(clientId)?.preset).toBe('mealie');
    await store.update(clientId, { ...FIELDS, preset: '' });
    expect(store.find(clientId)?.preset).toBeNull();
    expect((await store.create({ ...FIELDS })).preset).toBeNull();
  });

  it('refuses a preset name that is not lowercase words joined by dashes', async () => {
    await expect(store.create({ ...FIELDS, preset: 'Mealie!' })).rejects.toThrow(/preset/);
  });

  it("takes a native app's own scheme for a public client only", async () => {
    const native = { ...FIELDS, redirectUris: ['com.example.app:/callback'] };
    await expect(store.create(native)).rejects.toThrow(/public/);
    expect((await store.create({ ...native, authMethod: ClientAuthMethod.None })).clientSecret).toBeNull();
  });

  it('drops the secret for a public client and makes one when it turns confidential', async () => {
    const { clientId } = await store.create(FIELDS);
    expect((await store.update(clientId, { ...FIELDS, authMethod: ClientAuthMethod.None })).clientSecret).toBeNull();
    expect((await store.update(clientId, FIELDS)).clientSecret).not.toBeNull();
  });

  it('replaces the secret on rotation', async () => {
    const created = await store.create(FIELDS);
    const rotated = await store.rotateSecret(created.clientId);
    expect(rotated.clientSecret).not.toBe(created.clientSecret);
    expect((await open()).find(created.clientId)?.clientSecret).toBe(rotated.clientSecret);
  });

  it('says a missing client is not found', async () => {
    await expect(store.remove('nope')).rejects.toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.NotFound }) }),
    );
  });
});
