// The audit log's vocabulary: what can happen and what it can happen to. It imports nothing, so the database
// tables can name it without loading the log.

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
  /**
   * The provider could not tell an application that one of its users signed out (back-channel logout): the app was
   * unreachable or refused the logout token. The detail has the error.
   */
  AppLogoutFailed: 'app_logout_failed',
  /** A client got a token for itself with the client credentials grant, with no user. */
  MachineTokenIssued: 'machine_token_issued',
  /**
   * A device asked for a code to show its user (RFC 8628). There is no actor yet; the detail has the scope and the
   * API asked for, never the code.
   */
  DeviceCodeIssued: 'device_code_issued',
  /** A user signed a device in by entering its code. It takes the place of `app_signed_in` for a device. */
  DeviceApproved: 'device_approved',
  /**
   * A device's code was turned down: its user cancelled, or the sign-in for it failed. The device is told
   * `access_denied` or the error when it next polls. The detail has the error.
   */
  DeviceRefused: 'device_refused',
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
  /** The operator chose what else to set up for a paired app: its device client, its API. */
  PairingFinished: 'pairing_finished',
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
  /** An admin downloaded a backup of the data. The detail says whether it took the sessions. */
  BackupDownloaded: 'backup_downloaded',
  /** The data was replaced from a backup, by an admin or the CLI. The detail says when the backup was made. */
  DataRestored: 'data_restored',
  /** An admin added a provider users may sign in through, such as Google or GitHub. */
  UpstreamCreated: 'upstream_created',
  UpstreamUpdated: 'upstream_updated',
  /** An admin removed an upstream provider, and every identity linked through it. */
  UpstreamDeleted: 'upstream_deleted',
  /** An upstream identity was linked to a user: from their account page, or by the sign-in that made the user. */
  UpstreamLinked: 'upstream_linked',
  /** An upstream identity was unlinked, by its user or by an admin. */
  UpstreamUnlinked: 'upstream_unlinked',
  /** A sign-in through an upstream provider changed the user's mapped groups. The detail lists them. */
  UpstreamGroupsApplied: 'upstream_groups_applied',
  /** An admin added an API apps may ask for access tokens to. */
  ApiCreated: 'api_created',
  ApiUpdated: 'api_updated',
  ApiDeleted: 'api_deleted',
  /** An email went out. The detail has its kind and the address, never the link it carried. */
  MailSent: 'mail_sent',
  /** An email could not be sent. The detail has its kind, the address and the SMTP server's error. */
  MailFailed: 'mail_failed',
  /** An admin saved the SMTP server under Settings. The detail says whether the password was replaced. */
  MailServerSet: 'mail_server_set',
  /** An admin removed the SMTP server saved under Settings. */
  MailServerRemoved: 'mail_server_removed',
  /** An admin turned the forgot-password link or a notification on or off. */
  MailOptionsSet: 'mail_options_set',
  /**
   * Someone asked for a reset link on the sign-in page. The actor is the user it matched; with none, the detail has
   * what was typed. A link is only sent when the user is enabled and has an email address.
   */
  PasswordResetRequested: 'password_reset_requested',
  /** A user's profile picture was set: by them on their account page, or by an admin. */
  PictureSet: 'picture_set',
  /** A user's profile picture was removed: by them, or by an admin. */
  PictureRemoved: 'picture_removed',
  /** A user signed in to the protected sites (forward auth). The detail names the host they were going to. */
  ProxySignedIn: 'proxy_signed_in',
  /** A user signed out of the protected sites. */
  ProxySignedOut: 'proxy_signed_out',
  /**
   * A signed-in user was turned away from a protected site: not in its groups, or without the second factor it asks
   * for. Logged once per user and site every `FORWARD_AUTH_DEFAULTS.refusalLogSeconds`.
   */
  ProxyRefused: 'proxy_refused',
  ProtectedSiteCreated: 'protected_site_created',
  ProtectedSiteUpdated: 'protected_site_updated',
  ProtectedSiteDeleted: 'protected_site_deleted',
  /** The parent domain the forward auth session cookie is set on changed. */
  ProxyCookieDomainSet: 'proxy_cookie_domain_set',
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
  AuditType.DeviceApproved,
  AuditType.AppSignedOut,
  AuditType.WebSignedIn,
  AuditType.ProxySignedIn,
];

/** How an app sign-in was made, in its `via` detail. */
export const AppSignInVia = {
  /** The user typed their password for it. */
  Password: 'password',
  /** The user already had a provider session, so nothing was asked. */
  Session: 'session',
  /** The user signed in with a passkey alone. */
  Passkey: 'passkey',
  /** The user signed in through an upstream provider, such as Google or GitHub. */
  Upstream: 'upstream',
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
  /** A provider users sign in through, such as Google or GitHub. */
  Upstream: 'upstream',
  /** An API (resource server) apps ask for access tokens to. */
  Api: 'api',
  /** A site behind the reverse proxy that forward auth protects. */
  ProtectedSite: 'protected_site',
} as const;
export type AuditTargetKind = (typeof AuditTargetKind)[keyof typeof AuditTargetKind];
