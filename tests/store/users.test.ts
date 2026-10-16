import path from 'node:path';
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
  it('signs a user in with their password and not with another', () => {
    const { store } = freshStore();
    const created = store.create(NEW_USER);
    expect(store.authenticate('ada', 'correct horse')).toEqual(created);
    expect(store.authenticate('ada', 'wrong horse')).toBeNull();
    expect(store.authenticate('bob', 'correct horse')).toBeNull();
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

  it('changes the password', () => {
    const { store } = freshStore();
    const { id } = store.create(NEW_USER);
    store.setPassword(id, 'battery staple');
    expect(store.authenticate('ada', 'correct horse')).toBeNull();
    expect(store.authenticate('ada', 'battery staple')).not.toBeNull();
  });
});
