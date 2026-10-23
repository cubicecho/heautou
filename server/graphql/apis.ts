import type { GraphQLResolveInfo } from 'graphql';
import type { Context } from '../core/context.ts';
import { API_DEFAULTS } from '../core/defaults.ts';
import type { Api, ApiFields, NewApi } from '../store/apis.ts';
import { AuditType, apiTarget, recordAdminChange } from '../store/audit.ts';
import { GeneratedTable, requiredRow, rowWhere } from './rows.ts';

/** The APIs (resource servers) part of the admin API: the lifetime bounds, and every change. */
export const API_TYPE_DEFS = /* GraphQL */ `
  "The bounds on an API's own access token lifetime, in seconds."
  type ApiLifetimeBounds {
    minSeconds: Int!
    maxSeconds: Int!
  }

  "An API to add. Lists left out are empty; a null lifetime leaves it to the client's own, then the server's."
  input NewApiInput {
    "An absolute URI with no fragment, such as https://photos-api.home.lan. It can't be changed later."
    identifier: String!
    name: String!
    "At most ${API_DEFAULTS.maxScopes}, none of them the provider's own."
    scopes: [String!]
    "JWT when left out."
    tokenFormat: TokenFormat
    accessTokenSeconds: Int
    allowedClientIds: [ID!]
  }

  "An API's new settings. A field left out keeps its value; accessTokenSeconds null clears it."
  input ApiInput {
    name: String
    scopes: [String!]
    tokenFormat: TokenFormat
    accessTokenSeconds: Int
    allowedClientIds: [ID!]
  }

  extend type Query {
    "The bounds on an API's own access token lifetime."
    apiLifetimeBounds: ApiLifetimeBounds!
  }

  extend type Mutation {
    "Adds an API apps may ask for access tokens to."
    createApi(input: NewApiInput!): Api!
    "Changes an API. Its identifier stays."
    updateApi(identifier: ID!, input: ApiInput!): Api!
    "Removes an API. Tokens already issued to it work until they expire; no new ones are."
    deleteApi(identifier: ID!): Api!
  }
`;

/**
 * Records what the signed-in admin did to an API, and passes it on.
 *
 * @param ctx - Request context.
 * @param type - What they did.
 * @param api - The API, as it is after the change.
 * @returns The API.
 */
function auditedApi(ctx: Context, type: AuditType, api: Api): Api {
  recordAdminChange(ctx, type, apiTarget(api));
  return api;
}

/** Picks an API's row out by its identifier. */
const byIdentifier = (identifier: string) => ({ identifier: { eq: identifier } });

/** The resolvers for the APIs (resource servers), merged with the rest of the schema's. */
export const apiResolvers = {
  Query: {
    /**
     * Resolves `Query.apiLifetimeBounds`.
     *
     * @returns The shortest and longest lifetime an API's access tokens may be given.
     */
    apiLifetimeBounds: () => ({
      minSeconds: API_DEFAULTS.minAccessTokenSeconds,
      maxSeconds: API_DEFAULTS.maxAccessTokenSeconds,
    }),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createApi`.
     *
     * @param _parent - Unused.
     * @param args - The API to add.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The new API.
     */
    createApi: async (_parent: unknown, args: { input: NewApi }, ctx: Context, info: GraphQLResolveInfo) => {
      const api = auditedApi(ctx, AuditType.ApiCreated, await ctx.apis.create(args.input));
      return requiredRow(ctx, info, GeneratedTable.Apis, byIdentifier(api.identifier));
    },
    /**
     * Resolves `Mutation.updateApi`.
     *
     * @param _parent - Unused.
     * @param args - Its identifier and new settings.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The changed API.
     */
    updateApi: async (
      _parent: unknown,
      args: { identifier: string; input: ApiFields },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const api = auditedApi(ctx, AuditType.ApiUpdated, await ctx.apis.update(args.identifier, args.input));
      return requiredRow(ctx, info, GeneratedTable.Apis, byIdentifier(api.identifier));
    },
    /**
     * Resolves `Mutation.deleteApi`.
     *
     * @param _parent - Unused.
     * @param args - Its identifier.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The removed API, as it was.
     */
    deleteApi: async (_parent: unknown, args: { identifier: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.Apis, byIdentifier(args.identifier));
      auditedApi(ctx, AuditType.ApiDeleted, await ctx.apis.remove(args.identifier));
      return row;
    },
  },
};
