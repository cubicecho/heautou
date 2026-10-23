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

/** One line typed as `name=value`, split at its first separator. */
export interface LinePair {
  /** What comes before the separator, trimmed; the whole line when it has none. */
  name: string;
  /** What comes after it, trimmed; empty when the line has none. */
  value: string;
}

/**
 * Reads lines typed as `name=value`, one per line, each split at its first separator.
 *
 * @param text - The textarea's value.
 * @param separator - What separates the name from the value.
 * @returns The non-blank lines as pairs.
 */
export function pairsOf(text: string, separator: string): LinePair[] {
  return linesOf(text).map((line) => {
    const at = line.indexOf(separator);
    const hasValue = at !== -1;
    return hasValue
      ? { name: line.slice(0, at).trim(), value: line.slice(at + separator.length).trim() }
      : { name: line, value: '' };
  });
}
