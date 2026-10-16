import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ADMIN_DEFAULTS, CREDENTIAL_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { JsonFile } from './json-file.ts';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.ts';

/** Someone who can sign in through the provider. */
export interface User {
  /** The stable `sub` clients see. Never changes, even when the username does. */
  id: string;
  /** What they type to sign in, and the `preferred_username` claim. */
  username: string;
  /** What `hashPassword` made of their password. Never sent to the web app. */
  passwordHash: string;
  email: string;
  /** The `name` claim. */
  name: string;
  /** The `groups` claim, which many self-hosted apps map to roles. */
  groups: string[];
  /** When they were added, as an ISO 8601 string. */
  createdAt: string;
}

/** A user without the password hash: what leaves the store. */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * Says whether a user may use the admin UI.
 *
 * @param user - The user.
 * @returns True when their groups hold `ADMIN_DEFAULTS.group`.
 */
export function isAdmin(user: Pick<User, 'groups'>): boolean {
  return user.groups.includes(ADMIN_DEFAULTS.group);
}

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]+$/;

const passwordSchema = z
  .string()
  .min(CREDENTIAL_DEFAULTS.minPasswordLength, `use at least ${CREDENTIAL_DEFAULTS.minPasswordLength} characters`);

/** What the operator writes when adding or changing a user, the password aside. */
const userFieldsSchema = z.object({
  username: z.string().trim().regex(USERNAME_PATTERN, 'use letters, digits, ".", "-", "_" and "@" only'),
  email: z.email().trim().or(z.literal('')),
  name: z.string().trim(),
  groups: z.array(z.string().trim().min(1)).transform((groups) => [...new Set(groups)]),
});
export type UserFields = z.input<typeof userFieldsSchema>;

const newUserSchema = userFieldsSchema.extend({ password: passwordSchema });
export type NewUser = z.input<typeof newUserSchema>;

/** The users, kept in one JSON file. */
export interface UserStore {
  list: () => PublicUser[];
  find: (id: string) => PublicUser | null;
  create: (input: NewUser) => PublicUser;
  update: (id: string, input: UserFields) => PublicUser;
  setPassword: (id: string, password: string) => PublicUser;
  remove: (id: string) => PublicUser;
  /** Whether any user is an admin. While none is, the server offers a setup link instead of the admin UI. */
  hasAdmin: () => boolean;
  /**
   * Checks a sign-in. An unknown username takes as long to refuse as a wrong password.
   *
   * @param username - What was typed as the username.
   * @param password - What was typed as the password.
   * @returns The user, or null when either is wrong.
   */
  authenticate: (username: string, password: string) => Promise<PublicUser | null>;
}

/**
 * Drops the password hash.
 *
 * @param user - The stored user.
 * @returns The user as the rest of the server sees it.
 */
function toPublic({ passwordHash: _hash, ...user }: User): PublicUser {
  return user;
}

/**
 * Builds the user store over a JSON file.
 *
 * @param file - The file holding every user.
 * @param [now] - The clock, for `createdAt`.
 * @returns The store.
 */
export function createUserStore(file: JsonFile<User[]>, now: () => Date = () => new Date()): UserStore {
  const findStored = (id: string): User | null => file.read().find((user) => user.id === id) ?? null;

  const load = (id: string): User => {
    const user = findStored(id);
    if (user === null) {
      throw notFound(`No user has the ID "${id}".`);
    }
    return user;
  };

  const assertUsernameFree = (username: string, exceptId: string | null): void => {
    const isTaken = file.read().some((user) => user.username === username && user.id !== exceptId);
    if (isTaken) {
      throw badInput(`username: "${username}" is already taken.`);
    }
  };

  /**
   * Refuses a change that would leave no admin, which would lock everyone out of the admin UI. A store
   * with no admin yet may change freely: the setup link makes the first one.
   */
  const assertAdminRemains = (next: User[]): void => {
    const isLosingLastAdmin = file.read().some(isAdmin) && next.some(isAdmin) === false;
    if (isLosingLastAdmin) {
      throw badInput(`groups: keep at least one user in "${ADMIN_DEFAULTS.group}", or no one can sign in here.`);
    }
  };

  const write = (change: (users: User[]) => User[]): void => {
    const next = change(file.read());
    assertAdminRemains(next);
    file.update(() => next);
  };

  const replace = (next: User): PublicUser => {
    write((users) => users.map((user) => (user.id === next.id ? next : user)));
    return toPublic(next);
  };

  return {
    list: () => file.read().map(toPublic),
    find: (id) => {
      const user = findStored(id);
      return user === null ? null : toPublic(user);
    },
    create: (input) => {
      const { password, ...fields } = parseInput(newUserSchema, input);
      assertUsernameFree(fields.username, null);
      const user: User = {
        ...fields,
        id: randomUUID(),
        passwordHash: hashPassword(password),
        createdAt: now().toISOString(),
      };
      write((users) => [...users, user]);
      return toPublic(user);
    },
    update: (id, input) => {
      const fields = parseInput(userFieldsSchema, input);
      assertUsernameFree(fields.username, id);
      return replace({ ...load(id), ...fields });
    },
    setPassword: (id, password) => {
      const parsed = parseInput(passwordSchema, password);
      return replace({ ...load(id), passwordHash: hashPassword(parsed) });
    },
    remove: (id) => {
      const user = load(id);
      write((users) => users.filter((other) => other.id !== id));
      return toPublic(user);
    },
    hasAdmin: () => file.read().some(isAdmin),
    authenticate: async (username, password) => {
      const user = file.read().find((candidate) => candidate.username === username) ?? null;
      const isMatch = await verifyPassword(password, user?.passwordHash ?? dummyPasswordHash());
      return user !== null && isMatch ? toPublic(user) : null;
    },
  };
}
