import type { GraphQLSchema } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { adminUrls, type BrandingView, brandingView, sessionClientName, WEB_APP_PAGE } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { notFound } from '../core/errors.ts';
import { type StartedPairing, startPairing } from '../oidc/pairing.ts';
import { SCOPES } from '../oidc/provider.ts';
import type { SessionInfo } from '../oidc/sessions.ts';
import { type ClaimEntry, claimEntries, withoutBlanks } from '../store/claims.ts';
import {
  CLIENT_SOURCE_ADMIN,
  CLIENT_SOURCE_PAIRED,
  ClientAuthMethod,
  type ClientFields,
  type NewClient,
  type OidcClient,
} from '../store/clients.ts';
import { deleteGroup, type Group, listGroups, renameGroup } from '../store/groups.ts';
import type { ProviderKeys } from '../store/keys.ts';
import type { Pairing, PairingInput } from '../store/pairings.ts';
import { refusedRedirectUris } from '../store/redirect-uris.ts';
import type { HttpRedirectSetting } from '../store/settings.ts';
import type { NewUser, PublicUser, UserFields } from '../store/users.ts';
import { TYPE_DEFS } from './type-defs.ts';

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

/** What `Session` resolves from. */
interface SessionView extends Omit<SessionInfo, 'clientIds'> {
  clientNames: string[];
}

/** What `Keys` resolves from. */
interface KeysView {
  rotatedAt: string | null;
  signingKeys: { kid: string; isCurrent: boolean }[];
}

/** What `Group` resolves from. */
interface GroupView {
  name: string;
  members: PublicUser[];
  clients: OidcClient[];
  isProtected: boolean;
}

/** Where a pairing is, as `PairingStatus` names it. */
const PAIRING_WAITING = 'WAITING' as const;
const PAIRING_PAIRED = 'PAIRED' as const;

/** What `Pairing` resolves from. */
interface PairingView {
  id: string;
  status: typeof PAIRING_WAITING | typeof PAIRING_PAIRED;
  expiresAt: string;
  allowedGroups: string[];
  groupsClaim: string;
  client: OidcClient | null;
}

/**
 * Describes a pairing for the admin UI.
 *
 * @param ctx - Request context.
 * @param pairing - The stored pairing.
 * @returns What `Pairing` resolves from.
 */
function pairingView(ctx: Context, pairing: Pairing): PairingView {
  const { id, allowedGroups, groupsClaim, clientId } = pairing;
  return {
    id,
    status: clientId === null ? PAIRING_WAITING : PAIRING_PAIRED,
    expiresAt: new Date(pairing.expiresAt).toISOString(),
    allowedGroups,
    groupsClaim,
    client: clientId === null ? null : ctx.clients.find(clientId),
  };
}

/**
 * Builds the provider again when a change touched its claim names or keys.
 *
 * @param ctx - Request context.
 * @param value - What the resolver returns.
 * @returns The value.
 */
function refreshed<T>(ctx: Context, value: T): T {
  ctx.host.refresh();
  return value;
}

/**
 * Ends everything a user is signed in with: the provider's sessions and tokens and the web app's sessions.
 *
 * @param ctx - Request context.
 * @param userId - The user.
 */
function signOutEverywhere(ctx: Context, userId: string): void {
  ctx.sessions.revokeAccount(userId);
  ctx.adminSessions.removeUser(userId);
}

/**
 * Describes the keys without their private parts.
 *
 * @param keys - The provider's keys.
 * @returns The key ids, newest first, and when they were made.
 */
function keysView(keys: ProviderKeys): KeysView {
  return {
    rotatedAt: keys.rotatedAt ?? null,
    signingKeys: keys.jwks.map((jwk, index) => ({ kid: String(jwk.kid), isCurrent: index === 0 })),
  };
}

/**
 * Fills a group in with its users and clients.
 *
 * @param ctx - Request context.
 * @param group - The group.
 * @returns What `Group` resolves from.
 */
