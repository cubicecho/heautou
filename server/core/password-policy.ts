import { createHash } from 'node:crypto';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary as commonDictionary } from '@zxcvbn-ts/language-common';
import { dictionary as englishDictionary, translations } from '@zxcvbn-ts/language-en';
import { z } from 'zod';
import type { PasswordRules } from '../store/settings.ts';
import { passwordSchema } from '../store/users.ts';
import { PASSWORD_RULE_DEFAULTS, type PasswordRuleSettings } from './defaults.ts';
import { badInput, errorMessage } from './errors.ts';
import { parseInput } from './validation.ts';

/** How many hex characters of the SHA-1 leave the server: the range API's k-anonymity prefix. */
const HASH_PREFIX_LENGTH = 5;
/** What splits a range line's hash suffix from its count. */
const RANGE_SEPARATOR = ':';
/** What splits a person's name or an email into the words zxcvbn should know. */
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/** Said when zxcvbn has no suggestion of its own. */
const FALLBACK_SUGGESTION = 'Make it longer, or use a few words that do not belong together.';
const TOO_WEAK = 'This password is too easy to guess.';
/** The length rule the user store applies, under the field's name so a refusal says which field it is. */
const newPasswordSchema = z.object({ password: passwordSchema });
const BREACHED = 'This password has appeared in a data breach, so attackers try it early. Choose another.';

/** Fetches one range from Have I Been Pwned. `fetch` fits; tests pass a fake. */
export type FetchRange = (url: string, init: RequestInit) => Promise<Response>;

/** Whose password it is: zxcvbn marks a password down for containing these. */
export interface PasswordOwner {
  username: string;
  name?: string;
  email?: string;
}

/** Checks a new password against the operator's rules before a store saves it. */
export interface PasswordPolicy {
  /**
   * Checks a new password: its length, its zxcvbn score and, when the operator turned it on, Have I Been Pwned.
   *
   * @param password - The password as typed.
   * @param owner - Whose it will be.
   * @throws BAD_USER_INPUT saying what is wrong, with zxcvbn's feedback for a weak one.
   */
  check: (password: string, owner: PasswordOwner) => Promise<void>;
}

/**
 * Lists the words zxcvbn should treat as guessable for this user.
 *
 * @param owner - Whose password it is.
 * @returns Their username, name and email, whole and word by word.
 */
function userInputsOf(owner: PasswordOwner): string[] {
  const whole = [owner.username, owner.name ?? '', owner.email ?? ''];
  const words = whole.flatMap((value) => value.split(WORD_BREAK));
  return [...new Set([...whole, ...words])].filter((word) => word !== '');
}

/**
 * Builds zxcvbn with the common and English dictionaries.
 *
 * @returns The estimator.
 */
function createEstimator(): ZxcvbnFactory {
  return new ZxcvbnFactory({
    translations,
    graphs: adjacencyGraphs,
    dictionary: { ...commonDictionary, ...englishDictionary },
  });
}

/**
 * Builds the password policy.
 *
 * @param readRules - Reads the operator's current rules, so a change under Settings applies to the next password.
 * @param [overrides] - Replaces the breach API's URL or timeout.
 * @param [fetchRange] - Fetches a hash range.
 * @returns The policy.
 *
 * @remarks
 * The breach check fails open: when Have I Been Pwned cannot be reached in time, the password is accepted and a
 * `[passwords]` line is logged. Neither the password nor its hash is ever logged.
 */
export function createPasswordPolicy(
  readRules: () => PasswordRules,
  overrides: Partial<PasswordRuleSettings> = {},
  fetchRange: FetchRange = fetch,
): PasswordPolicy {
  const { breachRangeUrl, breachTimeoutMs } = { ...PASSWORD_RULE_DEFAULTS, ...overrides };
  let estimator: ZxcvbnFactory | undefined;

  const checkStrength = (password: string, owner: PasswordOwner, minScore: number): void => {
    // Building the dictionaries takes a moment, so it waits for the first password.
    estimator ??= createEstimator();
    const { score, feedback } = estimator.check(password, userInputsOf(owner));
    const isTooWeak = score < minScore;
    if (isTooWeak) {
      const [suggestion = FALLBACK_SUGGESTION] = feedback.suggestions;
      throw badInput([TOO_WEAK, feedback.warning ?? '', suggestion].filter((part) => part !== '').join(' '));
    }
  };

  const isBreached = async (password: string): Promise<boolean> => {
    const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = digest.slice(0, HASH_PREFIX_LENGTH);
    const suffix = digest.slice(HASH_PREFIX_LENGTH);
    try {
      const response = await fetchRange(`${breachRangeUrl}${prefix}`, {
        headers: { 'Add-Padding': 'true' },
        signal: AbortSignal.timeout(breachTimeoutMs),
      });
      const isRefused = response.ok === false;
      if (isRefused) {
        console.warn(`[passwords] Have I Been Pwned answered ${response.status}; the password was accepted unchecked.`);
        return false;
      }
      const lines = (await response.text()).split('\n');
      return lines.some((line) => {
        const [lineSuffix = '', count = '0'] = line.trim().split(RANGE_SEPARATOR);
        // Padding lines have a count of 0: they are there to hide the range's size, not real hashes.
        return lineSuffix === suffix && Number(count) > 0;
      });
    } catch (error) {
      console.warn(
        `[passwords] Have I Been Pwned could not be reached (${errorMessage(error)}); the password was accepted unchecked.`,
      );
      return false;
    }
  };

  return {
    check: async (password, owner) => {
      parseInput(newPasswordSchema, { password });
      const { minScore, checkBreaches } = readRules();
      checkStrength(password, owner, minScore);
      const isKnownBreached = checkBreaches && (await isBreached(password));
      if (isKnownBreached) {
        throw badInput(BREACHED);
      }
    },
  };
}
