import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TWO_FACTOR_DEFAULTS } from './defaults.ts';
import { MS_PER_SECOND } from './wire.ts';

/** The RFC 4648 base32 alphabet authenticator apps read secrets in. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Bits one base32 character holds. */
const BITS_PER_CHAR = 5;
/** Bits in a byte. */
const BITS_PER_BYTE = 8;
/** Masks the low five bits: one base32 character. */
const CHAR_MASK = 0b11111;
/** Masks the low byte. */
const BYTE_MASK = 0xff;
/** Masks the low four bits of the HMAC's last byte: where RFC 4226's dynamic truncation starts reading. */
const OFFSET_MASK = 0x0f;
/** Masks off the sign bit of the truncated 31-bit number. */
const SIGN_MASK = 0x7fffffff;
/** Bytes in the counter TOTP signs: a 64-bit big-endian number. */
const COUNTER_BYTES = 8;
/** The decimal base codes are written in. */
const DECIMAL = 10;

const { totpDigits, totpPeriodSeconds, totpDriftSteps, totpSecretBytes } = TWO_FACTOR_DEFAULTS;

/**
 * Writes bytes as base32, unpadded, as authenticator apps expect a secret.
 *
 * @param bytes - The bytes.
 * @returns Base32 text.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = (value << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_CHAR) {
      text += BASE32_ALPHABET[(value >>> (bits - BITS_PER_CHAR)) & CHAR_MASK];
      bits -= BITS_PER_CHAR;
    }
  }
  if (bits > 0) {
    text += BASE32_ALPHABET[(value << (BITS_PER_CHAR - bits)) & CHAR_MASK];
  }
  return text;
}

/**
 * Reads base32 back into bytes. Spaces, dashes and padding are ignored, and case does not matter.
 *
 * @param text - Base32 text.
 * @returns The bytes.
 * @throws Error when the text holds a character base32 does not use.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`"${char}" is not a base32 character.`);
    }
    value = (value << BITS_PER_CHAR) | index;
    bits += BITS_PER_CHAR;
    if (bits >= BITS_PER_BYTE) {
      bytes.push((value >>> (bits - BITS_PER_BYTE)) & BYTE_MASK);
      bits -= BITS_PER_BYTE;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Makes a new authenticator app secret.
 *
 * @returns The secret, as base32.
 */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(totpSecretBytes));
}

/**
 * Says which time step a moment falls in.
 *
 * @param nowMs - The moment, in epoch milliseconds.
 * @returns The step number: whole periods since the epoch.
 */
export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_SECOND / totpPeriodSeconds);
}

/**
 * Works out the code for one time step (RFC 6238, HMAC-SHA1, as every authenticator app does by default).
 *
 * @param secret - The secret, as base32.
 * @param step - The time step.
 * @returns The code, zero-padded to `totpDigits`.
 */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(COUNTER_BYTES);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac.at(-1) ?? 0) & OFFSET_MASK;
  const truncated = hmac.readUInt32BE(offset) & SIGN_MASK;
  return String(truncated % DECIMAL ** totpDigits).padStart(totpDigits, '0');
}

/**
 * Finds the time step a typed code belongs to, near now, and later than the last one used.
 *
 * @param secret - The secret, as base32.
 * @param code - What the user typed. Spaces are ignored.
 * @param nowMs - Now, in epoch milliseconds.
 * @param lastStep - The step of the last code accepted, so it can't be used twice. -1 when none has been.
 * @returns The step the code is for, or null when it matches none that may be used.
 */
export function matchTotp(secret: string, code: string, nowMs: number, lastStep: number): number | null {
  const typed = Buffer.from(code.replace(/\s/g, ''));
  const current = totpStepAt(nowMs);
  for (let step = current - totpDriftSteps; step <= current + totpDriftSteps; step += 1) {
    const expected = Buffer.from(totpCode(secret, step));
    const isMatch = typed.length === expected.length && timingSafeEqual(typed, expected);
    if (isMatch && step > lastStep) {
      return step;
    }
  }
  return null;
}

/**
 * Builds the `otpauth://` URI an authenticator app reads from the QR code.
 *
 * @param secret - The secret, as base32.
 * @param issuer - What the app should call the provider: its brand name.
 * @param account - The user's username.
 * @returns The URI.
 */
export function totpUri(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(totpDigits),
    period: String(totpPeriodSeconds),
  });
  return `otpauth://totp/${label}?${query}`;
}
