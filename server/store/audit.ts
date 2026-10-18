import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { AUDIT_DEFAULTS } from '../core/defaults.ts';
import { DIR_MODE } from './json-file.ts';

/** What happened. One flat vocabulary, so the log can be filtered by it and the UI can name each one. */
export const AuditType = {
  /** A user's password was accepted on the provider's sign-in page. An app or web sign-in follows it. */
  SignInSucceeded: 'sign_in_succeeded',
  /** A provider sign-in with an unknown username or a wrong password. */
  SignInFailed: 'sign_in_failed',
  /** A provider sign-in turned away because of too many failures. */
  SignInThrottled: 'sign_in_throttled',
  /** A provider sign-in by a disabled user, or one outside the client's allowed groups. */
  SignInRefused: 'sign_in_refused',
  /**
   * The provider sent a user back to an application with a code: with the password just typed, or with the session
   * they already had. The detail names the redirect URI.
   */
  AppSignedIn: 'app_signed_in',
  /**
   * The provider turned an application's sign-in request away before anyone signed in, such as an unknown client, a
   * redirect URI it doesn't have or a scope it may not ask for. The detail has the error.
   */
  AppSignInFailed: 'app_sign_in_failed',
  /**
   * The token endpoint refused an application: a wrong client secret, or a code or refresh token that was used
   * already or has expired. The detail has the error and the grant type.
   */
  AppTokenRefused: 'app_token_refused',
  /** A user signed out from inside an application (RP-initiated logout). */
  AppSignedOut: 'app_signed_out',
  /** A client got a token for itself with the client credentials grant, with no user. */
  MachineTokenIssued: 'machine_token_issued',
  /** A user signed in to the admin UI or their account page. */
  WebSignedIn: 'web_signed_in',
  /** A user signed out of the admin UI or their account page. */
  WebSignedOut: 'web_signed_out',
  ClientCreated: 'client_created',
  ClientUpdated: 'client_updated',
  ClientSecretRotated: 'client_secret_rotated',
  ClientDeleted: 'client_deleted',
  PairingStarted: 'pairing_started',
  PairingCancelled: 'pairing_cancelled',
  /** An app registered itself with a setup URL. */
  PairingCompleted: 'pairing_completed',
  /** A paired app changed its own registration (RFC 7592). */
  RegistrationUpdated: 'registration_updated',
  /** A paired app removed its own registration (RFC 7592). */
  RegistrationDeleted: 'registration_deleted',
  UserCreated: 'user_created',
  UserUpdated: 'user_updated',
  UserPasswordSet: 'user_password_set',
  UserDeleted: 'user_deleted',
  UserDisabled: 'user_disabled',
  UserEnabled: 'user_enabled',
  UserSessionEnded: 'user_session_ended',
  UserSignedOut: 'user_signed_out',
  PasswordLinkCreated: 'password_link_created',
  /** Someone set a password through an invite or reset link. */
  PasswordLinkUsed: 'password_link_used',
  GroupRenamed: 'group_renamed',
  GroupDeleted: 'group_deleted',
  KeysRotated: 'keys_rotated',
  BrandingNameSet: 'branding_name_set',
  BrandingLogoSet: 'branding_logo_set',
  /** Plain http redirect URIs allowed, refused, or left to follow the issuer. */
  HttpRedirectsSet: 'http_redirects_set',
  /** The password strength or breach check rule changed. */
  PasswordRulesSet: 'password_rules_set',
  AccountPasswordChanged: 'account_password_changed',
  /** A user's own password change with the wrong current password. */
  AccountPasswordFailed: 'account_password_failed',
  AccountSignedOutEverywhere: 'account_signed_out_everywhere',
  /** The first admin was made, or an existing user was made the admin, through `/setup`. */
  AdminSetUp: 'admin_set_up',
  /** A wrong authenticator code, recovery code or passkey after a password that worked. */
  SecondFactorFailed: 'second_factor_failed',
  /** A user set up an authenticator app on their account page. */
  TotpAdded: 'totp_added',
  /** A user removed their authenticator app. */
  TotpRemoved: 'totp_removed',
  /** A user made new recovery codes, which ends the old ones. */
  RecoveryCodesMade: 'recovery_codes_made',
  /** A user registered a passkey. The detail names it. */
  PasskeyAdded: 'passkey_added',
  /** A user removed a passkey. The detail names it. */
  PasskeyRemoved: 'passkey_removed',
  /** An admin removed every second factor a user had, as for a lost phone. */
  UserSecondFactorsReset: 'user_second_factors_reset',
} as const;
export type AuditType = (typeof AuditType)[keyof typeof AuditType];

/** Every type, in the order above. */
export const AUDIT_TYPES: readonly AuditType[] = Object.values(AuditType);

