import { API_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { openDocument } from '../../server/db/document.ts';
import { APIS_DOCUMENT } from '../../server/db/documents.ts';
import { SCOPES } from '../../server/oidc/provider.ts';
import {
  type Api,
  type ApiStore,
  createApiStore,
  identifierProblem,
  TOKEN_FORMAT_JWT,
  TOKEN_FORMAT_OPAQUE,
} from '../../server/store/apis.ts';
import { createTestStore, type TestStore } from '../db.ts';

const IDENTIFIER = 'https://photos-api.home.lan';
const KNOWN_CLIENTS = ['photos', 'backup'];

const badInput = expect.objectContaining({ extensions: expect.objectContaining({ code: ErrorCode.BadUserInput }) });

describe('API store', () => {
  let db: TestStore;
  let store: ApiStore;

  /**
   * Opens an API store on the test database, with two clients that exist.
   *
   * @returns The store.
   */
  async function open(): Promise<ApiStore> {
    return createApiStore(await openDocument(db, APIS_DOCUMENT), {
      clientExists: (clientId) => KNOWN_CLIENTS.includes(clientId),
      reservedScopes: SCOPES,
      now: () => Date.parse('2026-10-18T00:00:00Z'),
    });
  }

  beforeEach(async () => {
    db = await createTestStore();
    store = await open();
  });

  afterEach(() => db.close());

  it('saves an API with JWT tokens and no lifetime of its own by default', async () => {
    const api = await store.create({
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
    expect((await open()).find(IDENTIFIER)).toEqual(api);
  });

  it('takes only an absolute URI with no fragment as the identifier', async () => {
    expect(identifierProblem(IDENTIFIER)).toBeNull();
    expect(identifierProblem('urn:home:photos')).toBeNull();
    expect(identifierProblem('/photos')).toContain('absolute URI');
    expect(identifierProblem('https://photos api.home.lan')).toContain('absolute URI');
    expect(identifierProblem(`${IDENTIFIER}#v1`)).toContain('fragment');
    await expect(store.create({ identifier: 'photos', name: 'Photos' })).rejects.toThrow(badInput);
    await store.create({ identifier: IDENTIFIER, name: 'Photos' });
    await expect(store.create({ identifier: IDENTIFIER, name: 'Again' })).rejects.toThrow(/already taken/);
  });

  it('refuses the provider’s own scopes and malformed ones', async () => {
    await expect(store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['openid'] })).rejects.toThrow(
      /provider's \(openid/,
    );
    await expect(store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['photos read'] })).rejects.toThrow(
      badInput,
    );
    await expect(store.create({ identifier: IDENTIFIER, name: 'Photos', scopes: ['say"hi'] })).rejects.toThrow(
      badInput,
    );
  });

  it('keeps the lifetime within its bounds', async () => {
    const { minAccessTokenSeconds, maxAccessTokenSeconds } = API_DEFAULTS;
    await expect(
      store.create({ identifier: IDENTIFIER, name: 'Photos', accessTokenSeconds: minAccessTokenSeconds - 1 }),
    ).rejects.toThrow(/at least/);
    await expect(
      store.create({ identifier: IDENTIFIER, name: 'Photos', accessTokenSeconds: maxAccessTokenSeconds + 1 }),
    ).rejects.toThrow(/at most/);
  });

  it('names only clients that exist', async () => {
    await expect(store.create({ identifier: IDENTIFIER, name: 'Photos', allowedClientIds: ['ghost'] })).rejects.toThrow(
      /"ghost"/,
    );
  });

  it('keeps what an update leaves out, and clears the lifetime on null', async () => {
    await store.create({
      identifier: IDENTIFIER,
      name: 'Photos',
      scopes: ['photos:read'],
      accessTokenSeconds: 300,
      allowedClientIds: ['photos'],
    });
    const renamed = await store.update(IDENTIFIER, { name: 'Photo library', tokenFormat: TOKEN_FORMAT_OPAQUE });
    expect(renamed).toMatchObject({
      name: 'Photo library',
      tokenFormat: TOKEN_FORMAT_OPAQUE,
      scopes: ['photos:read'],
      accessTokenSeconds: 300,
      allowedClientIds: ['photos'],
    });
    expect((await store.update(IDENTIFIER, { accessTokenSeconds: null })).accessTokenSeconds).toBeNull();
    await expect(store.update('https://nowhere.home.lan', { name: 'x' })).rejects.toThrow(/No API/);
  });

  it('takes a removed client off every API', async () => {
    await store.create({ identifier: IDENTIFIER, name: 'Photos', allowedClientIds: ['photos', 'backup'] });
    await store.create({ identifier: 'https://notes-api.home.lan', name: 'Notes', allowedClientIds: ['photos'] });
    await store.removeClient('photos');
    expect(store.list().map((api) => api.allowedClientIds)).toEqual([['backup'], []]);
    expect((await store.remove(IDENTIFIER)).name).toBe('Photos');
    expect(store.find(IDENTIFIER)).toBeNull();
  });

  it('reads back what was saved when opened again on the same database', async () => {
    await store.create({ identifier: IDENTIFIER, name: 'Photos', allowedClientIds: ['photos', 'backup'] });
    await store.create({ identifier: 'https://notes-api.home.lan', name: 'Notes', allowedClientIds: ['photos'] });
    await store.removeClient('photos');
    // Both were made in the same millisecond, which the database orders by identifier rather than by creation.
    const byIdentifier = (list: readonly Api[]): Api[] =>
      list.toSorted((a, b) => a.identifier.localeCompare(b.identifier));
    expect(byIdentifier((await open()).list())).toEqual(byIdentifier(store.list()));
  });
});
