/**
 * Says why an action failed, for an `Alert`.
 *
 * @param error - What the mutation threw.
 * @returns Its message, or a sentence when it has none.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The server did not answer.';
}
