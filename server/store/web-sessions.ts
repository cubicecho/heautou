import { createHash, randomBytes } from 'node:crypto';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { DataDocument } from '../db/document.ts';

/** One browser signed in to the web app. */
interface WebSession {
  userId: string;
  /** In epoch milliseconds. */
  expiresAt: number;
}

/** Sessions by the SHA-256 of their token, so the file alone cannot be replayed as a cookie. */
export type WebSessionDocument = Record<string, WebSession>;

/**
 * Web sessions: browsers signed in to heautou's web app, which is the admin UI for an admin and the account page for
 * anyone. The cookie, the table and the document keep the admin name they had before there was an account page.
 */
export interface WebSessionStore {
  /**
   * Starts a session.
   *
   * @param userId - Who signed in.
   * @returns The token for the cookie.
   */
  create: (userId: string) => Promise<string>;
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
  remove: (token: string) => Promise<void>;
  /**
   * Ends every session of one user, when they are disabled, removed or sign out everywhere.
   *
   * @param userId - The user.
   */
  removeUser: (userId: string) => Promise<void>;
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
 * Opens the web session store on its document.
 *
 * @param document - The document holding the sessions.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Expired sessions are dropped whenever it writes.
 */
export function createWebSessionStore(
  document: DataDocument<WebSessionDocument>,
  now: () => number = Date.now,
): WebSessionStore {
  const live = (sessions: WebSessionDocument): WebSessionDocument =>
    Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.expiresAt > now()));

  return {
    create: async (userId) => {
      const token = randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
      const expiresAt = now() + ADMIN_DEFAULTS.sessionSeconds * MS_PER_SECOND;
      await document.update((sessions) => ({ ...live(sessions), [digest(token)]: { userId, expiresAt } }));
      return token;
    },
    find: (token) => {
      const session = document.read()[digest(token)];
      const isLive = session !== undefined && session.expiresAt > now();
      return isLive ? session.userId : null;
    },
    remove: async (token) => {
      const key = digest(token);
      await document.update((sessions) =>
        Object.fromEntries(Object.entries(live(sessions)).filter(([other]) => other !== key)),
      );
    },
    removeUser: async (userId) => {
      await document.update((sessions) =>
        Object.fromEntries(Object.entries(live(sessions)).filter(([, session]) => session.userId !== userId)),
      );
    },
  };
}
