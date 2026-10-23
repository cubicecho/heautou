import { z } from 'zod';
import { PASSWORD_RULE_DEFAULTS } from '../core/defaults.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';

/** The highest score zxcvbn gives a password. */
export const MAX_PASSWORD_SCORE = 4;

/** The provider's settings as the file holds them. A setting left out follows its default. */
export interface SettingsDocument {
  /** Whether redirect URIs may be plain `http://` on any host. */
  allowHttpRedirectUris?: boolean;
  /** The lowest zxcvbn score a new password may have. */
  minPasswordScore?: number;
  /** Whether new passwords are looked up in Have I Been Pwned. */
  checkPasswordBreaches?: boolean;
}

/** What a new password must pass besides its length. */
export interface PasswordRules {
  /** The lowest zxcvbn score, 0 to `MAX_PASSWORD_SCORE`. */
  minScore: number;
  /** Whether a new password is looked up in Have I Been Pwned. */
  checkBreaches: boolean;
}

const passwordRulesSchema = z.object({
  minScore: z
    .number()
    .int()
    .min(0)
    .max(MAX_PASSWORD_SCORE, `the strength is a score from 0 to ${MAX_PASSWORD_SCORE}`)
    .optional(),
  checkBreaches: z.boolean().optional(),
});

/** Whether plain http redirect URIs are allowed, and why. */
export interface HttpRedirectSetting {
  isAllowed: boolean;
  /** False while the operator has not chosen, so it follows the issuer. */
  isSet: boolean;
  /** Whether the issuer is plain http, which is what the default follows. */
  isIssuerHttp: boolean;
}

/** The operator's settings, kept in one file. */
export interface SettingsStore {
  /**
   * Reads whether plain http redirect URIs are allowed.
   *
   * @returns The setting. Unset, it is allowed exactly when the issuer is plain http.
   */
  httpRedirects: () => HttpRedirectSetting;
  /**
   * Allows or refuses plain http redirect URIs.
   *
   * @param isAllowed - The choice, or null to follow the issuer again.
   * @returns The setting.
   */
  setHttpRedirects: (isAllowed: boolean | null) => Promise<HttpRedirectSetting>;
  /**
   * Reads what a new password must pass.
   *
   * @returns The rules, each falling back to `PASSWORD_RULE_DEFAULTS` while unset.
   */
  passwordRules: () => PasswordRules;
  /**
   * Changes what a new password must pass.
   *
   * @param changes - The rules to change; one left out keeps its value.
   * @returns The rules.
   * @throws BAD_USER_INPUT for a score outside 0 to `MAX_PASSWORD_SCORE`.
   */
  setPasswordRules: (changes: Partial<PasswordRules>) => Promise<PasswordRules>;
}

/**
 * Opens the settings store on its file.
 *
 * @param document - The document. Missing, every setting follows its default.
 * @param issuer - The provider's issuer, which the http redirect default follows.
 * @returns The store.
 */
export function createSettingsStore(document: DataDocument<SettingsDocument>, issuer: string): SettingsStore {
  const isIssuerHttp = new URL(issuer).protocol === 'http:';
  const httpRedirects = (): HttpRedirectSetting => {
    const chosen = document.read().allowHttpRedirectUris;
    return { isAllowed: chosen ?? isIssuerHttp, isSet: chosen !== undefined, isIssuerHttp };
  };
  const passwordRules = (): PasswordRules => {
    const { minPasswordScore, checkPasswordBreaches } = document.read();
    return {
      minScore: minPasswordScore ?? PASSWORD_RULE_DEFAULTS.minScore,
      checkBreaches: checkPasswordBreaches ?? PASSWORD_RULE_DEFAULTS.checkBreaches,
    };
  };
  return {
    httpRedirects,
    setHttpRedirects: async (isAllowed) => {
      await document.update((current) => {
        const { allowHttpRedirectUris: _previous, ...rest } = current;
        return isAllowed === null ? rest : { ...rest, allowHttpRedirectUris: isAllowed };
      });
      return httpRedirects();
    },
    passwordRules,
    setPasswordRules: async (changes) => {
      const { minScore, checkBreaches } = parseInput(passwordRulesSchema, changes);
      await document.update((current) => ({
        ...current,
        ...(minScore === undefined ? {} : { minPasswordScore: minScore }),
        ...(checkBreaches === undefined ? {} : { checkPasswordBreaches: checkBreaches }),
      }));
      return passwordRules();
    },
  };
}
