import type { Context } from '../core/context.ts';
import { API_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import { type Api, type ApiFields, type NewApi, TOKEN_FORMAT_JWT, TOKEN_FORMAT_OPAQUE } from '../store/apis.ts';
import { type AuditTarget, AuditTargetKind, AuditType, actorOf } from '../store/audit.ts';
import type { OidcClient } from '../store/clients.ts';

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

/** The resolvers for the APIs (resource servers), merged with the rest of the schema's. */
export const apiResolvers = {
  TokenFormat: { JWT: TOKEN_FORMAT_JWT, OPAQUE: TOKEN_FORMAT_OPAQUE },
  Api: {
    /**
     * Resolves `Api.allowedClients`.
     *
     * @param api - The API.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The clients it lists that still exist.
     */
    allowedClients: (api: Api, _args: unknown, ctx: Context): OidcClient[] =>
      api.allowedClientIds.flatMap((clientId) => ctx.clients.find(clientId) ?? []),
  },
  Query: {
    /**
     * Resolves `Query.apis`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every API.
     */
    apis: (_parent: unknown, _args: unknown, ctx: Context): Api[] => ctx.apis.list(),
    /**
     * Resolves `Query.api`.
     *
     * @param _parent - Unused.
     * @param args - The API's identifier.
     * @param ctx - Request context.
     * @returns The API. Throws NOT_FOUND when there is none.
     */
    api: (_parent: unknown, args: { identifier: string }, ctx: Context): Api => {
      const api = ctx.apis.find(args.identifier);
      if (api === null) {
        throw notFound(`No API has the identifier "${args.identifier}".`);
      }
      return api;
    },
    /**
     * Resolves `Query.apiLifetimeBounds`.
     *
     * @returns The shortest and longest access token lifetime an API may set.
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
     * @returns The new API.
     */
    createApi: (_parent: unknown, args: { input: NewApi }, ctx: Context): Api =>
      auditedApi(ctx, AuditType.ApiCreated, ctx.apis.create(args.input)),
    /**
     * Resolves `Mutation.updateApi`.
     *
     * @param _parent - Unused.
     * @param args - Its identifier and new settings.
     * @param ctx - Request context.
     * @returns The changed API.
     */
    updateApi: (_parent: unknown, args: { identifier: string; input: ApiFields }, ctx: Context): Api =>
      auditedApi(ctx, AuditType.ApiUpdated, ctx.apis.update(args.identifier, args.input)),
    /**
     * Resolves `Mutation.deleteApi`.
     *
     * @param _parent - Unused.
     * @param args - Its identifier.
     * @param ctx - Request context.
     * @returns The removed API.
     */
    deleteApi: (_parent: unknown, args: { identifier: string }, ctx: Context): Api =>
      auditedApi(ctx, AuditType.ApiDeleted, ctx.apis.remove(args.identifier)),
  },
};
