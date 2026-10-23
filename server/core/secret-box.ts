// Seals the secrets the stores have to read back (client secrets, private keys) under the operator's key.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** What every sealed value starts with: the format and its version. */
const ENVELOPE_PREFIX = 'enc:v1:';
/** The parts after the prefix: key id, IV, auth tag, ciphertext. */
const ENVELOPE_PARTS = 4;
const ENVELOPE_SEPARATOR = '.';
const CIPHER = 'aes-256-gcm';
/** AES-256 takes a 32-byte key. */
export const SECRET_KEY_BYTES = 32;
/** 96 bits, the IV length GCM is made for. */
const IV_BYTES = 12;
/** How much of the key's hash names it in an envelope. Enough to tell keys apart, not to learn anything. */
const KEY_ID_BYTES = 6;

/** The keys secrets are sealed with: the current one, and the one before it while values are re-sealed. */
export interface SecretKeys {
  current: Buffer;
  previous: Buffer | null;
}

/** Why secrets could not be read or sealed. */
export const SecretKeyErrorCode = {
  /** `SECRET_KEY` or its file is not 32 bytes of base64. */
  Malformed: 'SECRET_KEY_MALFORMED',
  /** The data holds sealed values but no key is set. */
  Missing: 'SECRET_KEY_MISSING',
  /** A value was sealed with a key that is neither `SECRET_KEY` nor `SECRET_KEY_PREVIOUS`, or it was changed. */
  Wrong: 'SECRET_KEY_WRONG',
} as const;
export type SecretKeyErrorCode = (typeof SecretKeyErrorCode)[keyof typeof SecretKeyErrorCode];

/** A secret key problem, reported at boot with a sentence the operator can act on. */
export class SecretKeyError extends Error {
  readonly code: SecretKeyErrorCode;

  /**
   * Makes the error.
   *
   * @param code - What went wrong.
   * @param message - What to do about it.
   */
  constructor(code: SecretKeyErrorCode, message: string) {
    super(message);
    this.name = 'SecretKeyError';
    this.code = code;
  }
}

/** Seals and opens secrets. Plain values open as themselves, so data from before a key was set still reads. */
export interface SecretBox {
  /**
   * Seals a secret under the current key.
   *
   * @param plain - The secret.
   * @returns The envelope, `enc:v1:<key id>.<iv>.<tag>.<ciphertext>` in base64url.
   */
  seal: (plain: string) => string;
  /**
   * Opens a sealed value, or returns a plain one as it is.
   *
   * @param value - An envelope or a plain secret.
   * @returns The secret.
   * @throws SecretKeyError when no known key sealed it, or it was tampered with.
   */
  open: (value: string) => string;
  /**
   * Says whether a value is sealed under the current key, so needs no rewrite.
   *
   * @param value - An envelope or a plain secret.
   * @returns True for an envelope naming the current key.
   */
  isCurrent: (value: string) => boolean;
}

/**
 * Says whether a stored value is sealed.
 *
 * @param value - A stored secret.
 * @returns True for an envelope.
 */
export function isSealed(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Names a key without giving it away.
 *
 * @param key - The key.
 * @returns The first bytes of its SHA-256, base64url.
 */
function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest().subarray(0, KEY_ID_BYTES).toString('base64url');
}

/**
 * Reads a key from its base64 text.
 *
 * @param text - The base64 (or base64url) value.
 * @param source - Where it came from, for the error.
 * @returns The key.
 * @throws SecretKeyError when it is not 32 bytes.
 */
export function parseSecretKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      SecretKeyErrorCode.Malformed,
      `${source} is not ${SECRET_KEY_BYTES} bytes of base64 (it decodes to ${key.length}). Make one with: openssl rand -base64 ${SECRET_KEY_BYTES}`,
    );
  }
  return key;
}

/** An envelope taken apart. */
interface Envelope {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * Takes an envelope apart.
 *
 * @param value - A sealed value.
 * @returns Its parts, or null when it is not a whole envelope.
 */
function parseEnvelope(value: string): Envelope | null {
  const parts = value.slice(ENVELOPE_PREFIX.length).split(ENVELOPE_SEPARATOR);
  const [keyId, iv, tag, ciphertext] = parts;
  const isWhole =
    parts.length === ENVELOPE_PARTS &&
    keyId !== undefined &&
    iv !== undefined &&
    tag !== undefined &&
    ciphertext !== undefined;
  if (isWhole === false) {
    return null;
  }
  return {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
  };
}

/**
 * Makes the box that seals and opens secrets with AES-256-GCM.
 *
 * @param keys - The current key and, while re-sealing under a new one, the previous key.
 * @returns The box.
 */
export function createSecretBox(keys: SecretKeys): SecretBox {
  const currentId = keyIdOf(keys.current);
  const byId = new Map<string, Buffer>([[currentId, keys.current]]);
  if (keys.previous !== null) {
    byId.set(keyIdOf(keys.previous), keys.previous);
  }
  const wrong = (why: string): SecretKeyError =>
    new SecretKeyError(
      SecretKeyErrorCode.Wrong,
      `A stored secret ${why}. Set SECRET_KEY to the key the data was sealed with; after changing keys, put the old one in SECRET_KEY_PREVIOUS until the next boot has re-sealed everything.`,
    );

  return {
    seal: (plain) => {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CIPHER, keys.current, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const parts = [currentId, iv, cipher.getAuthTag(), ciphertext].map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      );
      return `${ENVELOPE_PREFIX}${parts.join(ENVELOPE_SEPARATOR)}`;
    },
    open: (value) => {
      if (isSealed(value) === false) {
        return value;
      }
      const envelope = parseEnvelope(value);
      if (envelope === null) {
        throw wrong('is damaged');
      }
      const key = byId.get(envelope.keyId);
      if (key === undefined) {
        throw wrong('was sealed with a different key');
      }
      try {
        const decipher = createDecipheriv(CIPHER, key, envelope.iv);
        decipher.setAuthTag(envelope.tag);
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw wrong('does not open: it was changed, or the key was');
      }
    },
    isCurrent: (value) => isSealed(value) && parseEnvelope(value)?.keyId === currentId,
  };
}
