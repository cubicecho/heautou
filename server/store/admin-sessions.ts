import { createHash, randomBytes } from 'node:crypto';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { JsonFile } from './json-file.ts';

/** One signed-in admin browser. */
interface AdminSession {
  userId: string;
  /** In epoch milliseconds. */
  expiresAt: number;
}

/** Sessions by the SHA-256 of their token, so the file alone cannot be replayed as a cookie. */
export type AdminSessionDocument = Record<string, AdminSession>;

/** The admin UI's sessions. */
export interface AdminSessionStore {
  /**
   * Starts a session.
   *
   * @param userId - Who signed in.
   * @returns The token for the cookie.
   */
  create: (userId: string) => string;
  /**
   * Looks a session up.
   *
   * @param token - The cookie's value.
   * @returns Whose it is, or null when it is unknown or expired.
   */
  find: (token: string) => string | null;
  /**
   * Ends a session. Unknown tokens are ignored.
   *
   * @param token - The cookie's value.
   */
  remove: (token: string) => void;
}

/**
 * Hashes a session token for storage.
 *
 * @param token - The token.
 * @returns Its SHA-256, base64url.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Opens the admin session store on its file.
 *
 * @param file - The file holding the sessions.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Expired sessions are dropped whenever it writes.
 */
export function createAdminSessionStore(
  file: JsonFile<AdminSessionDocument>,
  now: () => number = Date.now,
): AdminSessionStore {
  const live = (sessions: AdminSessionDocument): AdminSessionDocument =>
    Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.expiresAt > now()));

  return {
    create: (userId) => {
      const token = randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
      const expiresAt = now() + ADMIN_DEFAULTS.sessionSeconds * MS_PER_SECOND;
      file.update((sessions) => ({ ...live(sessions), [digest(token)]: { userId, expiresAt } }));
      return token;
    },
    find: (token) => {
      const session = file.read()[digest(token)];
      const isLive = session !== undefined && session.expiresAt > now();
      return isLive ? session.userId : null;
    },
    remove: (token) => {
      const key = digest(token);
      file.update((sessions) => Object.fromEntries(Object.entries(live(sessions)).filter(([other]) => other !== key)));
    },
  };
}
