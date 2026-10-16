import { createHash, randomBytes } from 'node:crypto';
import { CREDENTIAL_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { JsonFile } from './json-file.ts';

/** One link that lets a user set their password without the old one. */
interface PasswordLink {
  userId: string;
  /** In epoch milliseconds. */
  expiresAt: number;
}

/** Links by the SHA-256 of their token, so the file alone does not hold usable links. */
export type PasswordLinkDocument = Record<string, PasswordLink>;

/** A link just made, to hand to the user. */
export interface IssuedLink {
  /** The secret part of the link. Only its hash is kept. */
  token: string;
  /** In epoch milliseconds. */
  expiresAt: number;
}

/** Invite and password reset links. Each user has at most one; making another cancels the last. */
export interface PasswordLinkStore {
  /**
   * Makes a link for a user, cancelling any they had.
   *
   * @param userId - Whose password the link sets.
   * @returns The token and when it stops working.
   */
  issue: (userId: string) => IssuedLink;
  /**
   * Looks a link up without using it.
   *
   * @param token - The link's token.
   * @returns Whose it is, or null when it is unknown, used or expired.
   */
  find: (token: string) => string | null;
  /**
   * Uses a link up.
   *
   * @param token - The link's token.
   * @returns Whose it was, or null when it is unknown, used or expired.
   */
  consume: (token: string) => string | null;
  /**
   * Cancels a user's link, when they are removed or set a password another way.
   *
   * @param userId - The user.
   */
  cancelFor: (userId: string) => void;
}

/**
 * Hashes a link token for storage.
 *
 * @param token - The token.
 * @returns Its SHA-256, base64url.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Opens the password link store on its file.
 *
 * @param file - The file holding the links.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Expired links are dropped whenever it writes.
 */
export function createPasswordLinkStore(
  file: JsonFile<PasswordLinkDocument>,
  now: () => number = Date.now,
): PasswordLinkStore {
  const live = (keep: (link: PasswordLink, key: string) => boolean): PasswordLinkDocument =>
    Object.fromEntries(Object.entries(file.read()).filter(([key, link]) => link.expiresAt > now() && keep(link, key)));

  const find = (token: string): string | null => {
    const link = file.read()[digest(token)];
    return link !== undefined && link.expiresAt > now() ? link.userId : null;
  };

  return {
    issue: (userId) => {
      const token = randomBytes(CREDENTIAL_DEFAULTS.passwordLinkBytes).toString('base64url');
      const expiresAt = now() + CREDENTIAL_DEFAULTS.passwordLinkSeconds * MS_PER_SECOND;
      file.update(() => ({ ...live((link) => link.userId !== userId), [digest(token)]: { userId, expiresAt } }));
      return { token, expiresAt };
    },
    find,
    consume: (token) => {
      const userId = find(token);
      if (userId !== null) {
        const key = digest(token);
        file.update(() => live((_link, other) => other !== key));
      }
      return userId;
    },
    cancelFor: (userId) => {
      const hasLink = Object.values(file.read()).some((link) => link.userId === userId);
      if (hasLink) {
        file.update(() => live((link) => link.userId !== userId));
      }
    },
  };
}
