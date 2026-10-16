import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CREDENTIAL_DEFAULTS } from '../core/defaults.ts';

/** What a stored password hash starts with, so a later scheme can be told apart. */
const SCHEME = 'scrypt';
const SEPARATOR = '$';
const ENCODING = 'base64url';

/**
 * Hashes a password with a fresh salt.
 *
 * @param password - The password as typed.
 * @returns `scrypt$<salt>$<hash>`, to store in place of the password.
 */
export function hashPassword(password: string): string {
  const { passwordSaltBytes, passwordHashBytes } = CREDENTIAL_DEFAULTS;
  const salt = randomBytes(passwordSaltBytes);
  const hash = scryptSync(password, salt, passwordHashBytes);
  return [SCHEME, salt.toString(ENCODING), hash.toString(ENCODING)].join(SEPARATOR);
}

/**
 * Checks a password against a stored hash.
 *
 * @param password - The password as typed.
 * @param stored - What `hashPassword` returned for the real one.
 * @returns True when they match.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(SEPARATOR);
  const isReadable = scheme === SCHEME && salt !== undefined && hash !== undefined;
  if (isReadable === false) {
    return false;
  }
  const expected = Buffer.from(hash, ENCODING);
  const actual = scryptSync(password, Buffer.from(salt, ENCODING), expected.length);
  return timingSafeEqual(actual, expected);
}
