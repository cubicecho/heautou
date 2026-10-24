import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { jsonReply, postJson, ReplyError, redirectReplySchema } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

const choiceSchema = z.object({ totp: z.boolean(), passkey: z.boolean(), recoveryCode: z.boolean() });
const detailsSchema = z.object({
  clientName: z.string(),
  passkeysAvailable: z.boolean(),
  /** The providers users may sign in through instead. */
  upstreams: z.array(z.object({ id: z.string(), name: z.string() })),
  /** A sign-in that came back from one of them and still needs a second factor here. */
  secondFactor: choiceSchema.extend({ provider: z.string() }).nullable(),
});

/** The login POST's reply: where to go next, or which second factors to ask for. */
export const loginReplySchema = z.union([redirectReplySchema, z.object({ secondFactor: choiceSchema })]);

/** The passkey options POST's reply: what to hand the browser's WebAuthn call. */
export const passkeyOptionsReplySchema = z.object({
  options: z.custom<PublicKeyCredentialRequestOptionsJSON>(
    (value) => typeof value === 'object' && value !== null && 'challenge' in value,
  ),
});

/** The second factors a sign-in may ask for. */
export type SecondFactorChoice = z.infer<typeof choiceSchema>;

/**
 * Builds the path of a sign-in's interaction routes.
 *
 * @param uid - The sign-in.
 * @returns `/interaction/<uid>`, which the routes' own paths follow.
 */
export function interactionPath(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

/** A refusal from an interaction route: what to show, and whether the sign-in has to start again. */
export class SignInRefusal extends Error {
  readonly restart: boolean;

  /**
   * @param message - What to show.
   * @param restart - Whether the sign-in has to start again from the password.
   */
  constructor(message: string, restart: boolean) {
    super(message);
    this.restart = restart;
  }
}

/**
 * POSTs JSON to an interaction route and reads the reply.
 *
 * @typeParam T - The reply's shape.
 * @param url - The route.
 * @param body - What to send.
 * @param schema - The reply's shape.
 * @returns The reply.
 * @throws SignInRefusal with the server's message when it refuses.
 */
export async function post<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  try {
    return await jsonReply(await postJson(url, body), schema);
  } catch (error) {
    if (error instanceof ReplyError) {
      throw new SignInRefusal(error.message, error.fields.restart === true);
    }
    throw error;
  }
}

/**
 * Reads what the sign-in page shows: the client asking, the providers offered, and a second factor still owed.
 *
 * @param uid - The sign-in.
 * @returns The query; it fails once the sign-in is over or unknown.
 */
export function useSignInDetails(uid: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.interaction, uid],
    queryFn: async () => jsonReply(await fetch(`${interactionPath(uid)}/details`), detailsSchema),
    retry: false,
  });
}

/**
 * Says whether a sign-in is still open in this browser.
 *
 * @param uid - The sign-in.
 * @returns Whether its details can still be read.
 */
export async function isSignInOpen(uid: string): Promise<boolean> {
  const details = await fetch(`${interactionPath(uid)}/details`).catch(() => null);
  return details?.ok === true;
}
