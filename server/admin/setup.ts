import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import type { UserStore } from '../store/users.ts';

/**
 * Guards making the first admin. While there is none, anyone could otherwise claim the admin UI; the token is
 * printed in the server log, which only the operator reads.
 */
export interface SetupGate {
  /** A fresh secret per boot. */
  token: string;
  /** Whether no admin exists yet. */
  isNeeded: () => boolean;
  /** Whether a token is this boot's, compared in constant time. */
  matches: (token: string) => boolean;
}

/**
 * Makes this boot's setup gate.
 *
 * @param users - The user store.
 * @returns The gate.
 */
export function createSetupGate(users: UserStore): SetupGate {
  const token = randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
  const expected = Buffer.from(token);
  return {
    token,
    isNeeded: () => users.hasAdmin() === false,
    matches: (candidate) => {
      const actual = Buffer.from(candidate);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
