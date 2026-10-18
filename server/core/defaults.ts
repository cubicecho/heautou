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
