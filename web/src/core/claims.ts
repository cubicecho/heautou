import { linesOf } from '@/core/lists';

/** A claim of the operator's own, as the API takes it. */
export interface ClaimEntry {
  name: string;
  value: string;
}

/**
 * Reads claims typed one per line as `name=value`.
 *
 * @param text - The textarea's value.
 * @returns The claims, names and values trimmed; a line with no `=` has an empty value.
 */
export function claimsOf(text: string): ClaimEntry[] {
  return linesOf(text).map((line) => {
    const at = line.indexOf('=');
    return at === -1 ? { name: line, value: '' } : { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  });
}

/**
 * Writes claims one per line, for the textarea `claimsOf` reads.
 *
 * @param claims - The claims, value by name.
 * @returns The text.
 */
export function claimsText(claims: Readonly<Record<string, string>>): string {
  return Object.entries(claims)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

/**
 * Says what is wrong with typed claims.
 *
 * @param text - The textarea's value.
 * @returns The problem, or undefined when there is none.
 */
export function claimsProblem(text: string): string | undefined {
  const bad = linesOf(text).find((line) => line.indexOf('=') < 1);
  return bad === undefined ? undefined : `Write "${bad}" as name=value.`;
}
