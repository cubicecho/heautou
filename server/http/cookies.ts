import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const PAIR_SEPARATOR = ';';
const SIGNATURE_SEPARATOR = '.';

/**
 * Reads one cookie from a request. Express parses none on its own.
 *
 * @param req - The request.
 * @param name - The cookie's name.
 * @returns Its value, or null when it was not sent.
 */
export function readCookie(req: Request, name: string): string | null {
  for (const pair of (req.headers.cookie ?? '').split(PAIR_SEPARATOR)) {
    const at = pair.indexOf('=');
    const isMatch = at !== -1 && pair.slice(0, at).trim() === name;
    if (isMatch) {
      return decodeURIComponent(pair.slice(at + 1).trim());
    }
  }
  return null;
}

/**
 * Signs a value for a cookie with HMAC-SHA256.
 *
 * @param data - What to keep in the cookie. It is readable by the browser, only not changeable.
 * @param key - The signing key.
 * @returns `<base64url JSON>.<signature>`.
 */
export function signValue(data: unknown, key: string): string {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}${SIGNATURE_SEPARATOR}${signature}`;
}

/**
 * Reads a value `signValue` made, checking it against every key.
 *
 * @param value - The cookie's value.
 * @param keys - The keys any signature may be from.
 * @returns The parsed data, or null when it was changed or is not a signed value.
 */
export function verifyValue(value: string, keys: string[]): unknown {
  const at = value.lastIndexOf(SIGNATURE_SEPARATOR);
  const body = value.slice(0, at);
  const signature = Buffer.from(value.slice(at + 1));
  const isSigned = keys.some((key) => {
    const expected = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  });
  if (at === -1 || isSigned === false) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
