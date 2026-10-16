import type { GraphQLSchema } from 'graphql';
import { createSchema } from 'graphql-yoga';
import type { Context } from '../core/context.ts';
import { notFound } from '../core/errors.ts';
import { SCOPES } from '../oidc/provider.ts';
import { ClientAuthMethod, type ClientFields, type NewClient, type OidcClient } from '../store/clients.ts';
import type { NewUser, PublicUser, UserFields } from '../store/users.ts';
import { TYPE_DEFS } from './type-defs.ts';

/** Where discovery lives under the issuer. */
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/** What `Query.provider` returns. */
interface ProviderInfo {
  issuer: string;
  discoveryUrl: string;
  scopes: readonly string[];
}

/**
 * Loads a client by id.
 *
 * @param ctx - Request context.
 * @param clientId - The client's ID.
 * @returns The client.
 * @throws NOT_FOUND when there is none.
 */
function loadClient(ctx: Context, clientId: string): OidcClient {
  const client = ctx.clients.find(clientId);
  if (client === null) {
    throw notFound(`No client has the ID "${clientId}".`);
  }
  return client;
}

/**
 * Loads a user by id.
 *
 * @param ctx - Request context.
 * @param id - The user's id.
 * @returns The user.
 * @throws NOT_FOUND when there is none.
 */
function loadUser(ctx: Context, id: string): PublicUser {
  const user = ctx.users.find(id);
  if (user === null) {
    throw notFound(`No user has the ID "${id}".`);
  }
  return user;
}

const resolvers = {
  // The enum's GraphQL names, as the wire values the provider and the files use.
  ClientAuthMethod: {
    CLIENT_SECRET_BASIC: ClientAuthMethod.SecretBasic,
    CLIENT_SECRET_POST: ClientAuthMethod.SecretPost,
    NONE: ClientAuthMethod.None,
  },
  Query: {
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
    }),
    /**
     * Resolves `Query.clients`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every client.
     */
    clients: (_parent: unknown, _args: unknown, ctx: Context): OidcClient[] => ctx.clients.list(),
    /**
     * Resolves `Query.client`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @returns The client.
     */
    client: (_parent: unknown, args: { clientId: string }, ctx: Context): OidcClient => loadClient(ctx, args.clientId),
    /**
     * Resolves `Query.users`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every user.
     */
    users: (_parent: unknown, _args: unknown, ctx: Context): PublicUser[] => ctx.users.list(),
    /**
     * Resolves `Query.user`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The user.
     */
    user: (_parent: unknown, args: { id: string }, ctx: Context): PublicUser => loadUser(ctx, args.id),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createClient`.
     *
     * @param _parent - Unused.
     * @param args - The client to add.
     * @param ctx - Request context.
     * @returns The new client, with its secret.
     */
    createClient: (_parent: unknown, args: { input: NewClient }, ctx: Context): OidcClient =>
      ctx.clients.create(args.input),
    /**
     * Resolves `Mutation.updateClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID and its new settings.
     * @param ctx - Request context.
     * @returns The changed client.
     */
    updateClient: (_parent: unknown, args: { clientId: string; input: ClientFields }, ctx: Context): OidcClient =>
      ctx.clients.update(args.clientId, args.input),
    /**
     * Resolves `Mutation.rotateClientSecret`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @returns The client, with its new secret.
     */
    rotateClientSecret: (_parent: unknown, args: { clientId: string }, ctx: Context): OidcClient =>
      ctx.clients.rotateSecret(args.clientId),
    /**
     * Resolves `Mutation.deleteClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @returns The removed client.
     */
    deleteClient: (_parent: unknown, args: { clientId: string }, ctx: Context): OidcClient =>
      ctx.clients.remove(args.clientId),
    /**
     * Resolves `Mutation.createUser`.
     *
     * @param _parent - Unused.
     * @param args - The user to add.
     * @param ctx - Request context.
     * @returns The new user.
     */
    createUser: (_parent: unknown, args: { input: NewUser }, ctx: Context): PublicUser => ctx.users.create(args.input),
    /**
     * Resolves `Mutation.updateUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new details.
     * @param ctx - Request context.
     * @returns The changed user.
     */
    updateUser: (_parent: unknown, args: { id: string; input: UserFields }, ctx: Context): PublicUser =>
      ctx.users.update(args.id, args.input),
    /**
     * Resolves `Mutation.setUserPassword`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new password.
     * @param ctx - Request context.
     * @returns The user.
     */
    setUserPassword: (_parent: unknown, args: { id: string; password: string }, ctx: Context): PublicUser =>
      ctx.users.setPassword(args.id, args.password),
    /**
     * Resolves `Mutation.deleteUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The removed user.
     */
    deleteUser: (_parent: unknown, args: { id: string }, ctx: Context): PublicUser => ctx.users.remove(args.id),
  },
};

/** The schema this server serves at `/graphql`. */
export const schema: GraphQLSchema = createSchema<Context>({ typeDefs: TYPE_DEFS, resolvers });
