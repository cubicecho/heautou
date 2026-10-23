import { z } from 'zod';
import { API_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import { withoutBlanks } from './claims.ts';

/** An access token the API checks by itself: a JWT signed with the provider's keys, verified with its JWKS. */
export const TOKEN_FORMAT_JWT = 'jwt' as const;
/** An access token the API checks by calling the provider's introspection endpoint. */
export const TOKEN_FORMAT_OPAQUE = 'opaque' as const;
/** How an API's access tokens are written. */
export type TokenFormat = typeof TOKEN_FORMAT_JWT | typeof TOKEN_FORMAT_OPAQUE;

/** An API (a resource server) apps ask for access tokens to with the `resource` parameter (RFC 8707). */
export interface Api {
  /** The resource indicator apps send, and the `aud` of its tokens: an absolute URI with no fragment. */
  identifier: string;
  /** What the operator calls it. */
  name: string;
  /** The scopes it understands. A token for it carries only those of the ones asked for. */
  scopes: string[];
  tokenFormat: TokenFormat;
  /** How long its access tokens stay valid, in seconds. Null leaves it to the client's own, then the server's. */
  accessTokenSeconds: number | null;
  /** The clients that may ask for tokens to it. Empty lets none. */
  allowedClientIds: string[];
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** A scope token (RFC 6749, section 3.3): printable ASCII but space, `"` and `\`. */
export const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const { minAccessTokenSeconds, maxAccessTokenSeconds, maxNameLength, maxScopes } = API_DEFAULTS;

/**
 * Says what is wrong with a resource indicator.
 *
 * @param identifier - What the operator typed.
 * @returns The problem, or null for an absolute URI with no fragment.
 */
export function identifierProblem(identifier: string): string | null {
  if (URL.canParse(identifier) === false || /\s/.test(identifier)) {
    return 'use an absolute URI, such as https://photos-api.home.lan';
  }
  // RFC 8707 forbids a fragment; oidc-provider refuses one in a request too.
  return identifier.includes('#') ? 'leave the fragment out of the identifier' : null;
}

/**
 * Builds the schema for what the operator writes when adding or changing an API.
 *
 * @param reservedScopes - The provider's own scopes, which an API may not claim.
 * @returns The schema.
 */
function apiFieldsSchemaFor(reservedScopes: readonly string[]) {
  const scope = z
    .string()
    .trim()
    .regex(SCOPE_TOKEN, 'write each scope as one word, without spaces, quotes or backslashes')
    .refine(
      (value) => reservedScopes.includes(value) === false,
      `use scopes of the API's own, not the provider's (${reservedScopes.join(', ')})`,
    );
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, 'give the API a name')
      .max(maxNameLength, `keep the name to ${maxNameLength} characters`),
    scopes: z
      .array(scope)
      .max(maxScopes, `list at most ${maxScopes} scopes`)
      .transform((scopes) => [...new Set(scopes)])
      .default([]),
    tokenFormat: z.enum([TOKEN_FORMAT_JWT, TOKEN_FORMAT_OPAQUE]).default(TOKEN_FORMAT_JWT),
    accessTokenSeconds: z
      .number()
      .int('give a whole number of seconds')
      .min(minAccessTokenSeconds, `make it at least ${minAccessTokenSeconds} seconds`)
      .max(maxAccessTokenSeconds, `make it at most ${maxAccessTokenSeconds} seconds`)
      .nullable()
      .default(null),
    allowedClientIds: z
      .array(z.string().trim().min(1))
      .transform((ids) => [...new Set(ids)])
      .default([]),
  });
}

/** What the operator writes when changing an API. A field left out keeps its value; `accessTokenSeconds` null clears it. */
export type ApiFields = Partial<z.input<ReturnType<typeof apiFieldsSchemaFor>>>;
/** What the operator writes when adding an API. */
export type NewApi = z.input<ReturnType<typeof apiFieldsSchemaFor>> & { identifier: string };

/** The APIs, kept in one JSON file. */
export interface ApiStore {
  list: () => Api[];
  find: (identifier: string) => Api | null;
  create: (input: NewApi) => Promise<Api>;
  update: (identifier: string, input: ApiFields) => Promise<Api>;
  remove: (identifier: string) => Promise<Api>;
  /**
   * Takes a client off every API's allowed list, when the client is removed.
   *
   * @param clientId - The client.
   */
  removeClient: (clientId: string) => Promise<void>;
}

/** What the API store is built with besides its file. */
export interface ApiStoreOptions {
  /** Says whether a client exists, so an API names only real ones. */
  clientExists: (clientId: string) => boolean;
  /** The provider's own scopes (`openid`, `profile`...), which an API may not list. */
  reservedScopes: readonly string[];
  /** The clock, for `createdAt`. */
  now?: () => Date;
}

/**
 * Builds the API store over a JSON file.
 *
 * @param document - The document holding every API.
 * @param options - Which clients exist, the provider's own scopes and the clock.
 * @returns The store.
 */
export function createApiStore(document: DataDocument<Api[]>, options: ApiStoreOptions): ApiStore {
  const { clientExists, reservedScopes, now = () => new Date() } = options;
  const fieldsSchema = apiFieldsSchemaFor(reservedScopes);
  const find = (identifier: string): Api | null => document.read().find((api) => api.identifier === identifier) ?? null;

  const load = (identifier: string): Api => {
    const api = find(identifier);
    if (api === null) {
      throw notFound(`No API has the identifier "${identifier}".`);
    }
    return api;
  };

  const checkClients = (clientIds: readonly string[]): void => {
    const unknown = clientIds.find((clientId) => clientExists(clientId) === false);
    if (unknown !== undefined) {
      throw badInput(`allowedClientIds: no client has the ID "${unknown}".`);
    }
  };

  return {
    list: () => document.read(),
    find,
    create: async ({ identifier: raw, ...input }) => {
      const identifier = raw.trim();
      const problem = identifierProblem(identifier);
      if (problem !== null) {
        throw badInput(`identifier: ${problem}.`);
      }
      if (find(identifier) !== null) {
        throw badInput(`identifier: "${identifier}" is already taken.`);
      }
      const fields = parseInput(fieldsSchema, withoutBlanks(input));
      checkClients(fields.allowedClientIds);
      const api: Api = { identifier, ...fields, createdAt: now().toISOString() };
      await document.update((apis) => [...apis, api]);
      return api;
    },
    update: async (identifier, input) => {
      const { createdAt, ...current } = load(identifier);
      // Null clears the lifetime rather than keeping it, so it is taken before the blanks are dropped.
      const hasLifetime = Object.hasOwn(input, 'accessTokenSeconds');
      const lifetime = hasLifetime ? { accessTokenSeconds: input.accessTokenSeconds ?? null } : {};
      const fields = parseInput(fieldsSchema, { ...current, ...withoutBlanks(input), ...lifetime });
      checkClients(fields.allowedClientIds);
      const next: Api = { ...fields, identifier, createdAt };
      await document.update((apis) => apis.map((api) => (api.identifier === identifier ? next : api)));
      return next;
    },
    remove: async (identifier) => {
      const api = load(identifier);
      await document.update((apis) => apis.filter((other) => other.identifier !== identifier));
      return api;
    },
    removeClient: async (clientId) => {
      const isUsed = document.read().some((api) => api.allowedClientIds.includes(clientId));
      if (isUsed) {
        await document.update((apis) =>
          apis.map((api) => ({ ...api, allowedClientIds: api.allowedClientIds.filter((id) => id !== clientId) })),
        );
      }
    },
  };
}
