import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { UserStore } from '../store/users.ts';

/**
 * Guards making the first admin. For `ADMIN_DEFAULTS.setupWindowSeconds` after boot, anyone who opens the app can
 * make a new user the admin, the way other self-hosted apps' first-run pages work. After that, or to make an
 * existing user the admin, the token printed in the server log is needed, which only the operator reads.
 */
export interface SetupGate {
  /** A fresh secret per boot. */
  token: string;
  /** Whether no admin exists yet. */
  isNeeded: () => boolean;
  /** Whether a new admin can still be made without the token. */
  isOpen: () => boolean;
  /** When the tokenless window closes, in epoch milliseconds. */
  openUntil: number;
  /** Whether a token is this boot's, compared in constant time. */
  matches: (token: string) => boolean;
}

/**
 * Makes this boot's setup gate.
 *
 * @param users - The user store.
 * @param [now] - The clock, in epoch milliseconds. The window starts when the gate is made.
 * @returns The gate.
 */
export function createSetupGate(users: UserStore, now: () => number = Date.now): SetupGate {
  const token = randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
  const expected = Buffer.from(token);
  const openUntil = now() + ADMIN_DEFAULTS.setupWindowSeconds * MS_PER_SECOND;
  const isNeeded = (): boolean => users.hasAdmin() === false;
  return {
    token,
    isNeeded,
    isOpen: () => isNeeded() && now() < openUntil,
    openUntil,
    matches: (candidate) => {
      const actual = Buffer.from(candidate);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
