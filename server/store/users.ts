import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ADMIN_DEFAULTS, CREDENTIAL_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import { customClaimsSchema, replaceGroupIn, withoutBlanks } from './claims.ts';
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
  /** Claims of the operator's own, by name, released with the `profile` scope. */
  claims: Record<string, string>;
  /** A disabled user cannot sign in, and their sessions and tokens were ended when they were disabled. */
  disabled: boolean;
  /** When they were added, as an ISO 8601 string. */
  createdAt: string;
  /**
   * Which profile picture they have in the bucket: a hash of its bytes, which versions its URL. Null for none.
   */
  pictureVersion: string | null;
}

/** A user without the password hash: what leaves the store. */
export type PublicUser = Omit<User, 'passwordHash'> & {
  /** False for an invited user who has not set a password yet. */
  hasPassword: boolean;
};

/**
 * Says whether a user may use the admin UI.
 *
 * @param user - The user.
 * @returns True when their groups hold `ADMIN_DEFAULTS.group`.
 */
export function isAdmin(user: Pick<User, 'groups'>): boolean {
  return user.groups.includes(ADMIN_DEFAULTS.group);
}

/**
 * Says whether a user can sign in to the admin UI now.
 *
 * @param user - The user.
 * @returns True for an admin who is not disabled.
 */
function isActiveAdmin(user: Pick<User, 'groups' | 'disabled'>): boolean {
  return isAdmin(user) && user.disabled === false;
}

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]+$/;

export const passwordSchema = z
  .string()
  .min(CREDENTIAL_DEFAULTS.minPasswordLength, `use at least ${CREDENTIAL_DEFAULTS.minPasswordLength} characters`);

/** What the operator writes when adding or changing a user, the password aside. */
const userFieldsSchema = z.object({
  username: z.string().trim().regex(USERNAME_PATTERN, 'use letters, digits, ".", "-", "_" and "@" only'),
  email: z.email().trim().or(z.literal('')),
  name: z.string().trim(),
  groups: z.array(z.string().trim().min(1)).transform((groups) => [...new Set(groups)]),
  /** Left out, the user keeps the claims they have. */
  claims: customClaimsSchema.optional(),
});
export type UserFields = z.input<typeof userFieldsSchema>;

/** A user to add. Without a password they are invited: they set one through a password link. */
const newUserSchema = userFieldsSchema.extend({
  password: passwordSchema.optional().or(z.literal('').transform(() => undefined)),
});
export type NewUser = z.input<typeof newUserSchema>;

/**
 * The users. Reads are answered from memory; a change is made in memory at once and resolves when it is saved.
 */
