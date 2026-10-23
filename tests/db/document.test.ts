import { type DataDocument, loosen, openDocument, replaceDocument } from '../../server/db/document.ts';
import { BRANDING_DOCUMENT, USERS_DOCUMENT } from '../../server/db/documents.ts';
import { users } from '../../server/db/schema.ts';
import type { User } from '../../server/store/users.ts';
import { createTestStore, type TestStore } from '../db.ts';

/**
 * Makes a user as the user store keeps one.
 *
 * @param username - Their username, which the table keeps unique.
 * @param [id] - Their id.
 * @returns The user.
 */
function userNamed(username: string, id = `id-${username}`): User {
  return {
    id,
    username,
    passwordHash: '',
    email: '',
    name: username,
    groups: [],
    claims: {},
    disabled: false,
    createdAt: new Date(0).toISOString(),
    pictureVersion: null,
  };
}

describe('data document', () => {
  let store: TestStore;
  let document: DataDocument<User[]>;

  beforeEach(async () => {
    store = await createTestStore();
    document = await openDocument(store, USERS_DOCUMENT);
  });

  afterEach(() => store.close());

  it('starts from the fallback when its tables are empty', () => {
    expect(document.read()).toEqual(USERS_DOCUMENT.fallback);
  });

  it('saves a change, which a document opened again reads back', async () => {
    await document.update((list) => [...list, userNamed('ada')]);
    const reopened = await openDocument(store, USERS_DOCUMENT);
    expect(reopened.read()).toEqual([userNamed('ada')]);
  });

  it('answers a read with a change at once, before it is saved', async () => {
    const saving = document.update((list) => [...list, userNamed('ada')]);
    expect(document.read().map((user) => user.username)).toEqual(['ada']);
    await saving;
  });

  it('writes changed and removed rows, and leaves the others', async () => {
    await document.update(() => [userNamed('ada'), userNamed('bob')]);
    await document.update(([ada]) => (ada === undefined ? [] : [{ ...ada, name: 'Ada Lovelace' }]));
    const rows = await store.db.select().from(users);
    expect(rows.map(({ username, name }) => ({ username, name }))).toEqual([{ username: 'ada', name: 'Ada Lovelace' }]);
  });

  it('rejects a change the database refuses, and goes back to what the tables hold', async () => {
    await document.update(() => [userNamed('ada')]);
    // The table keeps usernames unique; the user store checks it first, so only a raw document can break it.
    const refused = document.update((list) => [...list, userNamed('ada', 'another-id')]);
    await expect(refused).rejects.toThrow();
    expect(document.read()).toEqual([userNamed('ada')]);
    expect(await store.db.select().from(users)).toHaveLength(1);
  });

  it('drops a change made on top of one that fails, and takes the next one', async () => {
    await document.update(() => [userNamed('ada')]);
    const refused = document.update((list) => [...list, userNamed('ada', 'another-id')]);
    const onTop = document.update((list) => [...list, userNamed('bob')]);
    await expect(refused).rejects.toThrow();
    await expect(onTop).rejects.toThrow(/dropped/);
    expect(document.read().map((user) => user.username)).toEqual(['ada']);

    await document.update((list) => [...list, userNamed('cy')]);
    const reopened = await openDocument(store, USERS_DOCUMENT);
    expect(reopened.read().map((user) => user.username)).toEqual(['ada', 'cy']);
  });

  it('reads its tables again on reload', async () => {
    const other = await openDocument(store, USERS_DOCUMENT);
    await other.update(() => [userNamed('ada')]);
    expect(document.read()).toEqual([]);
    await document.reload();
    expect(document.read()).toEqual([userNamed('ada')]);
  });

  it('reads a document an older version wrote, filling in what it lacks', async () => {
    const { claims: _claims, disabled: _disabled, pictureVersion: _pictureVersion, ...older } = userNamed('ada');
    await store.db.transaction((tx) => replaceDocument(tx, loosen(USERS_DOCUMENT), [older]));
    const reopened = await openDocument(store, USERS_DOCUMENT);
    expect(reopened.read()).toEqual([userNamed('ada')]);
  });
});

describe('a document kept as one row', () => {
  let store: TestStore;

  beforeEach(async () => {
    store = await createTestStore();
  });

  afterEach(() => store.close());

  it('saves its first change, made on the fallback', async () => {
    const branding = await openDocument(store, BRANDING_DOCUMENT);
    await branding.update(() => ({ name: 'Home' }));
    const reopened = await openDocument(store, BRANDING_DOCUMENT);
    expect(reopened.read()).toEqual({ name: 'Home' });
  });
});
