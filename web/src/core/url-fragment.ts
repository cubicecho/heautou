/**
 * Reads a parameter from the page URL's fragment (`#token=…&uid=…`), where links carry what must never reach the
 * server's logs or a proxy's.
 *
 * @param name - The parameter.
 * @returns Its value, or null when the fragment has none.
 */
export function fragmentParam(name: string): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(name);
}
