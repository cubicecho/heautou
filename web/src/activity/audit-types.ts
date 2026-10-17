import type { AuditType } from '@/__generated__/graphql';

/** What each audit entry type is called on the page. Every type has one, so a new type fails the typecheck here. */
const LABELS: Record<AuditType, string> = {
  SIGN_IN_SUCCEEDED: 'Signed in',
  SIGN_IN_FAILED: 'Sign-in failed',
  SIGN_IN_THROTTLED: 'Sign-in throttled',
  SIGN_IN_REFUSED: 'Sign-in refused',
  WEB_SIGNED_IN: 'Signed in to this site',
  WEB_SIGNED_OUT: 'Signed out of this site',
  CLIENT_CREATED: 'Client added',
  CLIENT_UPDATED: 'Client changed',
  CLIENT_SECRET_ROTATED: 'Client secret rotated',
  CLIENT_DELETED: 'Client deleted',
  PAIRING_STARTED: 'Setup URL made',
  PAIRING_CANCELLED: 'Setup URL cancelled',
  PAIRING_COMPLETED: 'App paired',
  REGISTRATION_UPDATED: 'App changed its registration',
  REGISTRATION_DELETED: 'App removed its registration',
  USER_CREATED: 'User added',
  USER_UPDATED: 'User changed',
  USER_PASSWORD_SET: 'Password set by an admin',
  USER_DELETED: 'User deleted',
  USER_DISABLED: 'User disabled',
  USER_ENABLED: 'User enabled',
  USER_SESSION_ENDED: 'Session ended by an admin',
  USER_SIGNED_OUT: 'Signed out everywhere by an admin',
  PASSWORD_LINK_CREATED: 'Password link made',
  PASSWORD_LINK_USED: 'Password set with a link',
  GROUP_RENAMED: 'Group renamed',
  GROUP_DELETED: 'Group deleted',
  KEYS_ROTATED: 'Signing keys rotated',
  BRANDING_NAME_SET: 'Name changed',
  BRANDING_LOGO_SET: 'Logo changed',
  HTTP_REDIRECTS_SET: 'Plain http redirects changed',
  ACCOUNT_PASSWORD_CHANGED: 'Changed own password',
  ACCOUNT_PASSWORD_FAILED: 'Wrong current password',
  ACCOUNT_SIGNED_OUT_EVERYWHERE: 'Signed out everywhere',
  ADMIN_SET_UP: 'First admin set up',
};

/** The labels by the type's GraphQL name and by the value the account route sends. */
const BY_NAME = new Map(
  Object.entries(LABELS).flatMap(([type, label]) => [
    [type, label],
    [type.toLowerCase(), label],
  ]),
);

/** Every type, for the activity page's filter. */
export const AUDIT_TYPE_OPTIONS = Object.entries(LABELS).map(([value, label]) => ({ value, label }));

/**
 * Says whether a filter's value is a type the server knows.
 *
 * @param value - The value the type filter picked.
 * @returns Whether it is an `AuditType`.
 */
export function isAuditType(value: string): value is AuditType {
  return Object.hasOwn(LABELS, value);
}

/**
 * Names an entry's type for a person.
 *
 * @param type - The GraphQL name, such as `SIGN_IN_FAILED`, or the wire value, such as `sign_in_failed`.
 * @returns The label, or the type itself for one this build does not know.
 */
export function auditTypeLabel(type: string): string {
  return BY_NAME.get(type) ?? type;
}

/** The types that are a sign-in going wrong, drawn as warnings. */
const WARNINGS = new Set(['SIGN_IN_FAILED', 'SIGN_IN_THROTTLED', 'SIGN_IN_REFUSED', 'ACCOUNT_PASSWORD_FAILED']);

/**
 * Says whether a type is a sign-in going wrong.
 *
 * @param type - The GraphQL name or the wire value.
 * @returns Whether it is.
 */
export function isWarning(type: string): boolean {
  return WARNINGS.has(type.toUpperCase());
}
