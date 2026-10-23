import { guessableWords } from '@server/core/password-words.ts';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '@/core/query-keys';

/** What zxcvbn makes of a password, as the meter shows it. */
export interface PasswordStrength {
  /** From 0 (guessed at once) to 4 (very hard to guess). */
  score: number;
  /** What makes it easy to guess, or null when nothing stands out. */
  warning: string | null;
  /** The first thing to try to make it harder, or null when there is none. */
  suggestion: string | null;
}

/** Rates one password, given the words its owner is known by. */
type Estimate = (password: string, userInputs: string[]) => PasswordStrength;

/**
 * Loads zxcvbn and its dictionaries, which are large, so they are fetched only when a meter first shows.
 *
 * @returns A function that rates a password.
 */
async function loadEstimate(): Promise<Estimate> {
  const [{ ZxcvbnFactory }, common, english] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]);
  const factory = new ZxcvbnFactory({
    translations: english.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...english.dictionary },
  });
  return (password, userInputs) => {
    const { score, feedback } = factory.check(password, userInputs);
    return { score, warning: feedback.warning, suggestion: feedback.suggestions[0] ?? null };
  };
}

/**
 * Rates a password as it is typed, loading zxcvbn on first use.
 *
 * @param password - The password typed so far.
 * @param owner - Its owner's username, name and email, which make a password easier to guess.
 * @returns The rating, or null while the password is empty or zxcvbn is loading.
 */
export function usePasswordStrength(password: string, owner: readonly string[]): PasswordStrength | null {
  const { data: estimate } = useQuery({
    queryKey: QUERY_KEYS.zxcvbn,
    queryFn: loadEstimate,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const isUnrated = password === '' || estimate === undefined;
  return isUnrated ? null : estimate(password, guessableWords(owner));
}
