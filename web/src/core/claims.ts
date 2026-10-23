import { type LinePair, linesOf, pairsOf } from '@/core/lists';

/** What separates a claim's name from its value on a line. */
const CLAIM_SEPARATOR = '=';

/**
 * Reads claims typed one per line as `name=value`.
 *
 * @param text - The textarea's value.
 * @returns The claims, names and values trimmed; a line with no `=` has an empty value.
 */
export function claimsOf(text: string): LinePair[] {
  return pairsOf(text, CLAIM_SEPARATOR);
}

/**
 * Writes claims one per line, for the textarea `claimsOf` reads.
 *
 * @param claims - The claims, value by name.
 * @returns The text.
 */
export function claimsText(claims: Readonly<Record<string, string>>): string {
  return Object.entries(claims)
    .map(([name, value]) => `${name}${CLAIM_SEPARATOR}${value}`)
    .join('\n');
}

/**
 * Says what is wrong with typed claims: a line needs a name before its `=`.
 *
 * @param text - The textarea's value.
 * @returns The problem, or undefined when there is none.
 */
export function claimsProblem(text: string): string | undefined {
  const bad = linesOf(text).find((line) => line.indexOf(CLAIM_SEPARATOR) < 1);
  return bad === undefined ? undefined : `Write "${bad}" as name=value.`;
}