function groupView(ctx: Context, group: Group): GroupView {
  return {
    name: group.name,
    members: group.memberIds.flatMap((id) => ctx.users.find(id) ?? []),
    clients: group.clientIds.flatMap((clientId) => ctx.clients.find(clientId) ?? []),
    isProtected: group.isProtected,
  };
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
  ClientSource: {
    ADMIN: CLIENT_SOURCE_ADMIN,
    PAIRED: CLIENT_SOURCE_PAIRED,
  },
  Client: {
    /**
     * Resolves `Client.refusedRedirectUris`.
     *
     * @param client - The client.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Its URIs the redirect rule refuses now, for a client saved before the rule or the setting changed.
     */
    refusedRedirectUris: (client: OidcClient, _args: unknown, ctx: Context): string[] =>
      refusedRedirectUris(client, {
        allowsHttp: ctx.settings.httpRedirects().isAllowed,
        isPublic: client.authMethod === ClientAuthMethod.None,
      }),
  },
  User: {
    /**
     * Resolves `User.claims`.
     *
     * @param user - The user.
     * @returns Their custom claims, by name.
     */
    claims: (user: PublicUser): ClaimEntry[] => claimEntries(user.claims),
    /**
     * Resolves `User.sessions`.
     *
     * @param user - The user.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Their provider sessions, with client names.
     */
    sessions: (user: PublicUser, _args: unknown, ctx: Context): SessionView[] =>
      ctx.sessions.sessionsOf(user.id).map(({ clientIds, ...session }) => ({
        ...session,
        clientNames: clientIds.map((clientId) => sessionClientName(clientId, ctx.clients, ctx.branding.read())),
      })),
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
      introspectionUrl: `${ctx.issuer}${INTROSPECTION_PATH}`,
    }),
    /**
     * Resolves `Query.viewer`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The signed-in admin.
     */
    viewer: (_parent: unknown, _args: unknown, ctx: Context): PublicUser => ctx.viewer,
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
    /**
     * Resolves `Query.groups`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every group.
     */
    groups: (_parent: unknown, _args: unknown, ctx: Context): GroupView[] =>
      listGroups(ctx).map((group) => groupView(ctx, group)),
    /**
     * Resolves `Query.keys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The key ids and when they were made.
     */
    keys: (_parent: unknown, _args: unknown, ctx: Context): KeysView => keysView(ctx.keys.current()),
    /**
     * Resolves `Query.branding`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The name and logo URL.
     */
    branding: (_parent: unknown, _args: unknown, ctx: Context): BrandingView => brandingView(ctx.branding.read()),
    /**
     * Resolves `Query.httpRedirects`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Whether plain http redirect URIs are allowed, and why.
     */
    httpRedirects: (_parent: unknown, _args: unknown, ctx: Context): HttpRedirectSetting =>
      ctx.settings.httpRedirects(),
    /**
     * Resolves `Query.pairing`.
     *
     * @param _parent - Unused.
     * @param args - The pairing's id.
     * @param ctx - Request context.
     * @returns The pairing, or null once it has expired or been cancelled.
     */
    pairing: (_parent: unknown, args: { id: string }, ctx: Context): PairingView | null => {
      const pairing = ctx.pairings.find(args.id);
      return pairing === null ? null : pairingView(ctx, pairing);
    },
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
      refreshed(ctx, ctx.clients.create(args.input)),
    /**
     * Resolves `Mutation.updateClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID and its new settings.
     * @param ctx - Request context.
     * @returns The changed client.
     */
    updateClient: (_parent: unknown, args: { clientId: string; input: ClientFields }, ctx: Context): OidcClient =>
      refreshed(ctx, ctx.clients.update(args.clientId, args.input)),
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
      refreshed(ctx, ctx.clients.remove(args.clientId)),
    /**
     * Resolves `Mutation.startPairing`.
     *
     * @param _parent - Unused.
     * @param args - What the paired client gets.
     * @param ctx - Request context.
     * @returns The pairing and its setup URL.
     */
    startPairing: async (
      _parent: unknown,
      args: { input: PairingInput },
      ctx: Context,
    ): Promise<{ pairing: PairingView; setupUrl: string }> => {
      const started: StartedPairing = await startPairing(
        ctx.host.current(),
        ctx.pairings,
        withoutBlanks(args.input),
        ctx.branding.read().name,
      );
      return { pairing: pairingView(ctx, started), setupUrl: started.setupUrl };
    },
    /**
     * Resolves `Mutation.cancelPairing`.
     *
     * @param _parent - Unused.
     * @param args - The pairing's id.
     * @param ctx - Request context.
     * @returns Whether it was still there to cancel.
     */
    cancelPairing: (_parent: unknown, args: { id: string }, ctx: Context): boolean => ctx.pairings.cancel(args.id),
    /**
     * Resolves `Mutation.createUser`.
     *
     * @param _parent - Unused.
     * @param args - The user to add.
     * @param ctx - Request context.
     * @returns The new user.
     */
    createUser: (_parent: unknown, args: { input: NewUser }, ctx: Context): PublicUser =>
      refreshed(ctx, ctx.users.create(args.input)),
    /**
     * Resolves `Mutation.updateUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new details.
     * @param ctx - Request context.
     * @returns The changed user.
     */
    updateUser: (_parent: unknown, args: { id: string; input: UserFields }, ctx: Context): PublicUser =>
      refreshed(ctx, ctx.users.update(args.id, args.input)),
    /**
     * Resolves `Mutation.setUserPassword`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new password.
     * @param ctx - Request context.
     * @returns The user.
     */
    setUserPassword: (_parent: unknown, args: { id: string; password: string }, ctx: Context): PublicUser => {
      const user = ctx.users.setPassword(args.id, args.password);
      ctx.passwordLinks.cancelFor(user.id);
      return user;
    },
    /**
     * Resolves `Mutation.deleteUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The removed user.
     */
    deleteUser: (_parent: unknown, args: { id: string }, ctx: Context): PublicUser => {
      const user = ctx.users.remove(args.id);
      signOutEverywhere(ctx, user.id);
      ctx.passwordLinks.cancelFor(user.id);
      return refreshed(ctx, user);
    },
    /**
     * Resolves `Mutation.setUserDisabled`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and whether to disable them.
     * @param ctx - Request context.
     * @returns The user.
     */
    setUserDisabled: (_parent: unknown, args: { id: string; disabled: boolean }, ctx: Context): PublicUser => {
      const user = ctx.users.setDisabled(args.id, args.disabled);
      if (user.disabled) {
        signOutEverywhere(ctx, user.id);
      }
      return user;
    },
    /**
     * Resolves `Mutation.endUserSession`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and the session's.
     * @param ctx - Request context.
     * @returns The user.
     * @throws NOT_FOUND when the user has no such session.
     */
    endUserSession: (_parent: unknown, args: { id: string; sessionId: string }, ctx: Context): PublicUser => {
      const user = loadUser(ctx, args.id);
      if (ctx.sessions.endSession(user.id, args.sessionId) === false) {
        throw notFound(`"${user.username}" has no session "${args.sessionId}".`);
      }
      return user;
    },
    /**
     * Resolves `Mutation.signOutUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The user.
     */
    signOutUser: (_parent: unknown, args: { id: string }, ctx: Context): PublicUser => {
      const user = loadUser(ctx, args.id);
      signOutEverywhere(ctx, user.id);
      return user;
    },
    /**
     * Resolves `Mutation.createPasswordLink`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The link and when it expires.
     */
    createPasswordLink: (_parent: unknown, args: { id: string }, ctx: Context): { url: string; expiresAt: string } => {
      const user = loadUser(ctx, args.id);
      const { token, expiresAt } = ctx.passwordLinks.issue(user.id);
      const url = `${adminUrls(ctx.issuer).base}${WEB_APP_PAGE.setPassword}#token=${token}`;
      return { url, expiresAt: new Date(expiresAt).toISOString() };
    },
    /**
     * Resolves `Mutation.renameGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group and its new name.
     * @param ctx - Request context.
     * @returns The renamed group.
     */
    renameGroup: (_parent: unknown, args: { name: string; newName: string }, ctx: Context): GroupView =>
      groupView(ctx, renameGroup(ctx, args.name, args.newName)),
    /**
     * Resolves `Mutation.deleteGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group.
     * @param ctx - Request context.
     * @returns How many users were in it.
     */
    deleteGroup: (_parent: unknown, args: { name: string }, ctx: Context): number => deleteGroup(ctx, args.name),
    /**
     * Resolves `Mutation.rotateKeys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The keys after the rotation.
     */
    rotateKeys: (_parent: unknown, _args: unknown, ctx: Context): KeysView =>
      refreshed(ctx, keysView(ctx.keys.rotate())),
    /**
     * Resolves `Mutation.setBrandingName`.
     *
     * @param _parent - Unused.
     * @param args - The name.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingName: (_parent: unknown, args: { name: string }, ctx: Context): BrandingView =>
      brandingView(ctx.branding.setName(args.name)),
    /**
     * Resolves `Mutation.setBrandingLogo`.
     *
     * @param _parent - Unused.
     * @param args - The image as a data URL, or null.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingLogo: (_parent: unknown, args: { dataUrl?: string | null }, ctx: Context): BrandingView =>
      brandingView(ctx.branding.setLogo(args.dataUrl ?? null)),
    /**
     * Resolves `Mutation.setHttpRedirects`.
     *
     * @param _parent - Unused.
     * @param args - Whether to allow them, or null to follow the issuer.
     * @param ctx - Request context.
     * @returns The setting.
     */
    setHttpRedirects: (_parent: unknown, args: { allowed?: boolean | null }, ctx: Context): HttpRedirectSetting =>
      ctx.settings.setHttpRedirects(args.allowed ?? null),
  },
};

/** The schema this server serves at `/graphql`. */
export const schema: GraphQLSchema = createSchema<Context>({ typeDefs: TYPE_DEFS, resolvers });
