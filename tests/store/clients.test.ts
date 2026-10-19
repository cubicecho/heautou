import path from 'node:path';
import { CLIENT_TOKEN_LIFETIME_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import {
  ClientAuthMethod,
  createClientStore,
  DEFAULT_CLIENT_TOKEN_LIFETIMES,
  type OidcClient,
} from '../../server/store/clients.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { tempDir } from '../helpers.ts';

const FIELDS = {
  name: 'Grafana',
  authMethod: ClientAuthMethod.SecretBasic,
  redirectUris: ['https://grafana.example/login/generic_oauth'],
  postLogoutRedirectUris: [],
};

/**
 * Opens a client store on a fresh file.
 *
 * @returns The store and the file's path.
 */
function freshStore() {
  const file = path.join(tempDir(), 'clients.json');
  return { file, store: createClientStore(openJsonFile<OidcClient[]>(file, [])) };
}

describe('client store', () => {
  it('gives a confidential client a secret and keeps it on disk', () => {
    const { file, store } = freshStore();
    const created = store.create({ ...FIELDS, clientId: 'grafana' });
    expect(created.clientSecret).toMatch(/^[\w-]{40,}$/);
    const reopened = createClientStore(openJsonFile<OidcClient[]>(file, []));
    expect(reopened.find('grafana')).toEqual(created);
  });

  it('makes up an ID when none is given', () => {
    const { store } = freshStore();
    expect(store.create({ ...FIELDS, clientId: '' }).clientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a second client with the same ID', () => {
    const { store } = freshStore();
    store.create({ ...FIELDS, clientId: 'grafana' });
    expect(() => store.create({ ...FIELDS, clientId: 'grafana' })).toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.BadUserInput }) }),
    );
  });

  it('keeps a client on the default token lifetimes until it is given its own', () => {
    const { store } = freshStore();
    const { clientId } = store.create({ ...FIELDS, clientId: 'grafana' });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(DEFAULT_CLIENT_TOKEN_LIFETIMES);
    const tokenLifetimes = { accessTokenSeconds: 900, idTokenSeconds: null, refreshTokenSeconds: 2_592_000 };
    store.update(clientId, { ...FIELDS, tokenLifetimes });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(tokenLifetimes);
    store.update(clientId, { ...FIELDS, name: 'Grafana 2' });
    expect(store.find(clientId)?.tokenLifetimes).toEqual(tokenLifetimes);
  });

  it('refuses a token lifetime outside the bounds', () => {
    const { store } = freshStore();
    const { minSeconds, maxSeconds } = CLIENT_TOKEN_LIFETIME_DEFAULTS;
    const lifetimes = (accessTokenSeconds: number) => ({ ...FIELDS, tokenLifetimes: { accessTokenSeconds } });
    expect(() => store.create(lifetimes(minSeconds - 1))).toThrow(/accessTokenSeconds/);
    expect(() => store.create(lifetimes(maxSeconds + 1))).toThrow(/accessTokenSeconds/);
    expect(() => store.create(lifetimes(minSeconds + 0.5))).toThrow(/whole number/);
  });

  it('reads a client saved before lifetimes existed as on the defaults', () => {
    const file = path.join(tempDir(), 'clients.json');
    const saved = createClientStore(openJsonFile<OidcClient[]>(file, [])).create({ ...FIELDS, clientId: 'old' });
    const { tokenLifetimes: _dropped, ...older } = saved;
    openJsonFile<OidcClient[]>(file, []).update(() => [older as OidcClient]);
    expect(createClientStore(openJsonFile<OidcClient[]>(file, [])).find('old')?.tokenLifetimes).toEqual(
      DEFAULT_CLIENT_TOKEN_LIFETIMES,
    );
  });

  it('refuses a redirect URI that is not a URL', () => {
    const { store } = freshStore();
    expect(() => store.create({ ...FIELDS, redirectUris: ['not a url'] })).toThrow(/redirectUris/);
  });

  it('refuses a plain http redirect URI unless the operator allows it, checking it on save only', () => {
    const file = path.join(tempDir(), 'clients.json');
    let allowsHttp = true;
    const store = createClientStore(openJsonFile<OidcClient[]>(file, []), { allowsHttpRedirects: () => allowsHttp });
    const http = { ...FIELDS, redirectUris: ['http://nas.lan:31001/login'] };
    const { clientId } = store.create(http);
    allowsHttp = false;
    expect(store.find(clientId)?.redirectUris).toEqual(http.redirectUris);
    expect(() => store.update(clientId, http)).toThrow(/redirectUris: .*plain http/);
    expect(() => store.create(http)).toThrow(/plain http/);
    expect(() => store.create({ ...FIELDS, postLogoutRedirectUris: ['http://nas.lan/bye'] })).toThrow(
      /postLogoutRedirectUris/,
    );
    expect(store.create({ ...FIELDS, redirectUris: ['http://localhost:8080/cb'] }).clientId).toBeTruthy();
  });

  it('holds a back-channel logout URI to the https rule, keeps it on update and clears it when blank', () => {
    const file = path.join(tempDir(), 'clients.json');
    let allowsHttp = false;
    const store = createClientStore(openJsonFile<OidcClient[]>(file, []), { allowsHttpRedirects: () => allowsHttp });
    const backchannelLogoutUri = 'https://grafana.example/logout/backchannel';
    const { clientId } = store.create({ ...FIELDS, backchannelLogoutUri });
    expect(store.find(clientId)).toMatchObject({ backchannelLogoutUri, backchannelLogoutSessionRequired: true });
    store.update(clientId, { ...FIELDS, name: 'Grafana 2' });
    expect(store.find(clientId)?.backchannelLogoutUri).toBe(backchannelLogoutUri);
    store.update(clientId, { ...FIELDS, backchannelLogoutUri: '' });
    expect(store.find(clientId)?.backchannelLogoutUri).toBeNull();

    const http = { ...FIELDS, backchannelLogoutUri: 'http://nas.lan:31001/logout' };
    expect(() => store.create(http)).toThrow(/backchannelLogoutUri: .*plain http/);
    expect(() => store.create({ ...FIELDS, backchannelLogoutUri: 'com.example.app:/logout' })).toThrow(
      /backchannelLogoutUri/,
    );
    expect(() => store.create({ ...FIELDS, backchannelLogoutUri: `${backchannelLogoutUri}#x` })).toThrow(/fragment/);
    expect(store.create({ ...FIELDS, backchannelLogoutUri: 'http://localhost:8080/logout' }).clientId).toBeTruthy();
    allowsHttp = true;
    expect(store.create(http).backchannelLogoutUri).toBe(http.backchannelLogoutUri);
  });

  it('reads a client saved before back-channel logout existed as having none', () => {
    const file = path.join(tempDir(), 'clients.json');
    const saved = createClientStore(openJsonFile<OidcClient[]>(file, [])).create({ ...FIELDS, clientId: 'old' });
    const { backchannelLogoutUri: _uri, backchannelLogoutSessionRequired: _sid, ...older } = saved;
    openJsonFile<OidcClient[]>(file, []).update(() => [older as OidcClient]);
    expect(createClientStore(openJsonFile<OidcClient[]>(file, [])).find('old')).toMatchObject({
      backchannelLogoutUri: null,
      backchannelLogoutSessionRequired: true,
    });
  });

  it('remembers the preset a client was started from, keeps it on update and clears it when blank', () => {
    const { store } = freshStore();
    const { clientId } = store.create({ ...FIELDS, preset: 'mealie' });
    expect(store.find(clientId)?.preset).toBe('mealie');
    store.update(clientId, FIELDS);
    expect(store.find(clientId)?.preset).toBe('mealie');
    store.update(clientId, { ...FIELDS, preset: '' });
    expect(store.find(clientId)?.preset).toBeNull();
    expect(store.create({ ...FIELDS }).preset).toBeNull();
  });

  it('refuses a preset name that is not lowercase words joined by dashes', () => {
    const { store } = freshStore();
    expect(() => store.create({ ...FIELDS, preset: 'Mealie!' })).toThrow(/preset/);
  });

  it("takes a native app's own scheme for a public client only", () => {
    const { store } = freshStore();
    const native = { ...FIELDS, redirectUris: ['com.example.app:/callback'] };
    expect(() => store.create(native)).toThrow(/public/);
    expect(store.create({ ...native, authMethod: ClientAuthMethod.None }).clientSecret).toBeNull();
  });

  it('drops the secret for a public client and makes one when it turns confidential', () => {
    const { store } = freshStore();
    const { clientId } = store.create(FIELDS);
    expect(store.update(clientId, { ...FIELDS, authMethod: ClientAuthMethod.None }).clientSecret).toBeNull();
    expect(store.update(clientId, FIELDS).clientSecret).not.toBeNull();
  });

  it('replaces the secret on rotation', () => {
    const { store } = freshStore();
    const created = store.create(FIELDS);
    expect(store.rotateSecret(created.clientId).clientSecret).not.toBe(created.clientSecret);
  });

  it('says a missing client is not found', () => {
    const { store } = freshStore();
    expect(() => store.remove('nope')).toThrow(
      expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.NotFound }) }),
    );
  });
});
