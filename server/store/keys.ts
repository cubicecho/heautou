import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { JWK } from 'oidc-provider';
import { KEY_DEFAULTS } from '../core/defaults.ts';
import type { JsonFile } from './json-file.ts';

/** The keys the provider signs tokens and cookies with. */
export interface ProviderKeys {
  /** Private JWKs, newest first. The first signs; the provider publishes the public halves at `/oidc/jwks`. */
  jwks: JWK[];
  /** Cookie signing keys, newest first. The first signs; every one verifies. */
  cookieKeys: string[];
  /** When the newest keys were made, as an ISO 8601 string. Files from before rotation have none. */
  rotatedAt?: string;
}

/** The provider's keys, kept in one file. */
export interface KeyStore {
  /** The keys as they are now. */
  current: () => ProviderKeys;
  /**
   * Makes a new signing key and cookie key and puts them first. The previous ones are kept, so tokens and cookies
   * they made still verify until they expire; older ones are dropped.
   *
   * @returns The keys after the rotation.
   */
  rotate: () => ProviderKeys;
  /** Whether the keys are older than `KEY_DEFAULTS.rotationDays`. */
  isDue: () => boolean;
}

/** The algorithm the signing key is made for. */
const SIGNING_ALGORITHM = 'RS256';
const MS_PER_DAY = 86_400_000;

/**
 * Makes one RSA signing key.
 *
 * @returns The private JWK.
 */
function generateSigningKey(): JWK {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: KEY_DEFAULTS.signingKeyBits });
  return { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: SIGNING_ALGORITHM };
}

/**
 * Makes one cookie signing key.
 *
 * @returns Random base64url text.
 */
function generateCookieKey(): string {
  return randomBytes(KEY_DEFAULTS.cookieKeyBytes).toString('base64url');
}

/**
 * Opens the provider's keys, making and saving them on first boot.
 *
 * @param file - The file holding them. It holds private keys in plain text.
 * @param [now] - The clock.
 * @returns The store.
 */
export function openKeyStore(file: JsonFile<ProviderKeys | null>, now: () => Date = () => new Date()): KeyStore {
  const stamp = (): string => now().toISOString();
  const stored = file.read();
  if (stored === null) {
    file.update(() => ({ jwks: [generateSigningKey()], cookieKeys: [generateCookieKey()], rotatedAt: stamp() }));
  } else if (stored.rotatedAt === undefined) {
    // Count the age of keys made before rotation existed from this boot.
    file.update(() => ({ ...stored, rotatedAt: stamp() }));
  }
  const current = (): ProviderKeys => {
    const keys = file.read();
    if (keys === null) {
      throw new Error('The key file was emptied while the server ran.');
    }
    return keys;
  };
  return {
    current,
    rotate: () => {
      const { jwks, cookieKeys } = current();
      const { keptKeys } = KEY_DEFAULTS;
      const next: ProviderKeys = {
        jwks: [generateSigningKey(), ...jwks].slice(0, keptKeys),
        cookieKeys: [generateCookieKey(), ...cookieKeys].slice(0, keptKeys),
        rotatedAt: stamp(),
      };
      file.update(() => next);
      return next;
    },
    isDue: () => {
      const { rotatedAt = stamp() } = current();
      return now().getTime() - Date.parse(rotatedAt) > KEY_DEFAULTS.rotationDays * MS_PER_DAY;
    },
  };
}
