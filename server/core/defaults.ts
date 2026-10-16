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
  /** What a user has allowed a client to see, in seconds. */
  grantSeconds: number;
}

export const TOKEN_LIFETIME_DEFAULTS: Readonly<TokenLifetimeSettings> = Object.freeze({
  accessTokenSeconds: 3600,
  idTokenSeconds: 3600,
  refreshTokenSeconds: 1_209_600,
  interactionSeconds: 3600,
  sessionSeconds: 1_209_600,
  grantSeconds: 1_209_600,
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
}

export const CREDENTIAL_DEFAULTS: Readonly<CredentialSettings> = Object.freeze({
  clientSecretBytes: 32,
  passwordSaltBytes: 16,
  passwordHashBytes: 64,
  minPasswordLength: 8,
});

/** The keys the provider signs and seals with, made on first boot. */
export interface KeySettings {
  /** RSA modulus length of the token signing key, in bits. */
  signingKeyBits: number;
  /** Random bytes in each cookie signing key. */
  cookieKeyBytes: number;
}

export const KEY_DEFAULTS: Readonly<KeySettings> = Object.freeze({
  signingKeyBits: 2048,
  cookieKeyBytes: 32,
});
