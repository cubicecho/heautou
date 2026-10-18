import path from 'node:path';
import { API_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { SCOPES } from '../../server/oidc/provider.ts';
import {
  type Api,
  createApiStore,
  identifierProblem,
  TOKEN_FORMAT_JWT,
  TOKEN_FORMAT_OPAQUE,
} from '../../server/store/apis.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { tempDir } from '../helpers.ts';

const IDENTIFIER = 'https://photos-api.home.lan';
const KNOWN_CLIENTS = ['photos', 'backup'];

/**
 * Opens an API store on a fresh file, with two clients that exist.
 *
 * @returns The store and the file's path.
 */
function freshStore() {
  const file = path.join(tempDir(), 'apis.json');
  const open = () =>
    createApiStore(openJsonFile<Api[]>(file, []), {
      clientExists: (clientId) => KNOWN_CLIENTS.includes(clientId),
      reservedScopes: SCOPES,
      now: () => new Date('2026-10-18T00:00:00Z'),
    });
  return { open, store: open() };
}

const badInput = expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.BadUserInput }) });

describe('API store', () => {
  it('saves an API with JWT tokens and no lifetime of its own by default', () => {
    const { open, store } = freshStore();
    const api = store.create({
      identifier: ` ${IDENTIFIER} `,
      name: 'Photos API',
      scopes: ['photos:read', 'photos:read'],
    });
    expect(api).toEqual({
      identifier: IDENTIFIER,
      name: 'Photos API',
      scopes: ['photos:read'],
      tokenFormat: TOKEN_FORMAT_JWT,
      accessTokenSeconds: null,
      allowedClientIds: [],
      createdAt: '2026-10-18T00:00:00.000Z',
    });
    expect(open().find(IDENTIFIER)).toEqual(api);
  });

  it('takes only an absolute URI with no fragment as the identifier', () => {
    expect(identifierProblem(IDENTIFIER)).toBeNull();
    expect(identifierProblem('urn:home:photos')).toBeNull();
    expect(identifierProblem('/photos')).toContain('absolute URI');
    expect(identifierProblem('https://photos api.home.lan')).toContain('absolute URI');
    expect(identifierProblem(`${IDENTIFIER}#v1`)).toContain('fragment');
    const { store } = freshStore();
    expect(() => store.create({ identifier: 'photos', name: 'Photos' })).toThrow(badInput);
    store.create({ identifier: IDENTIFIER, name: 'Photos' });
    expect(() => store.create({ identifier: IDENTIFIER, name: 'Again' })).toThrow(/already taken/);
  });

  it('refuses the provider’s own scopes and malformed ones', () => {
    const { store } = freshStore();
    expect(() => store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['openid'] })).toThrow(
      /provider's \(openid/,
    );
    expect(() => store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['photos read'] })).toThrow(badInput);
    expect(() => store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['say"hi'] })).toThrow(badInput);
  });

  it('keeps the lifetime within its bounds', () => {
    const { store } = freshStore();
    const { minAccessTokenSeconds, maxAccessTokenSeconds } = API_DEFAULTS;
    expect(() =>
      store.create({ identifier: IDENTIFIER, name: 'Photos', accessTokenSeconds: minAccessTokenSeconds - 1 }),
    ).toThrow(/at least/);
    expect(() =>
      store.create({ identifier: IDENTIFIER, name: 'Photos', accessTokenSeconds: maxAccessTokenSeconds + 1 }),
    ).toThrow(/at most/);
  });

  it('names only clients that exist', () => {
    const { store } = freshStore();
    expect(() => store.create({ identifier: IDENTIFIER, name: 'Photos', allowedClientIds: ['ghost'] })).toThrow(
      /"ghost"/,
    );
  });

  it('keeps what an update leaves out, and clears the lifetime on null', () => {
    const { store } = freshStore();
    store.create({
      identifier: IDENTIFIER,
      name: 'Photos',
      scopes: ['photos:read'],
      accessTokenSeconds: 300,
      allowedClientIds: ['photos'],
    });
    const renamed = store.update(IDENTIFIER, { name: 'Photo library', tokenFormat: TOKEN_FORMAT_OPAQUE });
    expect(renamed).toMatchObject({
      name: 'Photo library',
      tokenFormat: TOKEN_FORMAT_OPAQUE,
      scopes: ['photos:read'],
      accessTokenSeconds: 300,
      allowedClientIds: ['photos'],
    });
    expect(store.update(IDENTIFIER, { accessTokenSeconds: null }).accessTokenSeconds).toBeNull();
    expect(() => store.update('https://nowhere.home.lan', { name: 'x' })).toThrow(/No API/);
  });

  it('takes a removed client off every API', () => {
    const { store } = freshStore();
    store.create({ identifier: IDENTIFIER, name: 'Photos', allowedClientIds: ['photos', 'backup'] });
    store.create({ identifier: 'https://notes-api.home.lan', name: 'Notes', allowedClientIds: ['photos'] });
    store.removeClient('photos');
    expect(store.list().map((api) => api.allowedClientIds)).toEqual([['backup'], []]);
    expect(store.remove(IDENTIFIER).name).toBe('Photos');
    expect(store.find(IDENTIFIER)).toBeNull();
  });
});
