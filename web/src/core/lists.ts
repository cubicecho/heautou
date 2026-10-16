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
