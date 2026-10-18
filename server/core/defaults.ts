/** How the HTTP server listens and stops. */
export interface HttpSettings {
  /** Port to listen on. `PORT` overrides it. */
  port: number;
  /** Largest request body, in the form express parses. */
  bodyLimit: string;
  /** How long in-flight requests get to finish on shutdown, in seconds. */
  drainSeconds: number;
  /** When shutdown gives up and exits, in seconds. Below Docker's 10 s stop grace. */
  shutdownDeadlineSeconds: number;
  /** Express `trust proxy`. `TRUST_PROXY` overrides it. */
  trustProxy: boolean | number | string;
}

export const HTTP_DEFAULTS: Readonly<HttpSettings> = Object.freeze({
  port: 3000,
  bodyLimit: '1mb',
  drainSeconds: 5,
  shutdownDeadlineSeconds: 8,
  trustProxy: false,
});

/** Bounds on one GraphQL operation. */
export interface OperationLimitSettings {
  /** Deepest selection allowed. */
  maxDepth: number;
  /** Most aliases in one document. */
  maxAliases: number;
  /** Highest cost an operation may have. */
  maxCost: number;
  /** Cost of a field with no hint of its own. */
  defaultFieldCost: number;
}

export const OPERATION_LIMIT_DEFAULTS: Readonly<OperationLimitSettings> = Object.freeze({
  maxDepth: 8,
  maxAliases: 15,
  maxCost: 10_000,
  defaultFieldCost: 1,
});

/** How long each thing the provider issues stays valid. */
export interface TokenLifetimeSettings {
  /** An access token, in seconds. */
  accessTokenSeconds: number;
  /** An ID token, in seconds. */
  idTokenSeconds: number;
  /** A refresh token, in seconds. */
  refreshTokenSeconds: number;
  /** A sign-in that is under way: from the redirect to the sign-in page until it is finished, in seconds. */
  interactionSeconds: number;
  /** A signed-in browser session at the provider, in seconds. */
  sessionSeconds: number;
  /** What a user has allowed a client to see, in seconds. Stretched to a client's longer refresh token. */
  grantSeconds: number;
  /** An access token a client gets for itself with the client credentials grant, in seconds. */
  clientCredentialsSeconds: number;
}

export const TOKEN_LIFETIME_DEFAULTS: Readonly<TokenLifetimeSettings> = Object.freeze({
  accessTokenSeconds: 3600,
  idTokenSeconds: 3600,
  refreshTokenSeconds: 1_209_600,
  interactionSeconds: 3600,
  sessionSeconds: 1_209_600,
  grantSeconds: 1_209_600,
  clientCredentialsSeconds: 600,
});

/** The bounds on the token lifetimes an operator may give one client. */
export interface ClientTokenLifetimeSettings {
  /** Shortest lifetime a client's token may have, in seconds. */
  minSeconds: number;
  /** Longest lifetime a client's token may have, in seconds. */
  maxSeconds: number;
}

export const CLIENT_TOKEN_LIFETIME_DEFAULTS: Readonly<ClientTokenLifetimeSettings> = Object.freeze({
  minSeconds: 60,
  maxSeconds: 31_536_000,
});

/** How secrets and passwords are made and checked. */
export interface CredentialSettings {
  /** Random bytes in a generated client secret, before base64url. */
  clientSecretBytes: number;
  /** Random bytes in a password salt. */
  passwordSaltBytes: number;
  /** Length of a scrypt password hash, in bytes. */
  passwordHashBytes: number;
  /** Shortest password a user may be given. */
  minPasswordLength: number;
  /** How long an invite or password reset link works, in seconds. */
  passwordLinkSeconds: number;
  /** Random bytes in a password link's token, before base64url. */
  passwordLinkBytes: number;
}

export const CREDENTIAL_DEFAULTS: Readonly<CredentialSettings> = Object.freeze({
  clientSecretBytes: 32,
  passwordSaltBytes: 16,
  passwordHashBytes: 64,
  minPasswordLength: 8,
  passwordLinkSeconds: 86_400,
  passwordLinkBytes: 32,
});

/** What a new password must pass besides its length. The operator changes the first two under Settings. */
export interface PasswordRuleSettings {
  /** The lowest zxcvbn score, from 0 (anything) to 4 (very hard to guess), a new password may have. */
  minScore: number;
  /** Whether a new password is looked up in Have I Been Pwned. Off, since it makes outbound requests. */
  checkBreaches: boolean;
  /** The Have I Been Pwned range API; the first five hex characters of the password's SHA-1 go after it. */
  breachRangeUrl: string;
  /** How long the breach check waits for an answer before it lets the password through, in milliseconds. */
  breachTimeoutMs: number;
}

