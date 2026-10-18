// Getters, not constants, so a test sees the current environment.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { HTTP_DEFAULTS, OBJECT_STORAGE_DEFAULTS } from './defaults.ts';
import { parseSecretKey, SecretKeyError, SecretKeyErrorCode, type SecretKeys } from './secret-box.ts';

const NODE_ENV_PRODUCTION = 'production';
/** The TRUST_PROXY value that trusts no hop. */
const TRUST_PROXY_OFF = 'false';
/** A hop count: digits only. */
const HOP_COUNT = /^\d+$/;
const UNKNOWN_VERSION = 'unknown';
/** Where the flat files go when `DATA_DIR` is unset: `data/` in the working directory. */
const DEFAULT_DATA_DIR = 'data';
/** The path the provider is mounted under, and so the path of the issuer. */
export const OIDC_MOUNT_PATH = '/oidc';

/**
 * Reads a positive number.
 *
 * @param value - The raw env value.
 * @param fallback - Used when the value is unset, not a number, or not above zero.
 * @returns The number.
 */
function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  const isUsable = Number.isFinite(parsed) && parsed > 0;
  return isUsable ? parsed : fallback;
}

/**
 * The port to listen on.
 *
 * @returns `PORT`, or `HTTP_DEFAULTS.port`.
 */
export const port = (): number => envNumber(process.env.PORT, HTTP_DEFAULTS.port);

/**
 * Whether this is a production run. GraphiQL is off and the built web app is served.
 *
 * @returns True when `NODE_ENV` is "production".
 */
export const isProduction = (): boolean => process.env.NODE_ENV === NODE_ENV_PRODUCTION;

/**
 * Where clients, users, keys and sessions are written.
 *
 * @returns `DATA_DIR`, or `data/` in the working directory, as an absolute path.
 */
export const dataDir = (): string => path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);

/**
 * The issuer: the URL clients discover the provider at, without the `/.well-known` part.
 *
 * @returns `ISSUER_URL` without a trailing slash, or `http://localhost:<port>/oidc`.
 * @throws When `ISSUER_URL` is set to something that is not an http(s) URL ending in `/oidc`.
 */
export const issuerUrl = (): string => {
  const raw = (process.env.ISSUER_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') {
    return `http://localhost:${port()}${OIDC_MOUNT_PATH}`;
  }
  const isHttpUrl = URL.canParse(raw) && /^https?:$/.test(new URL(raw).protocol);
  const isMountedPath = raw.endsWith(OIDC_MOUNT_PATH);
  const isUsable = isHttpUrl && isMountedPath;
  if (isUsable === false) {
    throw new Error(
      `ISSUER_URL is "${raw}". Expected the public URL of this server followed by ${OIDC_MOUNT_PATH}, for example ISSUER_URL=https://auth.example.home${OIDC_MOUNT_PATH}.`,
    );
  }
  return raw;
};

/**
 * Express `trust proxy`: which hops may set X-Forwarded-For.
 *
 * @returns `HTTP_DEFAULTS.trustProxy` when `TRUST_PROXY` is unset, false for "false", a hop count for digits, otherwise the value as given.
 */
export const trustProxy = (): boolean | number | string => {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (raw === '') {
    return HTTP_DEFAULTS.trustProxy;
  }
  if (raw === TRUST_PROXY_OFF) {
    return false;
  }
  const isHopCount = HOP_COUNT.test(raw);
  return isHopCount ? Number(raw) : raw;
};

/**
 * The parent domain the forward auth session cookie is set on, such as `home.lan`, when the environment sets it.
 *
 * @returns `FORWARD_AUTH_COOKIE_DOMAIN` lowercased without a leading dot, or null when unset; then the admin's
 * choice under Protected sites applies.
 */
export const forwardAuthCookieDomain = (): string | null => {
  const raw = (process.env.FORWARD_AUTH_COOKIE_DOMAIN ?? '').trim().toLowerCase().replace(/^\.+/, '');
  return raw === '' ? null : raw;
};

/**
 * The proxies the forward auth endpoint takes the original request's address from.
 *
 * @returns `FORWARD_AUTH_TRUSTED_PROXIES` split on commas (addresses or CIDR ranges), or null when unset; then
 * `TRUST_PROXY` and loopback decide.
 */
