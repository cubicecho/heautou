import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { JWK } from 'oidc-provider';
import { KEY_DEFAULTS } from '../core/defaults.ts';
import type { DataDocument } from '../db/document.ts';
import type { SecretMapper } from './sealed-document.ts';

/** The keys the provider signs tokens and cookies with. */
export interface ProviderKeys {
  /** Private JWKs, newest first. The first signs; the provider publishes the public halves at `/oidc/jwks`. */
  jwks: JWK[];
  /** Cookie signing keys, newest first. The first signs; every one verifies. */
  cookieKeys: string[];
  /** When the newest keys were made, as an ISO 8601 string. Files from before rotation have none. */
  rotatedAt?: string;
}

/** The provider's keys, kept in one document. */
export interface KeyStore {
  /** The keys as they are now. */
  current: () => ProviderKeys;
  /**
   * Makes a new signing key and cookie key and puts them first. The previous ones are kept, so tokens and cookies
   * they made still verify until they expire; older ones are dropped.
   *
   * @returns The keys after the rotation.
   */
  rotate: () => Promise<ProviderKeys>;
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

/** The members of a JWK that are its private half. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'] as const;

/**
 * Changes the private members of one JWK.
 *
 * @param jwk - The key.
 * @param change - Seals or opens one member.
 * @returns The key with its private members changed; the public ones are left readable.
 */
function mapPrivateMembers(jwk: JWK, change: (secret: string) => string): JWK {
  const next = { ...jwk };
  for (const member of PRIVATE_JWK_MEMBERS) {
    const value = next[member];
    if (typeof value === 'string') {
      next[member] = change(value);
    }
  }
  return next;
}

/**
 * Finds the secrets in the key document: the private halves of the signing keys, and the cookie keys.
 *
 * @param keys - The keys as stored, or null before the first boot.
 * @param change - Seals or opens one secret.
 * @returns The keys with their secrets changed.
 */
export const privateKeysIn: SecretMapper<ProviderKeys | null> = (keys, change) =>
  keys === null
    ? null
    : {
        ...keys,
        jwks: keys.jwks.map((jwk) => mapPrivateMembers(jwk, change)),
        cookieKeys: keys.cookieKeys.map(change),
      };

/**
 * Opens the provider's keys, making and saving them on first boot.
 *
 * @param document - The document holding them. Its private halves are sealed when `SECRET_KEY` is set.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store.
 */
export async function openKeyStore(
  document: DataDocument<ProviderKeys | null>,
  now: () => number = Date.now,
): Promise<KeyStore> {
  const stamp = (): string => new Date(now()).toISOString();
  const stored = document.read();
  if (stored === null) {
    await document.update(() => ({
      jwks: [generateSigningKey()],
      cookieKeys: [generateCookieKey()],
      rotatedAt: stamp(),
    }));
  } else if (stored.rotatedAt === undefined) {
    // Count the age of keys made before rotation existed from this boot.
    await document.update(() => ({ ...stored, rotatedAt: stamp() }));
  }
  const current = (): ProviderKeys => {
    const keys = document.read();
    if (keys === null) {
      throw new Error('The key file was emptied while the server ran.');
    }
    return keys;
  };
  return {
    current,
    rotate: async () => {
      const { jwks, cookieKeys } = current();
      const { keptKeys } = KEY_DEFAULTS;
      const next: ProviderKeys = {
        jwks: [generateSigningKey(), ...jwks].slice(0, keptKeys),
        cookieKeys: [generateCookieKey(), ...cookieKeys].slice(0, keptKeys),
        rotatedAt: stamp(),
      };
      await document.update(() => next);
      return next;
    },
    isDue: () => {
      const { rotatedAt = stamp() } = current();
      return now() - Date.parse(rotatedAt) > KEY_DEFAULTS.rotationDays * MS_PER_DAY;
    },
  };
}
