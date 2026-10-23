import type { GraphQLResolveInfo } from 'graphql';
import type { Context } from '../core/context.ts';
import { AuditType, recordAdminChange, upstreamTarget } from '../store/audit.ts';
import { withoutBlanks } from '../store/claims.ts';
import type { GroupMapping, UnknownIdentity, UpstreamFields, UpstreamKind } from '../store/upstreams.ts';
import { GeneratedTable, requiredRow, rowWhere } from './rows.ts';
import { loadUser, userById } from './users.ts';

/** The upstream providers part of the admin API: what a row can't hold, the redirect URI and every change. */
export const UPSTREAM_TYPE_DEFS = /* GraphQL */ `
  extend type Upstream {
    "Whether a client secret is saved. The secret itself never leaves the server."
    hasClientSecret: Boolean!
    "The redirect URI to register at the provider."
    redirectUri: String!
  }

  "An upstream group that gives a group here."
  input GroupMappingInput {
    upstream: String!
    local: String!
  }

  "An upstream provider's settings. Lists left out are empty."
  input UpstreamInput {
    name: String!
    kind: UpstreamKind!
    "Required for OIDC; ignored for GitHub."
    issuer: String
    clientId: String!
    "Left out, null or blank keeps the saved secret. Leave it out for a public client."
    clientSecret: String
    "Empty asks for openid, profile and email (OIDC) or read:user and user:email (GitHub)."
    scopes: [String!]
    unknownIdentity: UnknownIdentity
    createDomains: [String!]
    createGroups: [String!]
    countsAsBothFactors: Boolean
    groupsClaim: String
    groupMappings: [GroupMappingInput!]
  }

  extend type Query {
    "The redirect URI a provider with this id is given, to register before it is saved."
    upstreamRedirectUri(id: ID!): String!
  }

  extend type Mutation {
    "Adds a provider users may sign in through."
    createUpstream(id: ID!, input: UpstreamInput!): Upstream!
    "Changes an upstream provider. Its id stays."
    updateUpstream(id: ID!, input: UpstreamInput!): Upstream!
    "Removes an upstream provider and unlinks every identity linked through it."
    deleteUpstream(id: ID!): Upstream!
    "Unlinks a user's identity at an upstream provider."
    unlinkUserUpstream(id: ID!, providerId: ID!): User!
  }
`;

/** The part of a generated `Upstream` row the hand-written fields read. */
interface UpstreamRow {
  id: string;
}

/**
 * Picks an upstream provider's row out by id.
 *
 * @param id - The provider.
 * @returns The filter.
 */
const upstreamById = (id: string) => ({ id: { eq: id } });

/** What `UpstreamInput` arrives as: GraphQL sends null for a list or a flag left out. */
interface UpstreamInputArgs {
  name: string;
  kind: UpstreamKind;
  issuer?: string | null;
  clientId: string;
  clientSecret?: string | null;
  scopes?: string[] | null;
  unknownIdentity?: UnknownIdentity | null;
  createDomains?: string[] | null;
  createGroups?: string[] | null;
  countsAsBothFactors?: boolean | null;
  groupsClaim?: string | null;
  groupMappings?: GroupMapping[] | null;
}

/**
 * Reads an `UpstreamInput` as the store takes it: null lists and flags are left out, so they take their defaults.
 *
 * @param input - What GraphQL sent.
 * @returns The fields.
 */
function upstreamFieldsOf(input: UpstreamInputArgs): UpstreamFields {
  return withoutBlanks(input) as UpstreamFields;
}

/** The resolvers for the upstream providers, merged with the rest of the schema's. */
export const upstreamResolvers = {
  Upstream: {
    /**
     * Resolves `Upstream.hasClientSecret`.
     *
     * @param row - The provider's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Whether a secret is saved; the secret itself never leaves the server.
     */
    hasClientSecret: (row: UpstreamRow, _args: unknown, ctx: Context): boolean =>
      (ctx.upstreams.find(row.id)?.clientSecret ?? null) !== null,
    /**
     * Resolves `Upstream.redirectUri`.
     *
     * @param row - The provider's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The URI to register there.
     */
    redirectUri: (row: UpstreamRow, _args: unknown, ctx: Context): string => ctx.upstreamFlows.redirectUriOf(row.id),
  },
  Query: {
    /**
     * Resolves `Query.upstreamRedirectUri`.
     *
     * @param _parent - Unused.
     * @param args - The id the provider will have.
     * @param ctx - Request context.
     * @returns Its redirect URI.
     */
    upstreamRedirectUri: (_parent: unknown, args: { id: string }, ctx: Context): string =>
      ctx.upstreamFlows.redirectUriOf(args.id.trim()),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id and settings.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The provider.
     */
    createUpstream: async (
      _parent: unknown,
      args: { id: string; input: UpstreamInputArgs },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const upstream = await ctx.upstreams.create({ ...upstreamFieldsOf(args.input), id: args.id });
      recordAdminChange(ctx, AuditType.UpstreamCreated, upstreamTarget(upstream), { kind: upstream.kind });
      return requiredRow(ctx, info, GeneratedTable.Upstreams, upstreamById(upstream.id));
    },
    /**
     * Resolves `Mutation.updateUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id and settings.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The provider.
     */
    updateUpstream: async (
      _parent: unknown,
      args: { id: string; input: UpstreamInputArgs },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const isNewSecret = (args.input.clientSecret ?? '').trim() !== '';
      const upstream = await ctx.upstreams.update(args.id, upstreamFieldsOf(args.input));
      recordAdminChange(ctx, AuditType.UpstreamUpdated, upstreamTarget(upstream), {
        clientSecret: isNewSecret ? 'replaced' : 'kept',
      });
      return requiredRow(ctx, info, GeneratedTable.Upstreams, upstreamById(upstream.id));
    },
    /**
     * Resolves `Mutation.deleteUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The removed provider, as it was.
     */
    deleteUpstream: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.Upstreams, upstreamById(args.id));
      const { provider, unlinked } = await ctx.upstreams.remove(args.id);
      recordAdminChange(ctx, AuditType.UpstreamDeleted, upstreamTarget(provider), { unlinked: String(unlinked) });
      return row;
    },
    /**
     * Resolves `Mutation.unlinkUserUpstream`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and the provider's.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    unlinkUserUpstream: async (
      _parent: unknown,
      args: { id: string; providerId: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = loadUser(ctx, args.id);
      const link = await ctx.upstreams.unlink(user.id, args.providerId);
      const provider = ctx.upstreams.find(link.providerId) ?? { id: link.providerId, name: link.providerId };
      recordAdminChange(ctx, AuditType.UpstreamUnlinked, upstreamTarget(provider), {
        identity: link.label,
        user: user.username,
      });
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
  },
};