export const forwardAuthTrustedProxies = (): string[] | null => {
  const entries = (process.env.FORWARD_AUTH_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === 0 ? null : entries;
};

/**
 * Reads one secret key from its variable, or from the file its `_FILE` variable names (a Docker secret). The file
 * wins.
 *
 * @param name - The variable, such as `SECRET_KEY`.
 * @returns The key, or null when neither is set.
 * @throws SecretKeyError when the value is not 32 bytes of base64, or the file can't be read.
 */
function readSecretKey(name: string): Buffer | null {
  const fileVariable = `${name}_FILE`;
  const filePath = (process.env[fileVariable] ?? '').trim();
  if (filePath !== '') {
    return parseSecretKey(readFileSync(filePath, 'utf8'), `${fileVariable} (${filePath})`);
  }
  const raw = (process.env[name] ?? '').trim();
  return raw === '' ? null : parseSecretKey(raw, name);
}

/**
 * The keys client secrets and private keys are sealed with on disk.
 *
 * @returns `SECRET_KEY` (or `SECRET_KEY_FILE`) and `SECRET_KEY_PREVIOUS` (or `SECRET_KEY_PREVIOUS_FILE`), or null
 * when no key is set and secrets stay plain text.
 * @throws SecretKeyError when a key is malformed, or only a previous key is set.
 */
export const secretKeys = (): SecretKeys | null => {
  const current = readSecretKey('SECRET_KEY');
  const previous = readSecretKey('SECRET_KEY_PREVIOUS');
  if (current === null) {
    if (previous !== null) {
      throw new SecretKeyError(
        SecretKeyErrorCode.Malformed,
        'SECRET_KEY_PREVIOUS is set without SECRET_KEY. Set SECRET_KEY to the new key.',
      );
    }
    return null;
  }
  return { current, previous };
};

/** Where profile pictures are kept: an S3-compatible bucket, addressed path-style. */
export interface S3Config {
  /** The store's URL, such as `http://rustfs:9000`. The bucket follows it in the path. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The S3 variables, each also readable from the file its `_FILE` form names. */
const S3_VARIABLE = {
  endpoint: 'S3_ENDPOINT',
  bucket: 'S3_BUCKET',
  region: 'S3_REGION',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
} as const;

/**
 * Reads a variable, or the file its `_FILE` form names (a Docker secret). The file wins.
 *
 * @param name - The variable, such as `S3_SECRET_ACCESS_KEY`.
 * @returns The value, trimmed, or an empty string when neither is set.
 */
function envOrFile(name: string): string {
  const filePath = (process.env[`${name}_FILE`] ?? '').trim();
  if (filePath !== '') {
    return readFileSync(filePath, 'utf8').trim();
  }
  return (process.env[name] ?? '').trim();
}

/**
 * The bucket profile pictures are kept in.
 *
 * @returns The bucket's settings, or null when no `S3_` variable is set and pictures are off.
 * @throws When only some are set, or `S3_ENDPOINT` is not an http(s) URL.
 */
export const s3Config = (): S3Config | null => {
  const read: S3Config = {
    endpoint: envOrFile(S3_VARIABLE.endpoint),
    bucket: envOrFile(S3_VARIABLE.bucket),
    region: envOrFile(S3_VARIABLE.region),
    accessKeyId: envOrFile(S3_VARIABLE.accessKeyId),
    secretAccessKey: envOrFile(S3_VARIABLE.secretAccessKey),
  };
  const isOff = Object.values(read).every((value) => value === '');
  if (isOff) {
    return null;
  }
  const required = [
    [S3_VARIABLE.endpoint, read.endpoint],
    [S3_VARIABLE.bucket, read.bucket],
    [S3_VARIABLE.accessKeyId, read.accessKeyId],
    [S3_VARIABLE.secretAccessKey, read.secretAccessKey],
  ];
  const missing = required.filter(([, value]) => value === '').map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Profile pictures need ${missing.join(', ')} as well (or their _FILE forms). Set them, or unset every S3_ variable to turn pictures off.`,
    );
  }
  const endpoint = read.endpoint.replace(/\/+$/, '');
  const isHttpUrl = URL.canParse(endpoint) && /^https?:$/.test(new URL(endpoint).protocol);
  if (isHttpUrl === false) {
    throw new Error(`S3_ENDPOINT is "${endpoint}". Expected the store's http(s) URL, such as http://rustfs:9000.`);
  }
  return { ...read, endpoint, region: read.region || OBJECT_STORAGE_DEFAULTS.region };
};

/**
 * Reads the version from package.json, which the Dockerfile copies.
 *
 * @returns The released version, or "unknown".
 */
function readVersion(): string {
  try {
    const manifest: { version?: string } = createRequire(import.meta.url)('../../package.json');
    return manifest.version || UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/** Stamped into the build, not configured. */
const VERSION = readVersion();

/**
 * The version this build was released as.
 *
 * @returns The released version, or "unknown".
 */
export const version = (): string => VERSION;