/**
 * The sign-ins a user is shown on their account page. A password that worked is followed by an app or web sign-in,
 * so `SignInSucceeded` would only say it twice.
 */
export const SIGN_IN_TYPES: readonly AuditType[] = [
  AuditType.SignInFailed,
  AuditType.SignInThrottled,
  AuditType.SignInRefused,
  AuditType.SecondFactorFailed,
  AuditType.AppSignedIn,
  AuditType.AppSignedOut,
  AuditType.WebSignedIn,
];

/** How an app sign-in was made, in its `via` detail. */
export const AppSignInVia = {
  /** The user typed their password for it. */
  Password: 'password',
  /** The user already had a provider session, so nothing was asked. */
  Session: 'session',
  /** The user signed in with a passkey alone. */
  Passkey: 'passkey',
} as const;
export type AppSignInVia = (typeof AppSignInVia)[keyof typeof AppSignInVia];

/** The kinds of thing an entry can be about. */
export const AuditTargetKind = {
  Client: 'client',
  User: 'user',
  Group: 'group',
  Pairing: 'pairing',
  Keys: 'keys',
  Branding: 'branding',
  Settings: 'settings',
} as const;
export type AuditTargetKind = (typeof AuditTargetKind)[keyof typeof AuditTargetKind];

/** The target of key rotations. */
export const KEYS_TARGET: AuditTarget = Object.freeze({
  kind: AuditTargetKind.Keys,
  id: 'signing',
  name: 'Signing keys',
});

/** Who did it. */
export interface AuditActor {
  userId: string;
  username: string;
}

/**
 * Names a user as an entry's actor.
 *
 * @param user - The user.
 * @returns Their id and current username.
 */
export function actorOf(user: { id: string; username: string }): AuditActor {
  return { userId: user.id, username: user.username };
}

/**
 * Names a user as an entry's target.
 *
 * @param user - The user.
 * @returns The target.
 */
export function userTarget(user: { id: string; username: string }): AuditTarget {
  return { kind: AuditTargetKind.User, id: user.id, name: user.username };
}

/** What it was done to. The name is as it was then, so an entry still reads after a rename or delete. */
export interface AuditTarget {
  kind: AuditTargetKind;
  id: string;
  name: string;
}

/**
 * What a caller records. Never put a password, token, secret or setup URL in it: the log is meant to be read by
 * people, and is not hashed or encrypted.
 */
export interface AuditEvent {
  type: AuditType;
  /**
   * The signed-in user who did it, or for a sign-in the account it was for. Null when nobody is known, such as a
   * sign-in with an unknown username or an app managing its own registration.
   */
  actor: AuditActor | null;
  /** The client's address, as Express or Koa sees it behind `TRUST_PROXY`. */
  ip: string | null;
  target?: AuditTarget;
  /** Plain facts worth keeping, such as the username a failed sign-in tried. */
  detail?: Record<string, string>;
}

/** One line of the log. */
export interface AuditEntry extends AuditEvent {
  /** A random id, also the cursor for the next page. */
  id: string;
  /** When, as an ISO 8601 string. */
  at: string;
}

/** Which entries to read. */
export interface AuditQuery {
  /** How many, at most `AUDIT_DEFAULTS.maxPageSize`. */
  first?: number;
  /** The id of the last entry of the page before; the page starts after it. */
  after?: string | null;
  /** Only these types. */
  types?: readonly AuditType[] | null;
  /** Only entries done by this user or done to them. */
  userId?: string | null;
}

/** A page of entries, newest first. */
export interface AuditPage {
  entries: AuditEntry[];
  /** The cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/** The append-only log of who did what. */
export interface AuditLog {
  /**
   * Appends an entry. It never throws: a write that fails is logged and the request goes on.
   *
   * @param event - What happened.
   */
  record: (event: AuditEvent) => void;
  /**
   * Reads entries, newest first, across the current file and the rotated ones.
   *
   * @param query - The filters and the page.
   * @returns The page.
   */
  list: (query: AuditQuery) => AuditPage;
  /**
   * Calls a listener with every entry recorded from now on.
   *
   * @param listener - Called after each append.
   * @returns A function that stops the calls.
   */
  onRecord: (listener: (entry: AuditEntry) => void) => () => void;
}

/** Owner read and write only, like the other data files. */
const FILE_MODE = 0o600;
/** Where the log's own failures are reported. */
const LOG_TAG = '[audit]';

/**
 * Names the files of a log, the current one first, then each rotated one from newest to oldest.
 *
 * @param file - The current file, such as `audit.jsonl`.
 * @param kept - How many rotated files there are at most.
 * @returns `audit.jsonl`, `audit.1.jsonl`, `audit.2.jsonl`...
 */
function filesOf(file: string, kept: number): string[] {
  const extension = path.extname(file);
  const stem = file.slice(0, file.length - extension.length);
  return [file, ...Array.from({ length: kept }, (_, i) => `${stem}.${i + 1}${extension}`)];
}

/**
 * Reads a file's size.
 *
 * @param file - The file.
 * @returns Its size in bytes, or 0 when it is not there.
 */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Checks a parsed line has the fields every entry has. A line cut short by a crash, or edited by hand, is skipped.
 *
 * @param value - The parsed line.
 * @returns Whether it is an entry.
 */
function isEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'id' in value && typeof value.id === 'string' && 'at' in value && typeof value.at === 'string' && 'type' in value
  );
}