export interface UserStore {
  list: () => PublicUser[];
  find: (id: string) => PublicUser | null;
  create: (input: NewUser) => Promise<PublicUser>;
  update: (id: string, input: UserFields) => Promise<PublicUser>;
  setPassword: (id: string, password: string) => Promise<PublicUser>;
  /** Disables or enables a user. Disabling the last admin who can sign in is refused. */
  setDisabled: (id: string, disabled: boolean) => Promise<PublicUser>;
  /**
   * Records which profile picture a user has. The picture itself is in the bucket.
   *
   * @param id - The user.
   * @param version - The new picture's version, or null when it was removed.
   * @returns The user.
   */
  setPictureVersion: (id: string, version: string | null) => Promise<PublicUser>;
  remove: (id: string) => Promise<PublicUser>;
  /**
   * Renames a group in every user, or takes it off them all.
   *
   * @param from - The group.
   * @param to - Its new name, or null to remove it.
   * @returns How many users had it.
   */
  replaceGroup: (from: string, to: string | null) => Promise<number>;
  /** Whether any user is an admin who is not disabled. While none is, the server offers the setup page. */
  hasAdmin: () => boolean;
  /**
   * Checks a sign-in. An unknown username takes as long to refuse as a wrong password. A disabled user is
   * returned like any other: the caller refuses them, and can say why once the password has matched.
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
function toPublic({ passwordHash, ...user }: User): PublicUser {
  return { ...user, hasPassword: passwordHash !== '' };
}

/**
 * Fills in what a file written by an older version lacks.
 *
 * @param user - The user as read from the file.
 * @returns The user with every field.
 */
function withDefaults(user: User): User {
  return {
    ...user,
    claims: user.claims ?? {},
    disabled: user.disabled ?? false,
    pictureVersion: user.pictureVersion ?? null,
  };
}

/**
 * Builds the user store over its document.
 *
 * @param document - The document holding every user.
 * @param [now] - The clock, for `createdAt`.
 * @returns The store.
 */
export function createUserStore(document: DataDocument<User[]>, now: () => Date = () => new Date()): UserStore {
  const stored = (): User[] => document.read().map(withDefaults);
  const findStored = (id: string): User | null => stored().find((user) => user.id === id) ?? null;

  const load = (id: string): User => {
    const user = findStored(id);
    if (user === null) {
      throw notFound(`No user has the ID "${id}".`);
    }
    return user;
  };

  const assertUsernameFree = (username: string, exceptId: string | null): void => {
    const isTaken = stored().some((user) => user.username === username && user.id !== exceptId);
    if (isTaken) {
      throw badInput(`username: "${username}" is already taken.`);
    }
  };

  /**
   * Refuses a change that would leave no admin, which would lock everyone out of the admin UI. A store
   * with no admin yet may change freely: the setup link makes the first one.
   */
  const assertAdminRemains = (next: User[]): void => {
    const isLosingLastAdmin = stored().some(isActiveAdmin) && next.some(isActiveAdmin) === false;
    if (isLosingLastAdmin) {
      throw badInput(
        `groups: keep at least one enabled user in "${ADMIN_DEFAULTS.group}", or no one can sign in here.`,
      );
    }
  };

  const write = async (change: (users: User[]) => User[]): Promise<void> => {
    const next = change(stored());
    assertAdminRemains(next);
    await document.update(() => next);
  };

  const replace = async (next: User): Promise<PublicUser> => {
    await write((users) => users.map((user) => (user.id === next.id ? next : user)));
    return toPublic(next);
  };

  return {
    list: () => stored().map(toPublic),
    find: (id) => {
      const user = findStored(id);
      return user === null ? null : toPublic(user);
    },
    create: async (input) => {
      const { password, claims = {}, ...fields } = parseInput(newUserSchema, withoutBlanks(input));
      assertUsernameFree(fields.username, null);
      const user: User = {
        ...fields,
        claims,
        disabled: false,
        pictureVersion: null,
        id: randomUUID(),
        passwordHash: password === undefined ? '' : hashPassword(password),
        createdAt: now().toISOString(),
      };
      await write((users) => [...users, user]);
      return toPublic(user);
    },
    update: async (id, input) => {
      const fields = withoutBlanks(parseInput(userFieldsSchema, withoutBlanks(input)));
      assertUsernameFree(fields.username ?? '', id);
      return replace({ ...load(id), ...fields });
    },
    setPassword: async (id, password) => {
      const parsed = parseInput(passwordSchema, password);
      return replace({ ...load(id), passwordHash: hashPassword(parsed) });
    },
    setDisabled: (id, disabled) => replace({ ...load(id), disabled }),
    setPictureVersion: (id, version) => replace({ ...load(id), pictureVersion: version }),
    remove: async (id) => {
      const user = load(id);
      await write((users) => users.filter((other) => other.id !== id));
      return toPublic(user);
    },
    replaceGroup: async (from, to) => {
      const holders = stored().filter((user) => user.groups.includes(from)).length;
      if (holders > 0) {
        await write((users) => users.map((user) => ({ ...user, groups: replaceGroupIn(user.groups, from, to) })));
      }
      return holders;
    },
    hasAdmin: () => stored().some(isActiveAdmin),
    authenticate: async (username, password) => {
      const user = stored().find((candidate) => candidate.username === username) ?? null;
      const isMatch = await verifyPassword(password, user?.passwordHash ?? dummyPasswordHash());
      return user !== null && isMatch ? toPublic(user) : null;
    },
  };
}
