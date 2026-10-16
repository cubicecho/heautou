// Getters, not constants, so a test sees the current environment.
import { createRequire } from 'node:module';
import path from 'node:path';
import { HTTP_DEFAULTS } from './defaults.ts';

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
