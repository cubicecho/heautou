import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { ErrorCode } from '../../server/core/errors.ts';
import { createPasswordPolicy, type FetchRange } from '../../server/core/password-policy.ts';
import type { PasswordRules } from '../../server/store/settings.ts';

/** Scores 3 or more on its own, and far less once zxcvbn knows its owner's name. */
const NAME_PASSWORD = 'Quarkwhistle1';
const OWNER = { username: 'zebq', name: 'Zebulon Quarkwhistle', email: 'zeb@quarkwhistle.example' };
const STRANGER = { username: 'someone' };
/** zxcvbn's best score. */
const VERY_HARD = 'violet kettle drifts sideways';
/** A score of 3: hard, but not very hard, to guess. */
const HARD = 'correct horse';
const WEAK = 'password1';
/** A breach check short enough that a test waits for it. */
const SHORT_TIMEOUT_MS = 20;

/**
 * Splits a password's SHA-1 the way the range API does.
 *
 * @param password - The password.
 * @returns The 5-character prefix that is sent and the suffix that is compared.
 */
function sha1Parts(password: string): { prefix: string; suffix: string } {
  const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
  return { prefix: digest.slice(0, 5), suffix: digest.slice(5) };
}

/**
 * Builds a policy over rules a test can change.
 *
 * @param rules - The rules, read again on every check.
 * @param [fetchRange] - The fake Have I Been Pwned.
 * @returns The policy.
 */
function policyWith(rules: PasswordRules, fetchRange?: FetchRange) {
  return createPasswordPolicy(() => rules, { breachTimeoutMs: SHORT_TIMEOUT_MS }, fetchRange);
}

/**
 * Runs a check and hands back its refusal.
 *
 * @param check - The check.
 * @returns The refusal's message and code.
 */
async function refusalOf(check: Promise<void>): Promise<{ message: string; code: unknown }> {
  try {
    await check;
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { message: error.message, code: error.extensions.code };
    }
    throw error;
  }
  throw new Error('Expected the password to be refused.');
}

describe('password strength', () => {
  it('refuses a weak password with what zxcvbn says about it', async () => {
    const refusal = await refusalOf(policyWith({ minScore: 3, checkBreaches: false }).check(WEAK, STRANGER));
    expect(refusal.code).toBe(ErrorCode.BadUserInput);
    expect(refusal.message).toMatch(/too easy to guess.*commonly used password/);
  });

  it('accepts a strong one', async () => {
    await expect(policyWith({ minScore: 3, checkBreaches: false }).check(VERY_HARD, STRANGER)).resolves.toBeUndefined();
  });

  it("marks a password down for holding its owner's name", async () => {
    const policy = policyWith({ minScore: 3, checkBreaches: false });
    await expect(policy.check(NAME_PASSWORD, STRANGER)).resolves.toBeUndefined();
    expect((await refusalOf(policy.check(NAME_PASSWORD, OWNER))).message).toMatch(/personal/);
  });

  it('follows the minimum score as it changes', async () => {
    const rules = { minScore: 3, checkBreaches: false };
    const policy = policyWith(rules);
    await expect(policy.check(HARD, STRANGER)).resolves.toBeUndefined();
    rules.minScore = 4;
    expect((await refusalOf(policy.check(HARD, STRANGER))).code).toBe(ErrorCode.BadUserInput);
    rules.minScore = 0;
    await expect(policy.check(WEAK, STRANGER)).resolves.toBeUndefined();
  });

  it('still refuses a password that is too short, under any score', async () => {
    const refusal = await refusalOf(policyWith({ minScore: 0, checkBreaches: false }).check('short', STRANGER));
    expect(refusal.message).toMatch(/^password: use at least/);
  });
});

describe('breached passwords', () => {
  const { prefix, suffix } = sha1Parts(VERY_HARD);
  const ON = { minScore: 0, checkBreaches: true };

  it('sends only the hash prefix, asks for padding, and refuses a password in the range', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const policy = policyWith(ON, async (url, init) => {
      calls.push({ url, init });
      return new Response(`0123456789ABCDEF0123456789ABCDEF012:3\r\n${suffix}:12\r\n`);
    });
    const refusal = await refusalOf(policy.check(VERY_HARD, STRANGER));
    expect(refusal.message).toMatch(/data breach/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(new Headers(calls[0]?.init.headers).get('Add-Padding')).toBe('true');
  });

  it('accepts a password that is not in the range, or only as padding', async () => {
    const policy = policyWith(ON, async () => new Response(`0123456789ABCDEF0123456789ABCDEF012:3\r\n${suffix}:0`));
    await expect(policy.check(VERY_HARD, STRANGER)).resolves.toBeUndefined();
  });

  it('asks nothing while the check is off', async () => {
    const fetchRange = vi.fn<FetchRange>();
    await policyWith({ minScore: 0, checkBreaches: false }, fetchRange).check(VERY_HARD, STRANGER);
    expect(fetchRange).not.toHaveBeenCalled();
  });

  it('lets the password through, and says so in the log, when the API fails or is slow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = policyWith(ON, async () => {
      throw new TypeError('fetch failed');
    });
    const refusing = policyWith(ON, async () => new Response('', { status: 503 }));
    const slow = policyWith(
      ON,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(failing.check(VERY_HARD, STRANGER)).resolves.toBeUndefined();
    await expect(refusing.check(VERY_HARD, STRANGER)).resolves.toBeUndefined();
    await expect(slow.check(VERY_HARD, STRANGER)).resolves.toBeUndefined();
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\[passwords\] .*accepted unchecked/);
      expect(line).not.toContain(VERY_HARD);
      expect(line).not.toContain(prefix);
    }
    warn.mockRestore();
  });
});
