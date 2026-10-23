import { createHash, randomBytes } from 'node:crypto';
import { FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { DataDocument } from '../db/document.ts';

/** One browser signed in to the protected sites, as the file holds it. */
export interface ProxySession {
  userId: string;
  /** The provider grant the sign-in was made under. Signing out at the provider revokes it, which ends this too. */
  grantId: string;
  /** How the user signed in (RFC 8176), as the code said. */
  amr: string[];
  /** `mfa` with a second factor, `pwd` without. */
  acr: string;
  /** When it ends however much it is used, in epoch milliseconds. */
  expiresAt: number;
  /** The last request it was seen on, in epoch milliseconds, at `touchSeconds` granularity. */
  lastSeenAt: number;
}

/** Sessions by the SHA-256 of their token, so the file alone cannot be replayed as a cookie. */
export type ProxySessionDocument = Record<string, ProxySession>;

/** What a sign-in starts a session with. */
export type NewProxySession = Pick<ProxySession, 'userId' | 'grantId' | 'amr' | 'acr'>;

/**
 * The forward auth sessions: a cookie on the parent domain the protected sites share. A session is only as good as
 * its user and its provider grant, which the verify endpoint checks on every request; that is how a sign-out at
 * the provider, an admin ending sessions, or disabling or removing the user ends it.
 */
export interface ProxySessionStore {
  /**
   * Starts a session.
   *
   * @param session - Who signed in, under which grant, and how.
   * @returns The token for the cookie.
   */
  create: (session: NewProxySession) => Promise<string>;
  /**
   * Looks a session up, and notes the request on it at most every `touchSeconds`.
   *
   * @param token - The cookie's value.
   * @returns It, or null when it is unknown, past its lifetime or idle too long.
   */
  use: (token: string) => Promise<ProxySession | null>;
  /**
   * Ends a session. Unknown tokens are ignored.
   *
   * @param token - The cookie's value.
   */
  remove: (token: string) => Promise<void>;
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
 * Opens the proxy session store on its file.
 *
 * @param file - The file holding the sessions.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store. Dead sessions are dropped whenever it writes.
 */
export function createProxySessionStore(
  file: DataDocument<ProxySessionDocument>,
  now: () => number = Date.now,
): ProxySessionStore {
  const { sessionSeconds, idleSeconds, touchSeconds, tokenBytes } = FORWARD_AUTH_DEFAULTS;
  const isAlive = (session: ProxySession, at: number): boolean =>
    session.expiresAt > at && session.lastSeenAt + idleSeconds * MS_PER_SECOND > at;
  const liveExcept = (sessions: ProxySessionDocument, droppedKey: string | null): ProxySessionDocument => {
    const at = now();
    return Object.fromEntries(
      Object.entries(sessions).filter(([key, session]) => isAlive(session, at) && key !== droppedKey),
    );
  };

  return {
    create: async (session) => {
      const token = randomBytes(tokenBytes).toString('base64url');
      const at = now();
      const stored: ProxySession = { ...session, expiresAt: at + sessionSeconds * MS_PER_SECOND, lastSeenAt: at };
      await file.update((sessions) => ({ ...liveExcept(sessions, null), [digest(token)]: stored }));
      return token;
    },
    use: async (token) => {
      const key = digest(token);
      const session = file.read()[key];
      const at = now();
      if (session === undefined || isAlive(session, at) === false) {
        return null;
      }
      const isStale = at - session.lastSeenAt >= touchSeconds * MS_PER_SECOND;
      if (isStale) {
        await file.update((sessions) => ({ ...liveExcept(sessions, null), [key]: { ...session, lastSeenAt: at } }));
      }
      return session;
    },
    remove: async (token) => {
      const key = digest(token);
      await file.update((sessions) => liveExcept(sessions, key));
    },
  };
}
