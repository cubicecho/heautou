import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { JWK } from 'oidc-provider';
import { KEY_DEFAULTS } from '../core/defaults.ts';
import type { JsonFile } from './json-file.ts';

/** The keys the provider signs tokens and cookies with. */
export interface ProviderKeys {
  /** Private JWKs. The first signs; the provider publishes the public halves at `/oidc/jwks`. */
  jwks: JWK[];
  /** Cookie signing keys. The first signs; every one verifies. */
  cookieKeys: string[];
}

/** The algorithm the signing key is made for. */
const SIGNING_ALGORITHM = 'RS256';

/**
 * Makes a fresh set of keys.
 *
 * @returns One RSA signing key and one cookie key.
 */
function generateKeys(): ProviderKeys {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: KEY_DEFAULTS.signingKeyBits });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: SIGNING_ALGORITHM };
  const cookieKey = randomBytes(KEY_DEFAULTS.cookieKeyBytes).toString('base64url');
  return { jwks: [jwk], cookieKeys: [cookieKey] };
}

/**
 * Reads the provider's keys, making and saving them on first boot.
 *
 * @param file - The file holding them. It holds private keys in plain text.
 * @returns The keys.
 */
export function loadOrCreateKeys(file: JsonFile<ProviderKeys | null>): ProviderKeys {
  const stored = file.read();
  if (stored !== null) {
    return stored;
  }
  const created = generateKeys();
  file.update(() => created);
  return created;
}
