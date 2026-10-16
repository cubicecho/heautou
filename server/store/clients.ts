import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ADMIN_DEFAULTS, CREDENTIAL_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import { DEFAULT_GROUPS_CLAIM, groupsClaimSchema, replaceGroupIn, withoutBlanks } from './claims.ts';
import type { JsonFile } from './json-file.ts';

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
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** Characters a client ID may hold: what fits in a URL and a config file without quoting. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const uriList = z.array(z.url({ protocol: /^[a-z][a-z0-9+.-]*$/ }).trim());

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
});

/**
 * Checks the rules between fields: a client that signs users in needs somewhere to send them back, and the
 * client credentials grant needs a secret.
 *
 * @param client - The parsed fields.
 * @param ctx - Where problems are reported.
 */
function checkFlows(client: z.infer<typeof clientFields>, ctx: z.RefinementCtx): void {
  if (client.redirectUris.length === 0 && client.allowClientCredentials === false) {
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
export type ClientFields = z.input<typeof clientFieldsSchema>;

const newClientSchema = clientFields
  .extend({
    clientId: z
      .string()
      .trim()
      .regex(CLIENT_ID_PATTERN, 'use letters, digits, ".", "-" and "_" only')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .superRefine(checkFlows);
export type NewClient = z.input<typeof newClientSchema>;

/** The clients, kept in one JSON file. */
export interface ClientStore {
  list: () => OidcClient[];
  find: (clientId: string) => OidcClient | null;
  create: (input: NewClient) => OidcClient;
  update: (clientId: string, input: ClientFields) => OidcClient;
  rotateSecret: (clientId: string) => OidcClient;
  remove: (clientId: string) => OidcClient;
  /**
   * Renames a group in every client's allowed groups, or takes it out of them.
   *
   * @param from - The group.
   * @param to - Its new name, or null to remove it.
   */
  replaceGroup: (from: string, to: string | null) => void;
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
 * Builds the client store over a JSON file.
 *
 * @param file - The file holding every client.
 * @param [now] - The clock, for `createdAt`.
 * @returns The store.
 */
export function createClientStore(file: JsonFile<OidcClient[]>, now: () => Date = () => new Date()): ClientStore {
  const stored = (): OidcClient[] => file.read().map(withDefaults);
  const find = (clientId: string): OidcClient | null => stored().find((client) => client.clientId === clientId) ?? null;

  const load = (clientId: string): OidcClient => {
    const client = find(clientId);
    if (client === null) {
      throw notFound(`No client has the ID "${clientId}".`);
    }
    return client;
  };

  const replace = (next: OidcClient): OidcClient => {
    file.update(() => stored().map((client) => (client.clientId === next.clientId ? next : client)));
    return next;
  };

  return {
    list: stored,
    find,
    create: (input) => {
      const { clientId = randomUUID(), ...fields } = parseInput(newClientSchema, withoutBlanks(input));
      const isTaken = find(clientId) !== null || clientId === ADMIN_DEFAULTS.clientId;
      if (isTaken) {
        throw badInput(`clientId: "${clientId}" is already taken.`);
      }
      const client = withSecretFor({ ...fields, clientId, clientSecret: null, createdAt: now().toISOString() });
      file.update(() => [...stored(), client]);
      return client;
    },
    update: (clientId, input) => {
      const current = load(clientId);
      // What the input leaves out keeps its value, rather than taking the default a new client gets.
      const { allowedGroups, groupsClaim, allowClientCredentials } = current;
      const merged = { allowedGroups, groupsClaim, allowClientCredentials, ...withoutBlanks(input) };
      const fields = parseInput(clientFieldsSchema, merged);
      return replace(withSecretFor({ ...current, ...fields }));
    },
    rotateSecret: (clientId) => {
      const client = load(clientId);
      if (client.authMethod === ClientAuthMethod.None) {
        throw badInput(`"${client.name}" is a public client and has no secret.`);
      }
      return replace({ ...client, clientSecret: newSecret() });
    },
    remove: (clientId) => {
      const client = load(clientId);
      file.update(() => stored().filter((other) => other.clientId !== clientId));
      return client;
    },
    replaceGroup: (from, to) => {
      const isUsed = stored().some((client) => client.allowedGroups.includes(from));
      if (isUsed) {
        file.update(() =>
          stored().map((client) => ({ ...client, allowedGroups: replaceGroupIn(client.allowedGroups, from, to) })),
        );
      }
    },
  };
}
