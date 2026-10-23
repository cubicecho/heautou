import type { GraphQLResolveInfo } from 'graphql';
import type { Context } from '../core/context.ts';
import { CLIENT_TOKEN_LIFETIME_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import { SCOPES } from '../oidc/provider.ts';
import { AuditType, clientTarget, recordAdminChange } from '../store/audit.ts';
import {
  CLIENT_SOURCE_PAIRED,
  ClientAuthMethod,
  type ClientFields,
  type NewClient,
  type OidcClient,
} from '../store/clients.ts';
import { refusedRedirectUris } from '../store/redirect-uris.ts';
import { GeneratedTable, requiredRow, rowWhere } from './rows.ts';

/** The clients part of the admin API: what a row can't hold, the provider's URLs, token lifetimes and every change. */
export const CLIENT_TYPE_DEFS = /* GraphQL */ `
  extend type Client {
    "The client secret. Null for a public client."
    clientSecret: String
    "Its redirect and post-logout URIs the redirect rule refuses now. Saved before the rule applied, they still work; saving the client again needs them changed."
    refusedRedirectUris: [String!]!
    "The app it belongs to, which groups the clients one app paired. Null for a client the operator added."
    app: ClientApp
  }

  "The app a paired client belongs to. Its clients share the id."
  type ClientApp {
    "The pairing that registered its clients, or, for clients paired before that was recorded, the address of the API they are allowed on."
    id: ID!
    "The app's address: the client_uri it paired with, or that API's origin. Null when it gave none."
    uri: String
  }

  "How long tokens stay valid when their client does not say, in seconds, and the bounds a client's own must keep to."
  type TokenLifetimeDefaults {
    accessTokenSeconds: Int!
    "An access token a client gets for itself with client credentials."
    clientCredentialsSeconds: Int!
    idTokenSeconds: Int!
    refreshTokenSeconds: Int!
    "Shortest lifetime a client may give its tokens."
    minSeconds: Int!
    "Longest lifetime a client may give its tokens."
    maxSeconds: Int!
  }

  "What an application needs to be pointed at this provider."
  type ProviderInfo {
    "The issuer URL."
    issuer: String!
    "The OpenID discovery document."
    discoveryUrl: String!
    "The scopes clients may ask for."
    scopes: [String!]!
    "The token introspection endpoint."
    introspectionUrl: String!
  }

  "A client to add. A blank clientId gets a random one."
  input NewClientInput {
    clientId: String
    name: String!
    authMethod: ClientAuthMethod!
    "May be empty for a client that only uses client credentials or the device flow."
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
    allowedGroups: [String!]
    groupsClaim: String
    allowClientCredentials: Boolean
    allowDeviceFlow: Boolean
    tokenLifetimes: ClientTokenLifetimesInput
    "Where the provider posts a logout token when one of its users signs out. An empty string removes it."
    backchannelLogoutUri: String
    backchannelLogoutSessionRequired: Boolean
    "The preset it was started from. Left out keeps it; an empty string removes it."
    preset: String
  }

  "How long one client's tokens stay valid, in seconds. A lifetime left out or null is the server's default."
  input ClientTokenLifetimesInput {
    accessTokenSeconds: Int
    idTokenSeconds: Int
    refreshTokenSeconds: Int
  }

  "A client's new settings. A field left out keeps its value."
  input ClientInput {
    name: String!
    authMethod: ClientAuthMethod!
    redirectUris: [String!]!
    postLogoutRedirectUris: [String!]!
    allowedGroups: [String!]
    groupsClaim: String
    allowClientCredentials: Boolean
    allowDeviceFlow: Boolean
    tokenLifetimes: ClientTokenLifetimesInput
    "Where the provider posts a logout token when one of its users signs out. An empty string removes it."
    backchannelLogoutUri: String
    backchannelLogoutSessionRequired: Boolean
    "The preset it was started from. Left out keeps it; an empty string removes it."
    preset: String
  }

  extend type Query {
    "The provider's own URLs."
    provider: ProviderInfo!
    "The token lifetimes a client gets unless it is given its own."
    tokenLifetimeDefaults: TokenLifetimeDefaults!
  }

  extend type Mutation {
    "Adds a client. A confidential one is given a secret."
    createClient(input: NewClientInput!): Client!
    "Changes a client. Switching to NONE drops its secret; switching away makes one."
    updateClient(clientId: ID!, input: ClientInput!): Client!
    "Replaces a confidential client's secret. The old one stops working at once."
    rotateClientSecret(clientId: ID!): Client!
    "Removes a client. Its users are signed out of it at their next token refresh."
    deleteClient(clientId: ID!): Client!
  }
`;

/** Where discovery lives under the issuer. */
const DISCOVERY_PATH = '/.well-known/openid-configuration';
/** Where introspection lives under the issuer. */
const INTROSPECTION_PATH = '/token/introspection';

/** What `Query.provider` returns. */
interface ProviderInfo {
  issuer: string;
  discoveryUrl: string;
  scopes: readonly string[];
  introspectionUrl: string;
}

/** What `ClientApp` resolves from. */
interface ClientApp {
  id: string;
  uri: string | null;
}

/** The part of a generated `Client` row the hand-written fields read. */
interface ClientRow {
  clientId: string;
}

/**
 * Picks a client's row out by its client ID.
 *
 * @param clientId - The client.
 * @returns The filter.
 */
export const clientById = (clientId: string) => ({ clientId: { eq: clientId } });

/**
 * Finds the app a client belongs to. A client paired since pairings were recorded on clients has its pairing. One
 * paired before has nothing recorded, so it is placed by the APIs it is allowed on, when they are all on one origin:
 * an app's sign-in and device clients are both allowed on its own API. A client the operator added has no app.
 *
 * @param client - The client.
 * @param ctx - Request context, for the APIs.
 * @returns The app, or null.
 */
function clientAppOf(client: OidcClient, ctx: Pick<Context, 'apis'>): ClientApp | null {
  if (client.source !== CLIENT_SOURCE_PAIRED) {
    return null;
  }
  if (client.pairingId !== null) {
    return { id: client.pairingId, uri: client.clientUri };
  }
  const origins = new Set(
    ctx.apis
      .list()
      .filter((api) => api.allowedClientIds.includes(client.clientId))
      // An identifier that is not a web address (a URN) has no origin, and stands for itself.
      .map((api) => (/^https?:/.test(api.identifier) ? new URL(api.identifier).origin : api.identifier)),
  );
  const [origin] = origins;
  const isOneSite = origins.size === 1 && origin !== undefined && /^https?:/.test(origin);
  return isOneSite ? { id: `api:${origin}`, uri: origin } : null;
}

/**
 * Loads a client by its row.
 *
 * @param ctx - Request context.
 * @param row - The client's row.
 * @returns The client, as its store keeps it.
 * @throws NOT_FOUND when it has been removed since the row was read.
 */
function clientOfRow(ctx: Context, row: ClientRow): OidcClient {
  const client = ctx.clients.find(row.clientId);
  if (client === null) {
    throw notFound(`No client has the ID "${row.clientId}".`);
  }
  return client;
}

/** The resolvers for the clients, merged with the rest of the schema's. */
export const clientResolvers = {
  Client: {
    /**
     * Resolves `Client.clientSecret`, opened: the table holds it sealed.
     *
     * @param row - The client's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The secret, or null for a public client.
     */
    clientSecret: (row: ClientRow, _args: unknown, ctx: Context): string | null => clientOfRow(ctx, row).clientSecret,
    /**
     * Resolves `Client.app`.
     *
     * @param row - The client's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The app it belongs to, or null.
     */
    app: (row: ClientRow, _args: unknown, ctx: Context): ClientApp | null => clientAppOf(clientOfRow(ctx, row), ctx),
    /**
     * Resolves `Client.refusedRedirectUris`.
     *
     * @param row - The client's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Its URIs the redirect rule refuses now, for a client saved before the rule or the setting changed.
     */
    refusedRedirectUris: (row: ClientRow, _args: unknown, ctx: Context): string[] => {
      const client = clientOfRow(ctx, row);
      return refusedRedirectUris(client, {
        allowsHttp: ctx.settings.httpRedirects().isAllowed,
        isPublic: client.authMethod === ClientAuthMethod.None,
      });
    },
  },
  Query: {
    /**
     * Resolves `Query.tokenLifetimeDefaults`.
     *
     * @returns The server's token lifetimes and the bounds on a client's own.
     */
    tokenLifetimeDefaults: () => {
      const { accessTokenSeconds, clientCredentialsSeconds, idTokenSeconds, refreshTokenSeconds } =
        TOKEN_LIFETIME_DEFAULTS;
      return {
        accessTokenSeconds,
        clientCredentialsSeconds,
        idTokenSeconds,
        refreshTokenSeconds,
        ...CLIENT_TOKEN_LIFETIME_DEFAULTS,
      };
    },
    /**
     * Resolves `Query.provider`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The issuer, discovery URL and scopes.
     */
    provider: (_parent: unknown, _args: unknown, ctx: Context): ProviderInfo => ({
      issuer: ctx.issuer,
      discoveryUrl: `${ctx.issuer}${DISCOVERY_PATH}`,
      scopes: SCOPES,
      introspectionUrl: `${ctx.issuer}${INTROSPECTION_PATH}`,
    }),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createClient`.
     *
     * @param _parent - Unused.
     * @param args - The client to add.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The new client, with its secret.
     */
    createClient: async (_parent: unknown, args: { input: NewClient }, ctx: Context, info: GraphQLResolveInfo) => {
      const client = await ctx.clients.create(args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.ClientCreated, clientTarget(client));
      return requiredRow(ctx, info, GeneratedTable.Clients, clientById(client.clientId));
    },
    /**
     * Resolves `Mutation.updateClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID and its new settings.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The changed client.
     */
    updateClient: async (
      _parent: unknown,
      args: { clientId: string; input: ClientFields },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const client = await ctx.clients.update(args.clientId, args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.ClientUpdated, clientTarget(client));
      return requiredRow(ctx, info, GeneratedTable.Clients, clientById(client.clientId));
    },
    /**
     * Resolves `Mutation.rotateClientSecret`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The client, with its new secret.
     */
    rotateClientSecret: async (
      _parent: unknown,
      args: { clientId: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const client = await ctx.clients.rotateSecret(args.clientId);
      recordAdminChange(ctx, AuditType.ClientSecretRotated, clientTarget(client));
      return requiredRow(ctx, info, GeneratedTable.Clients, clientById(client.clientId));
    },
    /**
     * Resolves `Mutation.deleteClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The removed client, as it was.
     */
    deleteClient: async (_parent: unknown, args: { clientId: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.Clients, clientById(args.clientId));
      const client = await ctx.clients.remove(args.clientId);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.ClientDeleted, clientTarget(client));
      return row;
    },
  },
};