/**
 * Reads one file's entries, oldest first.
 *
 * @param file - The file.
 * @returns Its entries; none when it is not there.
 */
function entriesIn(file: string): AuditEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) {
        entries.push(value);
      }
    } catch {
      // A torn last line: skip it.
    }
  }
  return entries;
}

/**
 * Checks an entry is about a user: done by them, or done to them.
 *
 * @param entry - The entry.
 * @param userId - The user.
 * @returns Whether it is.
 */
function concerns(entry: AuditEntry, userId: string): boolean {
  return entry.actor?.userId === userId || (entry.target?.kind === AuditTargetKind.User && entry.target.id === userId);
}

/**
 * Checks an entry passes a query's filters; the page fields are ignored.
 *
 * @param entry - The entry.
 * @param query - The type and user filters.
 * @returns Whether it passes.
 */
export function matchesQuery(entry: AuditEntry, { types = null, userId = null }: AuditQuery): boolean {
  if (types !== null && types.includes(entry.type) === false) {
    return false;
  }
  return userId === null || concerns(entry, userId);
}

/**
 * Opens the audit log: JSON lines appended to `file`, which is rotated to `audit.1.jsonl` and so on once it would
 * pass `AUDIT_DEFAULTS.maxFileBytes`, keeping `AUDIT_DEFAULTS.keptFiles` of them.
 *
 * @param file - The current file's path. Its directory is made when missing.
 * @param [now] - The clock, in epoch milliseconds.
 * @param [settings] - The size limit and how many files are kept; tests make them small.
 * @returns The log.
 *
 * @remarks
 * Appends are synchronous, so entries keep their order within the one process that owns the files. Reading
 * parses every kept file, which the size limits keep to a few megabytes.
 */
export function openAuditLog(
  file: string,
  now: () => number = Date.now,
  settings: Pick<typeof AUDIT_DEFAULTS, 'maxFileBytes' | 'keptFiles'> = AUDIT_DEFAULTS,
): AuditLog {
  const files = filesOf(file, settings.keptFiles);
  const listeners = new Set<(entry: AuditEntry) => void>();

  /** Moves each file one place down the list, dropping the oldest. */
  const rotate = (): void => {
    rmSync(files[files.length - 1], { force: true });
    for (let i = files.length - 2; i >= 0; i--) {
      if (sizeOf(files[i]) > 0) {
        renameSync(files[i], files[i + 1]);
      }
    }
  };

  return {
    record: (event) => {
      try {
        const entry: AuditEntry = { id: randomUUID(), at: new Date(now()).toISOString(), ...event };
        const line = `${JSON.stringify(entry)}\n`;
        const size = sizeOf(file);
        if (size > 0 && size + Buffer.byteLength(line) > settings.maxFileBytes) {
          rotate();
        }
        mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
        appendFileSync(file, line, { encoding: 'utf8', mode: FILE_MODE });
        for (const listener of listeners) {
          listener(entry);
        }
      } catch (error) {
        console.error(LOG_TAG, 'could not record', event.type, error);
      }
    },
    onRecord: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    list: (query) => {
      const { first = AUDIT_DEFAULTS.pageSize, after = null } = query;
      const size = Math.min(Math.max(first, 1), AUDIT_DEFAULTS.maxPageSize);
      const newestFirst = files.flatMap((each) => entriesIn(each).reverse());
      let start = 0;
      if (after !== null) {
        const index = newestFirst.findIndex((entry) => entry.id === after);
        start = index === -1 ? newestFirst.length : index + 1;
      }
      const matching: AuditEntry[] = [];
      let hasMore = false;
      for (const entry of newestFirst.slice(start)) {
        if (matchesQuery(entry, query) === false) {
          continue;
        }
        if (matching.length === size) {
          hasMore = true;
          break;
        }
        matching.push(entry);
      }
      return { entries: matching, nextCursor: hasMore ? (matching.at(-1)?.id ?? null) : null };
    },
  };
}
