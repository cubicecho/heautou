import type { AuditType } from '@/__generated__/graphql';

/** What each audit entry type is called on the page. Every type has one, so a new type fails the typecheck here. */
const LABELS: Record<AuditType, string> = {
  SIGN_IN_SUCCEEDED: 'Password accepted',
  SIGN_IN_FAILED: 'Sign-in failed',
  SIGN_IN_THROTTLED: 'Sign-in throttled',
  SIGN_IN_REFUSED: 'Sign-in refused',
  APP_SIGNED_IN: 'Signed in to an app',
  APP_SIGN_IN_FAILED: 'App sign-in request refused',
  APP_TOKEN_REFUSED: 'App token request refused',
  APP_SIGNED_OUT: 'Signed out of an app',
  APP_LOGOUT_FAILED: 'App not told of a sign-out',
  MACHINE_TOKEN_ISSUED: 'Machine token issued',
  DEVICE_CODE_ISSUED: 'Device code shown',
  DEVICE_APPROVED: 'Signed in on a device',
  DEVICE_REFUSED: 'Device sign-in refused',
  WEB_SIGNED_IN: 'Signed in to this site',
  WEB_SIGNED_OUT: 'Signed out of this site',
  CLIENT_CREATED: 'Client added',
  CLIENT_UPDATED: 'Client changed',
  CLIENT_SECRET_ROTATED: 'Client secret rotated',
  CLIENT_DELETED: 'Client deleted',
  PAIRING_STARTED: 'Setup URL made',
  PAIRING_CANCELLED: 'Setup URL cancelled',
  PAIRING_COMPLETED: 'App paired',
  PAIRING_FINISHED: 'Paired app set up',
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
  PASSWORD_RULES_SET: 'Password rules changed',
  ACCOUNT_PASSWORD_CHANGED: 'Changed own password',
  ACCOUNT_PASSWORD_FAILED: 'Wrong current password',
  ACCOUNT_SIGNED_OUT_EVERYWHERE: 'Signed out everywhere',
  ADMIN_SET_UP: 'First admin set up',
  SECOND_FACTOR_FAILED: 'Second factor failed',
  TOTP_ADDED: 'Authenticator app added',
  TOTP_REMOVED: 'Authenticator app removed',
  RECOVERY_CODES_MADE: 'Recovery codes made',
  PASSKEY_ADDED: 'Passkey added',
  PASSKEY_REMOVED: 'Passkey removed',
  USER_SECOND_FACTORS_RESET: 'Two-factor reset by an admin',
  BACKUP_DOWNLOADED: 'Backup downloaded',
  DATA_RESTORED: 'Data restored from a backup',
  UPSTREAM_CREATED: 'Sign-in provider added',
  UPSTREAM_UPDATED: 'Sign-in provider changed',
  UPSTREAM_DELETED: 'Sign-in provider removed',
  UPSTREAM_LINKED: 'Account linked',
  UPSTREAM_UNLINKED: 'Account unlinked',
  UPSTREAM_GROUPS_APPLIED: 'Groups set by a sign-in provider',
  API_CREATED: 'API added',
  API_UPDATED: 'API changed',
  API_DELETED: 'API deleted',
  MAIL_SENT: 'Email sent',
  MAIL_FAILED: 'Email not sent',
  MAIL_SERVER_SET: 'Email server saved',
  MAIL_SERVER_REMOVED: 'Email server removed',
  MAIL_OPTIONS_SET: 'Email options changed',
  PASSWORD_RESET_REQUESTED: 'Password reset asked for',
  PICTURE_SET: 'Profile picture set',
  PICTURE_REMOVED: 'Profile picture removed',
  PROXY_SIGNED_IN: 'Signed in to the protected sites',
  PROXY_SIGNED_OUT: 'Signed out of the protected sites',
  PROXY_REFUSED: 'Turned away from a protected site',
  PROTECTED_SITE_CREATED: 'Protected site added',
  PROTECTED_SITE_UPDATED: 'Protected site changed',
  PROTECTED_SITE_DELETED: 'Protected site removed',
  PROXY_COOKIE_DOMAIN_SET: 'Proxy cookie domain changed',
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

/** The types that are a sign-in, a sign-out or an email going wrong, drawn as warnings. */
const WARNINGS = new Set([
  'SIGN_IN_FAILED',
  'SIGN_IN_THROTTLED',
  'SIGN_IN_REFUSED',
  'APP_SIGN_IN_FAILED',
  'APP_TOKEN_REFUSED',
  'APP_LOGOUT_FAILED',
  'ACCOUNT_PASSWORD_FAILED',
  'MAIL_FAILED',
  'PROXY_REFUSED',
]);

/**
 * Says whether a type is a sign-in or sign-out going wrong.
 *
 * @param type - The GraphQL name or the wire value.
 * @returns Whether it is.
 */
export function isWarning(type: string): boolean {
  return WARNINGS.has(type.toUpperCase());
}
