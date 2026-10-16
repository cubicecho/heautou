import path from 'node:path';
import { ErrorCode } from '../../server/core/errors.ts';
import { ClientAuthMethod, createClientStore, type OidcClient } from '../../server/store/clients.ts';
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

  it('refuses a redirect URI that is not a URL', () => {
    const { store } = freshStore();
    expect(() => store.create({ ...FIELDS, redirectUris: ['not a url'] })).toThrow(/redirectUris/);
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
