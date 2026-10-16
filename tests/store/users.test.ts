import { statSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { createUserStore, type User } from '../../server/store/users.ts';
import { tempDir } from '../helpers.ts';

const NEW_USER = {
  username: 'ada',
  password: 'correct horse',
  email: 'ada@example.com',
  name: 'Ada',
  groups: ['admins'],
};

/**
 * Opens a user store on a fresh file.
 *
 * @returns The store and the file's path.
 */
function freshStore() {
  const file = path.join(tempDir(), 'users.json');
  return { file, store: createUserStore(openJsonFile<User[]>(file, [])) };
}

describe('user store', () => {
  it('signs a user in with their password and not with another', async () => {
    const { store } = freshStore();
    const created = store.create(NEW_USER);
    expect(await store.authenticate('ada', 'correct horse')).toEqual(created);
    expect(await store.authenticate('ada', 'wrong horse')).toBeNull();
    expect(await store.authenticate('bob', 'correct horse')).toBeNull();
  });

  it('never returns or stores the password itself', () => {
    const { file, store } = freshStore();
    const created = store.create(NEW_USER);
    expect(created).not.toHaveProperty('passwordHash');
    const stored = openJsonFile<User[]>(file, []).read();
    expect(stored[0]?.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(stored)).not.toContain('correct horse');
  });

  it('refuses a short password', () => {
    const { store } = freshStore();
    expect(() => store.create({ ...NEW_USER, password: 'short' })).toThrow(/password/);
  });

  it('refuses a taken username', () => {
    const { store } = freshStore();
    store.create(NEW_USER);
    expect(() => store.create(NEW_USER)).toThrow(/ada/);
  });

  it('changes the password', async () => {
    const { store } = freshStore();
    const { id } = store.create(NEW_USER);
    store.setPassword(id, 'battery staple');
    expect(await store.authenticate('ada', 'correct horse')).toBeNull();
    expect(await store.authenticate('ada', 'battery staple')).not.toBeNull();
  });

  it('keeps the last admin', () => {
    const { store } = freshStore();
    const admin = store.create({ ...NEW_USER, groups: [ADMIN_DEFAULTS.group] });
    expect(store.hasAdmin()).toBe(true);
    expect(() => store.update(admin.id, { ...NEW_USER, groups: [] })).toThrow(ADMIN_DEFAULTS.group);
    expect(() => store.remove(admin.id)).toThrow(ADMIN_DEFAULTS.group);

    const other = store.create({ ...NEW_USER, username: 'bob', groups: [ADMIN_DEFAULTS.group] });
    store.remove(admin.id);
    expect(store.list().map((user) => user.id)).toEqual([other.id]);
  });

  it('lets a store with no admin change freely', () => {
    const { store } = freshStore();
    const { id } = store.create(NEW_USER);
    expect(store.hasAdmin()).toBe(false);
    expect(store.remove(id).username).toBe('ada');
  });

  it('keeps its file readable by the owner only', () => {
    const { file, store } = freshStore();
    store.create(NEW_USER);
    const OWNER_ONLY = 0o600;
    const PERMISSION_BITS = 0o777;
    expect(statSync(file).mode & PERMISSION_BITS).toBe(OWNER_ONLY);
  });
});
