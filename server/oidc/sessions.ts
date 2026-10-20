import { z } from 'zod';
import { MS_PER_SECOND } from '../core/wire.ts';
import { isLive, type ModelDocument, type ModelFiles } from './adapter.ts';
import type { AppLogout, LogoutNotifier } from './backchannel.ts';

/** The provider's models that belong to one signed-in user. */
const ACCOUNT_MODELS = ['Session', 'Grant', 'AccessToken', 'RefreshToken', 'AuthorizationCode', 'DeviceCode'] as const;
/** The models that hang off a grant and end with it. A device code approved but not yet swapped is one. */
const GRANT_MODELS = ['AccessToken', 'RefreshToken', 'AuthorizationCode', 'DeviceCode'] as const;
const SESSION_MODEL = 'Session';
const GRANT_MODEL = 'Grant';

/** What this server reads of a stored provider session. */
const sessionPayloadSchema = z.object({
  accountId: z.string().optional(),
  /** When they signed in, in epoch seconds. */
  loginTs: z.number().optional(),
  authorizations: z
    .record(z.string(), z.object({ grantId: z.string().optional(), sid: z.string().optional() }).loose())
    .optional(),
});

/** One browser signed in to the provider. */
export interface SessionInfo {
  /** The provider's id for it. */
  id: string;
  /** When they signed in, as an ISO 8601 string. */
  signedInAt: string | null;
  /** When it ends unless used, as an ISO 8601 string. */
  expiresAt: string | null;
  /** The clients it signed in to. */
  clientIds: string[];
}

/** Lists and ends the provider's sessions and tokens for one user. */
export interface SessionTools {
  /**
   * Lists a user's live sessions, newest first.
   *
   * @param accountId - The user's id.
   * @returns Their sessions.
   */
  sessionsOf: (accountId: string) => SessionInfo[];
  /**
   * Ends one session, and the grants and tokens it gave clients, then tells the clients it signed in to that have a
   * back-channel logout URI.
   *
   * @param accountId - The user's id.
   * @param sessionId - The session's id.
   * @param ip - The address of the request ending it, for the audit log.
   * @returns False when the user has no such session. A client that can't be told never fails it.
   */
  endSession: (accountId: string, sessionId: string, ip: string | null) => Promise<boolean>;
  /**
   * Ends every session, grant and token of a user, and tells the clients their sessions signed in to that have a
   * back-channel logout URI.
   *
   * @param accountId - The user's id.
   * @param ip - The address of the request ending them, for the audit log.
   * @returns Once the clients have been told. A client that can't be told never fails it.
   *
   * @remarks
   * Other clients find their tokens revoked at the next refresh or userinfo call; ID tokens already issued stay valid
   * until they expire.
   */
  revokeAccount: (accountId: string, ip: string | null) => Promise<void>;
}

/**
 * Drops the entries of one file that a test picks, writing only when one matched.
 *
 * @param files - The model files.
 * @param model - The model.
 * @param drop - Which entries to drop.
 */
function dropWhere(
  files: ModelFiles,
  model: string,
  drop: (key: string, payload: Record<string, unknown>) => boolean,
): void {
  const file = files.open(model);
  const now = files.now();
  const entries = Object.entries(file.read());
  const keep = entries.filter(([key, entry]) => isLive(entry, now) && drop(key, entry.payload) === false);
  if (keep.length !== entries.length) {
    file.update((): ModelDocument => Object.fromEntries(keep));
  }
}

/**
 * Formats epoch milliseconds.
 *
 * @param ms - The time, or null.
 * @returns ISO 8601, or null.
 */
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** What the session tools know of a session besides what they show. */
interface StoredSession extends SessionInfo {
  grantIds: string[];
  /** The clients it signed in to, with the session ID each was given. */
  logouts: AppLogout[];
}

/**
 * Builds the session tools over the provider's model files.
 *
 * @param files - The files the provider's adapter keeps its models in.
 * @param [notifyLogout] - Tells clients the sessions they signed in with have ended.
 * @returns The tools.
 */
export function createSessionTools(files: ModelFiles, notifyLogout: LogoutNotifier = async () => {}): SessionTools {
  const sessionsOf = (accountId: string): StoredSession[] => {
    const now = files.now();
    return Object.entries(files.open(SESSION_MODEL).read())
      .filter(([, entry]) => isLive(entry, now))
      .flatMap(([id, entry]) => {
        const parsed = sessionPayloadSchema.safeParse(entry.payload);
        if (parsed.success === false || parsed.data.accountId !== accountId) {
          return [];
        }
        const { loginTs, authorizations = {} } = parsed.data;
        const grantIds = Object.values(authorizations).flatMap(({ grantId }) =>
          grantId === undefined ? [] : [grantId],
        );
        return [
          {
            id,
            signedInAt: isoOrNull(loginTs === undefined ? null : loginTs * MS_PER_SECOND),
            expiresAt: isoOrNull(entry.expiresAt),
            clientIds: Object.keys(authorizations),
            grantIds,
            logouts: Object.entries(authorizations).map(([clientId, { sid }]) => ({ accountId, clientId, sid })),
          },
        ];
      })
      .sort((a, b) => (b.signedInAt ?? '').localeCompare(a.signedInAt ?? ''));
  };

  return {
    sessionsOf: (accountId) => sessionsOf(accountId).map(({ grantIds: _grantIds, logouts: _logouts, ...info }) => info),
    endSession: async (accountId, sessionId, ip) => {
      const session = sessionsOf(accountId).find((candidate) => candidate.id === sessionId);
      if (session === undefined) {
        return false;
      }
      const grants = new Set(session.grantIds);
      dropWhere(files, SESSION_MODEL, (key) => key === sessionId);
      dropWhere(files, GRANT_MODEL, (key) => grants.has(key));
      for (const model of GRANT_MODELS) {
        dropWhere(files, model, (_key, payload) => grants.has(String(payload.grantId)));
      }
      await notifyLogout(session.logouts, ip);
      return true;
    },
    revokeAccount: async (accountId, ip) => {
      const logouts = sessionsOf(accountId).flatMap((session) => session.logouts);
      for (const model of ACCOUNT_MODELS) {
        dropWhere(files, model, (_key, payload) => payload.accountId === accountId);
      }
      await notifyLogout(logouts, ip);
    },
  };
}
