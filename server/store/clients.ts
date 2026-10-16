import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CREDENTIAL_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
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
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** Characters a client ID may hold: what fits in a URL and a config file without quoting. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const uriList = z.array(z.url({ protocol: /^[a-z][a-z0-9+.-]*$/ }).trim());

/** What the operator writes when adding or changing a client. */
const clientFieldsSchema = z.object({
  name: z.string().trim().min(1, 'give the client a name'),
  authMethod: z.enum(ClientAuthMethod),
  redirectUris: uriList.min(1, 'add at least one redirect URI'),
  postLogoutRedirectUris: uriList,
});
export type ClientFields = z.infer<typeof clientFieldsSchema>;

const newClientSchema = clientFieldsSchema.extend({
  clientId: z
    .string()
    .trim()
    .regex(CLIENT_ID_PATTERN, 'use letters, digits, ".", "-" and "_" only')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type NewClient = z.input<typeof newClientSchema>;

/** The clients, kept in one JSON file. */
export interface ClientStore {
  list: () => OidcClient[];
  find: (clientId: string) => OidcClient | null;
  create: (input: NewClient) => OidcClient;
  update: (clientId: string, input: ClientFields) => OidcClient;
  rotateSecret: (clientId: string) => OidcClient;
  remove: (clientId: string) => OidcClient;
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
  const find = (clientId: string): OidcClient | null =>
    file.read().find((client) => client.clientId === clientId) ?? null;

  const load = (clientId: string): OidcClient => {
    const client = find(clientId);
    if (client === null) {
      throw notFound(`No client has the ID "${clientId}".`);
    }
    return client;
  };

  const replace = (next: OidcClient): OidcClient => {
    file.update((clients) => clients.map((client) => (client.clientId === next.clientId ? next : client)));
    return next;
  };

  return {
    list: () => file.read(),
    find,
    create: (input) => {
      const { clientId = randomUUID(), ...fields } = parseInput(newClientSchema, input);
      if (find(clientId) !== null) {
        throw badInput(`clientId: "${clientId}" is already taken.`);
      }
      const client = withSecretFor({ ...fields, clientId, clientSecret: null, createdAt: now().toISOString() });
      file.update((clients) => [...clients, client]);
      return client;
    },
    update: (clientId, input) => {
      const fields = parseInput(clientFieldsSchema, input);
      return replace(withSecretFor({ ...load(clientId), ...fields }));
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
      file.update((clients) => clients.filter((other) => other.clientId !== clientId));
      return client;
    },
  };
}
