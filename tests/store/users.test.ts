import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { openDocument } from '../../server/db/document.ts';
import { USERS_DOCUMENT } from '../../server/db/documents.ts';
import { users } from '../../server/db/schema.ts';
import { createUserStore, type UserStore } from '../../server/store/users.ts';
import { createTestStore, type TestStore } from '../db.ts';

const NEW_USER = {
  username: 'ada',
  password: 'correct horse',
  email: 'ada@example.com',
  name: 'Ada',
  groups: ['admins'],
};

describe('user store', () => {
  let db: TestStore;
  let store: UserStore;

  beforeEach(async () => {
    db = await createTestStore();
    store = createUserStore(await openDocument(db, USERS_DOCUMENT));
  });

  afterEach(() => db.close());

  it('signs a user in with their password and not with another', async () => {
    const created = await store.create(NEW_USER);
    expect(await store.authenticate('ada', 'correct horse')).toEqual(created);
    expect(await store.authenticate('ada', 'wrong horse')).toBeNull();
    expect(await store.authenticate('bob', 'correct horse')).toBeNull();
  });

  it('never returns or stores the password itself', async () => {
    const created = await store.create(NEW_USER);
    expect(created).not.toHaveProperty('passwordHash');
    const rows = await db.db.select().from(users);
    expect(rows[0]?.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(rows)).not.toContain('correct horse');
  });

  it('refuses a short password', async () => {
    await expect(store.create({ ...NEW_USER, password: 'short' })).rejects.toThrow(/password/);
  });

  it('refuses a taken username', async () => {
    await store.create(NEW_USER);
    await expect(store.create(NEW_USER)).rejects.toThrow(/ada/);
  });

  it('changes the password', async () => {
    const { id } = await store.create(NEW_USER);
    await store.setPassword(id, 'battery staple');
    expect(await store.authenticate('ada', 'correct horse')).toBeNull();
    expect(await store.authenticate('ada', 'battery staple')).not.toBeNull();
  });

  it('keeps the last admin', async () => {
    const admin = await store.create({ ...NEW_USER, groups: [ADMIN_DEFAULTS.group] });
    expect(store.hasAdmin()).toBe(true);
    await expect(store.update(admin.id, { ...NEW_USER, groups: [] })).rejects.toThrow(ADMIN_DEFAULTS.group);
    await expect(store.remove(admin.id)).rejects.toThrow(ADMIN_DEFAULTS.group);

    const other = await store.create({ ...NEW_USER, username: 'bob', groups: [ADMIN_DEFAULTS.group] });
    await store.remove(admin.id);
    expect(store.list().map((user) => user.id)).toEqual([other.id]);
  });

  it('lets a store with no admin change freely', async () => {
    const { id } = await store.create(NEW_USER);
    expect(store.hasAdmin()).toBe(false);
    expect((await store.remove(id)).username).toBe('ada');
  });

  it('reads back what it saved', async () => {
    const created = await store.create({ ...NEW_USER, claims: [{ name: 'team', value: 'ops' }] });
    const reopened = createUserStore(await openDocument(db, USERS_DOCUMENT));
    expect(reopened.find(created.id)).toEqual(created);
  });
});
