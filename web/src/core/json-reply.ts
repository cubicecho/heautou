import { z } from 'zod';

/** A refusal's body: the message to show, and whatever else the route said about it. */
const refusalSchema = z.looseObject({ error: z.string() });

/** The reply of a route that only did what it was asked. */
export const okReplySchema = z.object({ ok: z.literal(true) });

/** The reply of a route that sends the browser on: where it goes next. */
export const redirectReplySchema = z.object({ redirectTo: z.string() });

/** A refusal from one of the server's own routes: its message, and the rest of what the reply said. */
export class ReplyError extends Error {
  /** The reply's HTTP status. */
  readonly status: number;
  /** The reply's fields besides `error`, such as the sign-in's `restart`; none for a reply without an `error`. */
  readonly fields: Readonly<Record<string, unknown>>;

  /**
   * @param message - What to show.
   * @param status - The reply's HTTP status.
   * @param fields - The reply's other fields.
   */
  constructor(message: string, status: number, fields: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'ReplyError';
    this.status = status;
    this.fields = fields;
  }
}

/**
 * Reads a JSON reply from one of the server's own routes, turning its `{error}` into a thrown {@link ReplyError}.
 *
 * @param response - The reply.
 * @param schema - What a successful reply holds.
 * @returns The parsed body.
 * @throws ReplyError with the server's message, or one naming the status for a reply without one.
 */
export async function jsonReply<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return schema.parse(body);
  }
  const refusal = refusalSchema.safeParse(body);
  if (refusal.success) {
    const { error, ...fields } = refusal.data;
    throw new ReplyError(error, response.status, fields);
  }
  throw new ReplyError(`The server answered ${response.status}.`, response.status, {});
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
