// The words a password must not lean on: its owner's username, name and email, whole and word by word. It imports
// nothing, so the web app's strength meter rates a password with the same words the server checks it against.

/** What splits a person's name or an email into the words zxcvbn should know. */
const WORD_BREAK = /[^\p{L}\p{N}]+/u;

/**
 * Lists the words zxcvbn should treat as guessable for a password's owner.
 *
 * @param values - Their username, name and email; blanks are skipped.
 * @returns The values whole and word by word, each once.
 */
export function guessableWords(values: readonly string[]): string[] {
  const words = values.flatMap((value) => value.split(WORD_BREAK));
  return [...new Set([...values, ...words])].filter((word) => word !== '');
}
