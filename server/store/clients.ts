import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ADMIN_DEFAULTS,
  CLIENT_TOKEN_LIFETIME_DEFAULTS,
  CREDENTIAL_DEFAULTS,
  FORWARD_AUTH_DEFAULTS,
} from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import { DEFAULT_GROUPS_CLAIM, groupsClaimSchema, replaceGroupIn, withoutBlanks } from './claims.ts';
import { redirectProblem, redirectUriProblem } from './redirect-uris.ts';
import type { SecretMapper } from './sealed-document.ts';

/** How a client proves who it is at the token endpoint. */
export const ClientAuthMethod = {
  /** The secret in an HTTP Basic header. What most server-side apps send. */
  SecretBasic: 'client_secret_basic',
  /** The secret in the form body. */
  SecretPost: 'client_secret_post',
  /** No secret: a public client, such as a single-page or native app. PKCE is required. */
  None: 'none',
} as const;
export type ClientAuthMethod = (typeof ClientAuthMethod)[keyof typeof ClientAuthMethod];

/** A client the operator added by hand. */
export const CLIENT_SOURCE_ADMIN = 'admin' as const;
/** A client an app registered itself as, with a setup URL. */
export const CLIENT_SOURCE_PAIRED = 'paired' as const;
/** How a client came to be. */
export type ClientSource = typeof CLIENT_SOURCE_ADMIN | typeof CLIENT_SOURCE_PAIRED;

/**
 * How long the tokens one client is given stay valid, in seconds. A null lifetime is the server's default
 * (`TOKEN_LIFETIME_DEFAULTS`).
 */
export interface ClientTokenLifetimes {
  /** Its access tokens, for a user or, with client credentials, for itself. */
  accessTokenSeconds: number | null;
  /** Its ID tokens. */
  idTokenSeconds: number | null;
  /** Its refresh tokens. */
  refreshTokenSeconds: number | null;
}

/** Every lifetime left to the server's default. */
export const DEFAULT_CLIENT_TOKEN_LIFETIMES: Readonly<ClientTokenLifetimes> = Object.freeze({
  accessTokenSeconds: null,
  idTokenSeconds: null,
  refreshTokenSeconds: null,
});

