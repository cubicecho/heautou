import type { z } from 'zod';
import { badInput } from './errors.ts';

/**
 * Parses caller input with a zod schema.
 *
 * @typeParam T - The schema.
 * @param schema - What the input must look like.
 * @param input - What the caller sent.
 * @returns The parsed input.
 * @throws BAD_USER_INPUT naming the first field that is wrong.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const [issue] = result.error.issues;
  const field = issue?.path.join('.') ?? '';
  const where = field === '' ? '' : `${field}: `;
  throw badInput(`${where}${issue?.message ?? 'invalid input'}`);
}