export const PASSWORD_RULE_DEFAULTS: Readonly<PasswordRuleSettings> = Object.freeze({
  minScore: 3,
  checkBreaches: false,
  breachRangeUrl: 'https://api.pwnedpasswords.com/range/',
  breachTimeoutMs: 3000,
});

/** The keys the provider signs and seals with, made on first boot. */
export interface KeySettings {
  /** RSA modulus length of the token signing key, in bits. */
  signingKeyBits: number;
  /** Random bytes in each cookie signing key. */
  cookieKeyBytes: number;
  /** How old the keys may get before boot rotates them, in days. */
  rotationDays: number;
  /**
   * How many signing and cookie keys are kept, the newest first. The older ones still verify tokens and cookies
   * made before the last rotation.
   */
  keptKeys: number;
}

export const KEY_DEFAULTS: Readonly<KeySettings> = Object.freeze({
  signingKeyBits: 2048,
  cookieKeyBytes: 32,
  rotationDays: 90,
  keptKeys: 2,
});

/** How the admin UI signs its operators in. It is a client of this provider, like any other app. */
export interface AdminSettings {
  /** The built-in client the admin UI signs in as. It is not in the client list and cannot be added there. */
  clientId: string;
  /** The `groups` entry that makes a user an admin. */
  group: string;
  /** How long an admin stays signed in to the admin UI, in seconds. */
  sessionSeconds: number;
  /** How long a started admin sign-in may take to come back, in seconds. */
  loginSeconds: number;
  /** Random bytes in an admin session token and in the setup token, before base64url. */
  tokenBytes: number;
  /**
   * How long after boot the first admin can be made without the setup token, in seconds. Only a new user can be
   * made that way; making an existing user the admin always needs the token.
   */
  setupWindowSeconds: number;
}

export const ADMIN_DEFAULTS: Readonly<AdminSettings> = Object.freeze({
  clientId: 'heautou-admin',
  group: 'heautou-admin',
  sessionSeconds: 43_200,
  loginSeconds: 3600,
  tokenBytes: 32,
  setupWindowSeconds: 600,
});

/** How hard the unauthenticated routes may be hit. Counted per client IP, and per username for sign-ins. */
export interface RateLimitSettings {
  /** Failed sign-ins from one IP before it is turned away until the window ends. */
  failuresPerIp: number;
  /** Failed sign-ins for one username before it is turned away until the window ends. */
  failuresPerUsername: number;
  /** The window failures are counted in, in seconds. */
  failureWindowSeconds: number;
  /** Requests from one IP to the sign-in routes per window. */
  requestsPerIp: number;
  /** The window requests are counted in, in seconds. */
  requestWindowSeconds: number;
  /** Most keys a counter remembers. Past it, the oldest are forgotten first. */
  maxKeys: number;
}

export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitSettings> = Object.freeze({
  failuresPerIp: 10,
  failuresPerUsername: 5,
  failureWindowSeconds: 900,
  requestsPerIp: 120,
  requestWindowSeconds: 60,
  maxKeys: 10_000,
});

/** What the sign-in page and the sidebar show the provider as. */
export interface BrandingSettings {
  /** The name until the operator sets one. */
  name: string;
  /** Longest name, in characters. */
  maxNameLength: number;
  /** Largest logo, in bytes. */
  maxLogoBytes: number;
  /** How long browsers may keep the logo, in seconds. */
  logoCacheSeconds: number;
}

export const BRANDING_DEFAULTS: Readonly<BrandingSettings> = Object.freeze({
  name: 'Heautou',
  maxNameLength: 60,
  maxLogoBytes: 262_144,
  logoCacheSeconds: 300,
});

/** How an app pairs itself with the provider through a setup URL. */
export interface PairingSettings {
  /** How long a setup URL works before the app has to register with it, in seconds. */
  linkSeconds: number;
}

export const PAIRING_DEFAULTS: Readonly<PairingSettings> = Object.freeze({
  linkSeconds: 600,
});

/** How the audit log is kept and read. */
export interface AuditSettings {
  /** Largest the current file may grow before it is rotated, in bytes. */
  maxFileBytes: number;
  /** How many rotated files are kept besides the current one. The oldest is dropped past it. */
  keptFiles: number;
  /** Entries in one page of the admin's activity list, unless the request asks for fewer. */
  pageSize: number;
  /** Most entries one page may ask for. */
  maxPageSize: number;
  /** How many of their own sign-ins a user sees on their account page. */
  accountEntries: number;
}

export const AUDIT_DEFAULTS: Readonly<AuditSettings> = Object.freeze({
  maxFileBytes: 1_048_576,
  keptFiles: 2,
  pageSize: 50,
  maxPageSize: 200,
  accountEntries: 20,
});