/** An application that signs its users in through this provider. */
export interface OidcClient {
  /** What the application is configured with as its client ID. */
  clientId: string;
  /** What the operator calls it. */
  name: string;
  /** The client secret, stored as given. Null for a public client. */
  clientSecret: string | null;
  authMethod: ClientAuthMethod;
  /** Where the provider may send the user back with a code. Matched exactly. */
  redirectUris: string[];
  /** Where the provider may send the user after signing out. */
  postLogoutRedirectUris: string[];
  /** Only users in one of these groups may sign in to it. Empty lets every user in. */
  allowedGroups: string[];
  /** The claim the user's groups are released in, for apps that read roles from another name. */
  groupsClaim: string;
  /** Whether it may get tokens for itself with the client credentials grant. Confidential clients only. */
  allowClientCredentials: boolean;
  /**
   * Whether it may sign users in with the device flow (RFC 8628): a device with no browser of its own shows a code,
   * and the user signs in on another device. Such a client also gets refresh tokens, and needs no redirect URI.
   */
  allowDeviceFlow: boolean;
  /** Whether the operator added it or an app paired itself. */
  source: ClientSource;
  /** The app's logo, as the app gave it when it paired. Null for none. */
  logoUri: string | null;
  /** How long its tokens stay valid, where the operator changed it. */
  tokenLifetimes: ClientTokenLifetimes;
  /** Where the provider posts a logout token when one of its users signs out (back-channel logout). Null for none. */
  backchannelLogoutUri: string | null;
  /** Whether the logout token, and its ID tokens, carry the session ID (`sid`) the app can match its session by. */
  backchannelLogoutSessionRequired: boolean;
  /**
   * The preset the operator started it from (the web app's `web/src/clients/presets.ts`), so the client can show
   * how to configure the app again. Null for none.
   */
  preset: string | null;
  /**
   * The pairing that registered it, which ties together the clients one app registered (its sign-in client and its
   * device client). Null for a client the operator added, or one paired before this was recorded.
   */
  pairingId: string | null;
  /** The `client_uri` it paired with: the app's address, as the app gave it. Null for none. */
  clientUri: string | null;
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** Characters a client ID may hold: what fits in a URL and a config file without quoting. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** What a preset's ID may be: the web app's own, so lowercase words joined by dashes. */
const PRESET_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PRESET_MAX_LENGTH = 64;

const uriList = z.array(z.url({ protocol: /^[a-z][a-z0-9+.-]*$/ }).trim());

const { minSeconds, maxSeconds } = CLIENT_TOKEN_LIFETIME_DEFAULTS;
const lifetime = z
  .number()
  .int('give a whole number of seconds')
  .min(minSeconds, `make it at least ${minSeconds} seconds`)
  .max(maxSeconds, `make it at most ${maxSeconds} seconds`)
  .nullable()
  .default(null);

const tokenLifetimesSchema = z
  .object({ accessTokenSeconds: lifetime, idTokenSeconds: lifetime, refreshTokenSeconds: lifetime })
  .default({ ...DEFAULT_CLIENT_TOKEN_LIFETIMES });

/** What the operator writes when adding or changing a client. */
const clientFields = z.object({
  name: z.string().trim().min(1, 'give the client a name'),
  authMethod: z.enum(ClientAuthMethod),
  redirectUris: uriList,
  postLogoutRedirectUris: uriList,
  allowedGroups: z
    .array(z.string().trim().min(1))
    .transform((groups) => [...new Set(groups)])
    .default([]),
  groupsClaim: groupsClaimSchema.default(DEFAULT_GROUPS_CLAIM),
  allowClientCredentials: z.boolean().default(false),
  allowDeviceFlow: z.boolean().default(false),
  logoUri: z
    .url({ protocol: /^https?$/ })
    .trim()
    .nullable()
    .default(null),
  tokenLifetimes: tokenLifetimesSchema,
  backchannelLogoutUri: z
    .literal('')
    .transform(() => null)
    .or(
      z
        .url({ protocol: /^https?$/ })
        .trim()
        .refine((uri) => new URL(uri).hash === '', 'leave the fragment out of the back-channel logout URI'),
    )
    .nullable()
    .default(null),
  backchannelLogoutSessionRequired: z.boolean().default(true),
  preset: z
    .literal('')
    .transform(() => null)
    .or(
      z
        .string()
        .trim()
        .max(PRESET_MAX_LENGTH)
        .regex(PRESET_PATTERN, 'name a preset with lowercase letters, digits and "-" only'),
    )
    .nullable()
    .default(null),
});

/**
 * Checks the rules between fields: a client that signs users in with a redirect needs somewhere to send them back
 * (the device flow needs none), and the client credentials grant needs a secret.
 *
 * @param client - The parsed fields.
 * @param ctx - Where problems are reported.
 */
function checkFlows(client: z.infer<typeof clientFields>, ctx: z.RefinementCtx): void {
  checkClientFlows(client, ctx, false);
}

/**
 * Checks the rules between fields as `checkFlows` does, except that a client that may wait may have no flow at all:
 * a paired app's device client, which does nothing until the operator turns its device flow on.
 *
 * @param client - The parsed fields.
 * @param ctx - Where problems are reported.
 * @param mayWait - True for a paired client.
 */
function checkClientFlows(client: z.infer<typeof clientFields>, ctx: z.RefinementCtx, mayWait: boolean): void {
  const hasOtherFlow = client.allowClientCredentials || client.allowDeviceFlow;
  if (client.redirectUris.length === 0 && hasOtherFlow === false && mayWait === false) {
    ctx.addIssue({ code: 'custom', path: ['redirectUris'], message: 'add at least one redirect URI' });
  }
  if (client.allowClientCredentials && client.authMethod === ClientAuthMethod.None) {
    ctx.addIssue({
      code: 'custom',
      path: ['allowClientCredentials'],
      message: 'a public client has no secret to use the client credentials grant with',
    });
  }
}

const clientFieldsSchema = clientFields.superRefine(checkFlows);
/** A paired client's fields, which may switch every flow off. */
const pairedClientFieldsSchema = clientFields.superRefine((client, ctx) => checkClientFlows(client, ctx, true));
export type ClientFields = z.input<typeof clientFieldsSchema>;

const newClientSchema = clientFields
  .extend({
    clientId: z
      .string()
      .trim()
      .regex(CLIENT_ID_PATTERN, 'use letters, digits, ".", "-" and "_" only')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    source: z.enum([CLIENT_SOURCE_ADMIN, CLIENT_SOURCE_PAIRED]).default(CLIENT_SOURCE_ADMIN),
    pairingId: z.string().nullable().default(null),
    clientUri: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .default(null),
  })
  .superRefine((client, ctx) => checkClientFlows(client, ctx, client.source === CLIENT_SOURCE_PAIRED));
export type NewClient = z.input<typeof newClientSchema>;

/** The clients. A change is made in memory at once and resolves when it is saved. */
export interface ClientStore {
  list: () => OidcClient[];
  find: (clientId: string) => OidcClient | null;
  create: (input: NewClient) => Promise<OidcClient>;
  update: (clientId: string, input: ClientFields) => Promise<OidcClient>;
  rotateSecret: (clientId: string) => Promise<OidcClient>;
  remove: (clientId: string) => Promise<OidcClient>;
  /**
   * Renames a group in every client's allowed groups, or takes it out of them.
   *
   * @param from - The group.
   * @param to - Its new name, or null to remove it.
   */
  replaceGroup: (from: string, to: string | null) => Promise<void>;
}

/** What the client store is built with besides its document. */
export interface ClientStoreOptions {
  /** The clock, in epoch milliseconds, for `createdAt`. */
  now?: () => number;
  /** Whether plain http redirect URIs are allowed on any host. Asked on every save; refused when left out. */
  allowsHttpRedirects?: () => boolean;
  /** Told after a client is removed, so what names it (an API's allowed clients) can let it go. */
  onRemove?: (clientId: string) => Promise<void>;
}

/**
 * Fills in what a file written by an older version lacks.
 *
 * @param client - The client as read from the file.
 * @returns The client with every field.
 */
function withDefaults(client: OidcClient): OidcClient {
  return {
    ...client,
    allowedGroups: client.allowedGroups ?? [],
    groupsClaim: client.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
    allowClientCredentials: client.allowClientCredentials ?? false,
    allowDeviceFlow: client.allowDeviceFlow ?? false,
    source: client.source ?? CLIENT_SOURCE_ADMIN,
    logoUri: client.logoUri ?? null,
    tokenLifetimes: { ...DEFAULT_CLIENT_TOKEN_LIFETIMES, ...client.tokenLifetimes },
    backchannelLogoutUri: client.backchannelLogoutUri ?? null,
    backchannelLogoutSessionRequired: client.backchannelLogoutSessionRequired ?? true,
    preset: client.preset ?? null,
    pairingId: client.pairingId ?? null,
    clientUri: client.clientUri ?? null,
  };
}

/**
 * Makes a client secret.
 *
 * @returns Random base64url text.
 */
function newSecret(): string {
  return randomBytes(CREDENTIAL_DEFAULTS.clientSecretBytes).toString('base64url');
}

/**
 * Gives a client the secret its auth method calls for, keeping the one it has.
 *
 * @param client - The client as it will be saved.
 * @returns The client, with a secret when it is confidential and none when it is public.
 */
function withSecretFor(client: OidcClient): OidcClient {
  if (client.authMethod === ClientAuthMethod.None) {
    return { ...client, clientSecret: null };
  }
  return { ...client, clientSecret: client.clientSecret ?? newSecret() };
}

/**
 * Finds the secrets in the client document: each confidential client's secret.
 *
 * @param clients - The clients as stored.
 * @param change - Seals or opens one secret.
 * @returns The clients with their secrets changed.
 */
export const clientSecretsIn: SecretMapper<OidcClient[]> = (clients, change) =>
  clients.map((client) =>
    typeof client.clientSecret === 'string' ? { ...client, clientSecret: change(client.clientSecret) } : client,
  );

/**
 * Builds the client store over its document. Redirect and back-channel logout URIs are checked against the https
 * rule (`redirect-uris.ts`) when a client is saved; clients already saved are read as they are.
 *
 * @param document - The document holding every client.
 * @param [options] - The clock, whether plain http redirect URIs are allowed, and who is told of a removal.
 * @returns The store.
 */
export function createClientStore(document: DataDocument<OidcClient[]>, options: ClientStoreOptions = {}): ClientStore {
  const { now = Date.now, allowsHttpRedirects = () => false, onRemove = async () => {} } = options;
  type CheckedUris = Pick<
    OidcClient,
    'authMethod' | 'redirectUris' | 'postLogoutRedirectUris' | 'backchannelLogoutUri'
  >;
  const checkRedirects = (client: CheckedUris) => {
    const allowsHttp = allowsHttpRedirects();
    const problem = redirectProblem(client, { allowsHttp, isPublic: client.authMethod === ClientAuthMethod.None });
    if (problem !== null) {
      throw badInput(`${problem.field}: ${problem.message}.`);
    }
    // The provider calls this one itself, so it is held to the https rule as a confidential client's URI is.
    const { backchannelLogoutUri } = client;
    const backchannelProblem =
      backchannelLogoutUri === null ? null : redirectUriProblem(backchannelLogoutUri, { allowsHttp, isPublic: false });
    if (backchannelProblem !== null) {
      throw badInput(`backchannelLogoutUri: ${backchannelProblem}.`);
    }
  };
  const stored = (): OidcClient[] => document.read().map(withDefaults);
  const find = (clientId: string): OidcClient | null => stored().find((client) => client.clientId === clientId) ?? null;

  const load = (clientId: string): OidcClient => {
    const client = find(clientId);
    if (client === null) {
      throw notFound(`No client has the ID "${clientId}".`);
    }
    return client;
  };

  const replace = async (next: OidcClient): Promise<OidcClient> => {
    await document.update(() => stored().map((client) => (client.clientId === next.clientId ? next : client)));
    return next;
  };

  return {
    list: stored,
    find,
    create: async (input) => {
      const { clientId = randomUUID(), ...fields } = parseInput(newClientSchema, withoutBlanks(input));
      const isBuiltIn = clientId === ADMIN_DEFAULTS.clientId || clientId === FORWARD_AUTH_DEFAULTS.clientId;
      const isTaken = find(clientId) !== null || isBuiltIn;
      if (isTaken) {
        throw badInput(`clientId: "${clientId}" is already taken.`);
      }
      checkRedirects(fields);
      const client = withSecretFor({
        ...fields,
        clientId,
        clientSecret: null,
        createdAt: new Date(now()).toISOString(),
      });
      await document.update(() => [...stored(), client]);
      return client;
    },
    update: async (clientId, input) => {
      const current = load(clientId);
      // What the input leaves out keeps its value, rather than taking the default a new client gets.
      const { allowedGroups, groupsClaim, allowClientCredentials, allowDeviceFlow, logoUri, tokenLifetimes } = current;
      const { backchannelLogoutUri, backchannelLogoutSessionRequired, preset } = current;
      const kept = {
        preset,
        allowedGroups,
        groupsClaim,
        allowClientCredentials,
        allowDeviceFlow,
        logoUri,
        tokenLifetimes,
        backchannelLogoutUri,
        backchannelLogoutSessionRequired,
      };
      const merged = { ...kept, ...withoutBlanks(input) };
      // A paired device client may stay waiting; any other client keeps the usual rule.
      const mayWait = current.source === CLIENT_SOURCE_PAIRED && current.redirectUris.length === 0;
      const schema = mayWait ? pairedClientFieldsSchema : clientFieldsSchema;
      const fields = parseInput(schema, merged);
      checkRedirects(fields);
      return replace(withSecretFor({ ...current, ...fields }));
    },
    rotateSecret: async (clientId) => {
      const client = load(clientId);
      if (client.authMethod === ClientAuthMethod.None) {
        throw badInput(`"${client.name}" is a public client and has no secret.`);
      }
      return replace({ ...client, clientSecret: newSecret() });
    },
    remove: async (clientId) => {
      const client = load(clientId);
      const removed = document.update(() => stored().filter((other) => other.clientId !== clientId));
      const released = onRemove(clientId);
      await Promise.all([removed, released]);
      return client;
    },
    replaceGroup: async (from, to) => {
      const isUsed = stored().some((client) => client.allowedGroups.includes(from));
      if (isUsed) {
        await document.update(() =>
          stored().map((client) => ({ ...client, allowedGroups: replaceGroupIn(client.allowedGroups, from, to) })),
        );
      }
    },
  };
}
