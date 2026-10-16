/**
 * Splits what was typed one per line into its entries.
 *
 * @param text - The textarea's value.
 * @returns The non-blank lines, trimmed.
 */
export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Splits a comma-separated value into its entries.
 *
 * @param text - The field's value.
 * @returns The non-blank entries, trimmed.
 */
export function commaListOf(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Says why an action failed, for an `Alert`.
 *
 * @param error - What the mutation threw.
 * @returns Its message, or a sentence when it has none.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The server did not answer.';
}

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
 * @param claims - The claims.
 * @returns The text.
 */
export function claimsText(claims: readonly ClaimEntry[]): string {
  return claims.map(({ name, value }) => `${name}=${value}`).join('\n');
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
