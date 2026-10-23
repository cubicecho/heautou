import { createHash, randomBytes } from 'node:crypto';
import { TWO_FACTOR_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { base32Encode, matchTotp } from '../core/totp.ts';
import type { DataDocument } from '../db/document.ts';
import type { SecretMapper } from './sealed-document.ts';

/** A passkey a user registered: a WebAuthn credential. */
export interface Passkey {
  /** The credential ID, base64url. */
  id: string;
  /** The credential's public key (COSE), base64url. */
  publicKey: string;
  /** The authenticator's signature counter, to notice a cloned key. Zero for most passkeys, which don't count. */
  counter: number;
  /** How the browser reached the authenticator (`internal`, `usb`, `hybrid`...), as a hint for the next sign-in. */
  transports: string[];
  /** What the user calls it. */
  name: string;
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
  /** When it last signed in, as an ISO 8601 string. Null when it never has. */
  lastUsedAt: string | null;
}

/** A user's authenticator app. */
export interface TotpFactor {
  /** The shared secret, base32. Sealed on disk under `SECRET_KEY`. */
  secret: string;
  /** The time step of the last code accepted, so a code can't be used twice. */
  lastStep: number;
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** Everything one user can give as a second factor. */
export interface UserFactors {
  totp: TotpFactor | null;
  /** SHA-256 digests of the recovery codes not used yet. */
  recoveryCodes: string[];
  passkeys: Passkey[];
}

/** The factors document: each user's factors by user ID. A user with none has no entry. */
export type FactorsDocument = Record<string, UserFactors>;

/** A passkey without its key material: what leaves the server. */
export type PasskeyInfo = Pick<Passkey, 'id' | 'name' | 'createdAt' | 'lastUsedAt'>;

/** What a user has set up, without any secret. */
export interface FactorSummary {
  /** Whether an authenticator app is set up. */
  hasTotp: boolean;
  recoveryCodesLeft: number;
  passkeys: PasskeyInfo[];
}

/** The second factors, kept in one document. */
export interface FactorStore {
  summary: (userId: string) => FactorSummary;
  /** Whether the user has to give a second factor after their password. */
  hasSecondFactor: (userId: string) => boolean;
  /**
   * Turns on an authenticator app for a user, replacing one they had.
   *
   * @param userId - The user.
   * @param secret - The secret, base32.
   * @param step - The step of the code they confirmed it with, which can't be used again.
   */
  setTotp: (userId: string, secret: string, step: number) => Promise<void>;
  removeTotp: (userId: string) => Promise<void>;
  /**
   * Checks an authenticator code and uses it up.
   *
   * @param userId - The user.
   * @param code - What they typed.
   * @returns Whether it was right.
   */
  checkTotp: (userId: string, code: string) => Promise<boolean>;
  /**
   * Makes new recovery codes, replacing any the user had.
   *
   * @param userId - The user.
   * @returns The codes, which are only kept hashed: this is the one time they can be shown.
   */
  newRecoveryCodes: (userId: string) => Promise<string[]>;
  /**
   * Checks a recovery code and uses it up.
   *
   * @param userId - The user.
   * @param code - What they typed. Case, spaces and dashes don't matter.
   * @returns Whether it was one of theirs.
   */
  useRecoveryCode: (userId: string, code: string) => Promise<boolean>;
  passkeysOf: (userId: string) => Passkey[];
  /**
   * Finds a passkey by its credential ID, whoever it belongs to.
   *
   * @param credentialId - The credential ID, base64url.
   * @returns The passkey and its user, or null.
   */
  findPasskey: (credentialId: string) => { userId: string; passkey: Passkey } | null;
  addPasskey: (userId: string, passkey: Omit<Passkey, 'createdAt' | 'lastUsedAt'>) => Promise<PasskeyInfo>;
  /**
   * Records a passkey sign-in.
   *
   * @param credentialId - The passkey.
   * @param counter - The authenticator's new signature counter.
   */
  usedPasskey: (credentialId: string, counter: number) => Promise<void>;
  removePasskey: (userId: string, credentialId: string) => Promise<PasskeyInfo>;
  /**
   * Removes every factor a user has, as for a lost phone or a deleted user.
   *
   * @param userId - The user.
   * @returns Whether they had any.
   */
  removeAll: (userId: string) => Promise<boolean>;
}

/**
 * Finds the secrets in the factors document: each authenticator app's secret.
 *
 * @param document - The document as stored.
 * @param change - Seals or opens one secret.
 * @returns The document with its secrets changed.
 */
export const factorSecretsIn: SecretMapper<FactorsDocument> = (document, change) =>
  Object.fromEntries(
    Object.entries(document).map(([userId, factors]) => [
      userId,
      factors.totp === null ? factors : { ...factors, totp: { ...factors.totp, secret: change(factors.totp.secret) } },
    ]),
  );

/** A user with nothing set up. */
const NO_FACTORS: Readonly<UserFactors> = Object.freeze({ totp: null, recoveryCodes: [], passkeys: [] });

/**
 * Puts a recovery code in the one form it is hashed in.
 *
 * @param code - As typed or as made.
 * @returns Upper case, without spaces or dashes.
 */
function normalCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Hashes a recovery code for storage. The codes are random, so a plain hash is as strong as the code.
 *
 * @param code - The code.
 * @returns Its SHA-256, base64url.
 */
function digest(code: string): string {
  return createHash('sha256').update(normalCode(code)).digest('base64url');
}

/**
 * Makes one recovery code, grouped for reading.
 *
 * @returns Such as `ABCD-EFGH`.
 */
function newRecoveryCode(): string {
  const code = base32Encode(randomBytes(TWO_FACTOR_DEFAULTS.recoveryCodeBytes));
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/**
 * Drops the key material from a passkey.
 *
 * @param passkey - The stored passkey.
 * @returns What may be shown.
 */
function infoOf({ id, name, createdAt, lastUsedAt }: Passkey): PasskeyInfo {
  return { id, name, createdAt, lastUsedAt };
}

/**
 * Builds the factor store over its document.
 *
 * @param document - The document holding every user's factors.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The store.
 */
export function createFactorStore(document: DataDocument<FactorsDocument>, now: () => number = Date.now): FactorStore {
  const of = (userId: string): UserFactors => document.read()[userId] ?? NO_FACTORS;
  const change = async (userId: string, update: (factors: UserFactors) => UserFactors): Promise<void> => {
    await document.update((byUser) => {
      const next = update(byUser[userId] ?? NO_FACTORS);
      const { [userId]: _replaced, ...others } = byUser;
      // Recovery codes stand in for a factor, so they go with the last one.
      const isEmpty = next.totp === null && next.passkeys.length === 0;
      return isEmpty ? others : { ...others, [userId]: next };
    });
  };
  const timestamp = (): string => new Date(now()).toISOString();
  const passkeyOf = (userId: string, credentialId: string): Passkey => {
    const passkey = of(userId).passkeys.find((each) => each.id === credentialId);
    if (passkey === undefined) {
      throw notFound('That passkey is not registered to this user.');
    }
    return passkey;
  };

  return {
    summary: (userId) => {
      const { totp, recoveryCodes, passkeys } = of(userId);
      return { hasTotp: totp !== null, recoveryCodesLeft: recoveryCodes.length, passkeys: passkeys.map(infoOf) };
    },
    hasSecondFactor: (userId) => {
      const { totp, passkeys } = of(userId);
      return totp !== null || passkeys.length > 0;
    },
    setTotp: async (userId, secret, step) => {
      await change(userId, (factors) => ({ ...factors, totp: { secret, lastStep: step, createdAt: timestamp() } }));
    },
    removeTotp: async (userId) => {
      await change(userId, (factors) => ({ ...factors, totp: null }));
    },
    checkTotp: async (userId, code) => {
      const { totp } = of(userId);
      const step = totp === null ? null : matchTotp(totp.secret, code, now(), totp.lastStep);
      if (totp === null || step === null) {
        return false;
      }
      await change(userId, (factors) => ({ ...factors, totp: { ...totp, lastStep: step } }));
      return true;
    },
    newRecoveryCodes: async (userId) => {
      const codes = Array.from({ length: TWO_FACTOR_DEFAULTS.recoveryCodeCount }, newRecoveryCode);
      await change(userId, (factors) => ({ ...factors, recoveryCodes: codes.map(digest) }));
      return codes;
    },
    useRecoveryCode: async (userId, code) => {
      const hashed = digest(code);
      const isKnown = of(userId).recoveryCodes.includes(hashed);
      if (isKnown) {
        await change(userId, (factors) => ({
          ...factors,
          recoveryCodes: factors.recoveryCodes.filter((each) => each !== hashed),
        }));
      }
      return isKnown;
    },
    passkeysOf: (userId) => of(userId).passkeys,
    findPasskey: (credentialId) => {
      for (const [userId, factors] of Object.entries(document.read())) {
        const passkey = factors.passkeys.find((each) => each.id === credentialId);
        if (passkey !== undefined) {
          return { userId, passkey };
        }
      }
      return null;
    },
    addPasskey: async (userId, fields) => {
      const { passkeys } = of(userId);
      if (passkeys.length >= TWO_FACTOR_DEFAULTS.maxPasskeys) {
        throw badInput(`You can have at most ${TWO_FACTOR_DEFAULTS.maxPasskeys} passkeys. Remove one first.`);
      }
      const passkey: Passkey = { ...fields, createdAt: timestamp(), lastUsedAt: null };
      await change(userId, (factors) => ({ ...factors, passkeys: [...factors.passkeys, passkey] }));
      return infoOf(passkey);
    },
    usedPasskey: async (credentialId, counter) => {
      await document.update((byUser) =>
        Object.fromEntries(
          Object.entries(byUser).map(([userId, factors]) => [
            userId,
            {
              ...factors,
              passkeys: factors.passkeys.map((each) =>
                each.id === credentialId ? { ...each, counter, lastUsedAt: timestamp() } : each,
              ),
            },
          ]),
        ),
      );
    },
    removePasskey: async (userId, credentialId) => {
      const passkey = passkeyOf(userId, credentialId);
      await change(userId, (factors) => ({
        ...factors,
        passkeys: factors.passkeys.filter((each) => each.id !== credentialId),
      }));
      return infoOf(passkey);
    },
    removeAll: async (userId) => {
      const hadAny = document.read()[userId] !== undefined;
      if (hadAny) {
        await change(userId, () => NO_FACTORS);
      }
      return hadAny;
    },
  };
}
