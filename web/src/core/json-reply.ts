import { z } from 'zod';

const errorSchema = z.object({ error: z.string() });

/**
 * Reads a JSON reply from one of the server's own routes, turning its `{error}` into a thrown Error.
 *
 * @param response - The reply.
 * @param schema - What a successful reply holds.
 * @returns The parsed body.
 */
export async function jsonReply<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return schema.parse(body);
  }
  const failure = errorSchema.safeParse(body);
  throw new Error(failure.success ? failure.data.error : `The server answered ${response.status}.`);
}

/**
 * Posts JSON to one of the server's own routes.
 *
 * @param url - The route.
 * @param body - What to send.
 * @returns The reply.
 */
export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
