import type { GraphQLResolveInfo } from 'graphql';
import type { Context } from '../core/context.ts';
import { API_DEFAULTS } from '../core/defaults.ts';
import type { Api, ApiFields, NewApi } from '../store/apis.ts';
import { type AuditTarget, AuditTargetKind, AuditType, actorOf } from '../store/audit.ts';
import { GeneratedTable, requiredRow, rowWhere } from './rows.ts';

/**
 * Names an API as an entry's target.
 *
 * @param api - The API.
 * @returns The target.
 */
function apiTarget(api: Api): AuditTarget {
  return { kind: AuditTargetKind.Api, id: api.identifier, name: api.name };
}

/**
 * Records what the signed-in admin did to an API, and passes it on.
 *
 * @param ctx - Request context.
 * @param type - What they did.
 * @param api - The API, as it is after the change.
 * @returns The API.
 */
function auditedApi(ctx: Context, type: AuditType, api: Api): Api {
  ctx.audit.record({ type, actor: actorOf(ctx.viewer), ip: ctx.ip, target: apiTarget(api) });
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
