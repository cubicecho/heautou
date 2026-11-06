// Getting back in after the only admin forgot their password: RESET_ADMIN_PASSWORD sets it at boot, once.
import { GraphQLError } from 'graphql';
import { ErrorCode } from '../core/errors.ts';
import type { PasswordPolicy } from '../core/password-policy.ts';
import type { DataDocument } from '../db/document.ts';
import { type AuditLog, AuditType, userTarget } from '../store/audit.ts';
import { hashPassword, verifyPassword } from '../store/password.ts';
import type { PasswordLinkStore } from '../store/password-links.ts';
import { isAdmin, type PublicUser, type UserStore } from '../store/users.ts';

/** The password an operator put in the environment, and whose it is. */
export interface AdminPasswordReset {
  /** `RESET_ADMIN_USERNAME`: the admin to reset. Null resets the only admin there is. */
  username: string | null;
  /** `RESET_ADMIN_PASSWORD`, or the file `RESET_ADMIN_PASSWORD_FILE` names. */
  password: string;
}

/** What boot remembers of the last reset, so the same one is never applied twice. */
export interface AdminPasswordResetDocument {
  /** A password hash of the username as given and the password, from the last reset applied. */
  applied?: string;
}

/** What became of a reset. */
export const AdminPasswordResetOutcome = {
  Reset: 'reset',
  AlreadyUsed: 'already_used',
  NotAnAdmin: 'not_an_admin',
  NoAdmin: 'no_admin',
  SeveralAdmins: 'several_admins',
  Refused: 'refused',
} as const;
export type AdminPasswordResetOutcome = (typeof AdminPasswordResetOutcome)[keyof typeof AdminPasswordResetOutcome];

/** What became of a reset, and the sentence boot logs about it. */
export interface AdminPasswordResetResult {
  outcome: AdminPasswordResetOutcome;
  message: string;
}

/** What a reset reads and changes. */
export interface AdminPasswordResetDeps {
  /** Where the last reset applied is remembered. It is not in backups, so a restore doesn't apply one again. */
  document: DataDocument<AdminPasswordResetDocument>;
  users: UserStore;
  passwordPolicy: PasswordPolicy;
  passwordLinks: PasswordLinkStore;
  audit: AuditLog;
}

/** The variables named in what boot logs. */
const PASSWORD_VARIABLE = 'RESET_ADMIN_PASSWORD';
const USERNAME_VARIABLE = 'RESET_ADMIN_USERNAME';
/** Keeps the username and the password apart in what the marker hashes. */
const MARKER_SEPARATOR = '\n';

/**
 * Says what the marker of a reset hashes: the username as given, empty when unset, and the password.
 *
 * @param reset - The reset.
 * @returns The text to hash.
 */
function markerOf(reset: AdminPasswordReset): string {
  return `${reset.username ?? ''}${MARKER_SEPARATOR}${reset.password}`;
}

/**
 * Finds the admin a reset is for.
 *
 * @param users - The user store.
 * @param username - The username given, or null for the only admin.
 * @returns The admin, or the result that says why there is none.
 */
function targetOf(users: UserStore, username: string | null): PublicUser | AdminPasswordResetResult {
  const admins = users.list().filter(isAdmin);
  if (username !== null) {
    const named = admins.find((admin) => admin.username === username);
    return (
      named ?? {
        outcome: AdminPasswordResetOutcome.NotAnAdmin,
        message: `${USERNAME_VARIABLE} is "${username}", and no admin has that username. Nothing was changed.`,
      }
    );
  }
  const [only, ...others] = admins;
  if (only === undefined) {
    return {
      outcome: AdminPasswordResetOutcome.NoAdmin,
      message: `There is no admin to reset, so ${PASSWORD_VARIABLE} was not used. Make one on the setup page instead.`,
    };
  }
  if (others.length > 0) {
    const names = admins.map((admin) => `"${admin.username}"`).join(', ');
    return {
      outcome: AdminPasswordResetOutcome.SeveralAdmins,
      message: `There are several admins (${names}). Set ${USERNAME_VARIABLE} to the one to reset. Nothing was changed.`,
    };
  }
  return only;
}

/**
 * Says whether something thrown is a password the rules refused, rather than a failure to save it.
 *
 * @param error - What was thrown.
 * @returns True for a `BAD_USER_INPUT` error.
 */
function isRefusal(error: unknown): error is GraphQLError {
  return error instanceof GraphQLError && error.extensions.code === ErrorCode.BadUserInput;
}

/**
 * Sets an admin's password from the environment, unless this same reset was applied before. The password goes through
 * the password rules, the admin's open password links stop working, and the change is audited with no actor.
 *
 * @param reset - The username and password from the environment.
 * @param deps - The stores.
 * @returns What became of it, with the sentence to log.
 * @throws The database's error when saving fails.
 */
export async function resetAdminPassword(
  reset: AdminPasswordReset,
  deps: AdminPasswordResetDeps,
): Promise<AdminPasswordResetResult> {
  const { document, users, passwordPolicy, passwordLinks, audit } = deps;
  const { applied } = document.read();
  const wasApplied = applied !== undefined && (await verifyPassword(markerOf(reset), applied));
  if (wasApplied) {
    return {
      outcome: AdminPasswordResetOutcome.AlreadyUsed,
      message: `${PASSWORD_VARIABLE} was used already, so it was ignored. Remove it from the environment. To reset again, set a different password.`,
    };
  }
  const target = targetOf(users, reset.username);
  if ('outcome' in target) {
    return target;
  }
  try {
    await passwordPolicy.check(reset.password, target);
    await users.setPassword(target.id, reset.password);
  } catch (error) {
    if (isRefusal(error)) {
      return {
        outcome: AdminPasswordResetOutcome.Refused,
        message: `${PASSWORD_VARIABLE} was not used for "${target.username}": ${error.message} Nothing was changed.`,
      };
    }
    throw error;
  }
  await passwordLinks.cancelFor(target.id);
  await document.update(() => ({ applied: hashPassword(markerOf(reset)) }));
  audit.record({
    type: AuditType.UserPasswordSet,
    actor: null,
    ip: null,
    target: userTarget(target),
    detail: { via: 'environment' },
  });
  return {
    outcome: AdminPasswordResetOutcome.Reset,
    message: `Set the password of "${target.username}" from ${PASSWORD_VARIABLE}. Sign in with it, then remove ${PASSWORD_VARIABLE} from the environment.`,
  };
}