/** How second factors (an authenticator app, recovery codes, passkeys) are made and checked. */
export interface TwoFactorSettings {
  /** Digits in an authenticator app's code. */
  totpDigits: number;
  /** How long one authenticator code lasts, in seconds. */
  totpPeriodSeconds: number;
  /** Codes either side of the current one still accepted, for a phone whose clock is a little off. */
  totpDriftSteps: number;
  /** Random bytes in an authenticator app's secret. */
  totpSecretBytes: number;
  /** Recovery codes made at a time. */
  recoveryCodeCount: number;
  /** Random bytes in one recovery code, before base32. */
  recoveryCodeBytes: number;
  /** How long a user has, after their password is accepted, to give the second factor, in seconds. */
  pendingSeconds: number;
  /** Wrong second factors allowed after one password before the sign-in has to start again. */
  maxAttempts: number;
  /** How long a browser waits for a passkey, and a passkey challenge stays valid, in seconds. */
  passkeyTimeoutSeconds: number;
  /** Most passkeys one user may register. */
  maxPasskeys: number;
  /** Longest name a passkey may be given, in characters. */
  maxPasskeyNameLength: number;
}

export const TWO_FACTOR_DEFAULTS: Readonly<TwoFactorSettings> = Object.freeze({
  totpDigits: 6,
  totpPeriodSeconds: 30,
  totpDriftSteps: 1,
  totpSecretBytes: 20,
  recoveryCodeCount: 10,
  recoveryCodeBytes: 5,
  pendingSeconds: 300,
  maxAttempts: 5,
  passkeyTimeoutSeconds: 120,
  maxPasskeys: 20,
  maxPasskeyNameLength: 60,
});

/** How the provider tells an app that one of its users signed out (OpenID Connect Back-Channel Logout). */
export interface BackchannelLogoutSettings {
  /** How long the provider waits for an app to answer a logout token, in milliseconds. */
  timeoutMs: number;
}

export const BACKCHANNEL_LOGOUT_DEFAULTS: Readonly<BackchannelLogoutSettings> = Object.freeze({
  timeoutMs: 5000,
});

/** How a backup of the data directory is made and taken back. */
export interface BackupSettings {
  /** Largest archive a restore takes, gzipped, in bytes. */
  maxArchiveBytes: number;
  /** Largest an archive may grow to once unzipped, in bytes, so a small upload cannot fill the memory. */
  maxUnpackedBytes: number;
}

export const BACKUP_DEFAULTS: Readonly<BackupSettings> = Object.freeze({
  maxArchiveBytes: 33_554_432,
  maxUnpackedBytes: 268_435_456,
});

/** How users sign in through an upstream provider, such as Google, GitHub or another OpenID Connect server. */
export interface UpstreamSettings {
  /** How long a sign-in or a link may spend at the upstream provider before it has to start again, in seconds. */
  flowSeconds: number;
  /** How long a provider's discovery document is kept before it is read again, in seconds. */
  discoverySeconds: number;
  /** How long one request to an upstream provider may take, in seconds. */
  requestTimeoutSeconds: number;
  /** The scopes asked of an OpenID Connect provider when the admin names none. */
  oidcScopes: readonly string[];
  /** The scopes asked of GitHub: the profile and the email addresses. */
  githubScopes: readonly string[];
  /** Longest name a provider may have, in characters. */
  maxNameLength: number;
  /** Longest id a provider may have, in characters. The id is part of its redirect URI. */
  maxIdLength: number;
}

export const UPSTREAM_DEFAULTS: Readonly<UpstreamSettings> = Object.freeze({
  flowSeconds: 600,
  discoverySeconds: 3600,
  requestTimeoutSeconds: 10,
  oidcScopes: Object.freeze(['openid', 'profile', 'email']),
  githubScopes: Object.freeze(['read:user', 'user:email']),
  maxNameLength: 60,
  maxIdLength: 40,
});

/** The APIs (resource servers) apps ask for access tokens to with a resource indicator (RFC 8707). */
export interface ApiSettings {
  /** Shortest access token lifetime an API may set, in seconds. */
  minAccessTokenSeconds: number;
  /** Longest access token lifetime an API may set, in seconds. A JWT access token can't be revoked, so it stays short. */
  maxAccessTokenSeconds: number;
  /** Longest name an API may have, in characters. */
  maxNameLength: number;
  /** Most scopes one API may list. */
  maxScopes: number;
}

export const API_DEFAULTS: Readonly<ApiSettings> = Object.freeze({
  minAccessTokenSeconds: 60,
  maxAccessTokenSeconds: 86_400,
  maxNameLength: 60,
  maxScopes: 50,
});
