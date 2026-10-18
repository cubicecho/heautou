import type { GraphQLSchema } from 'graphql';
import { createSchema, Repeater } from 'graphql-yoga';
import { adminUrls, type BrandingView, brandingView, sessionClientName, WEB_APP_PAGE } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { CLIENT_TOKEN_LIFETIME_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import { type StartedPairing, startPairing } from '../oidc/pairing.ts';
import { SCOPES } from '../oidc/provider.ts';
import type { SessionInfo } from '../oidc/sessions.ts';
import {
  AUDIT_TYPES,
  type AuditEntry,
  type AuditEvent,
  type AuditTarget,
  AuditTargetKind,
  AuditType,
  actorOf,
  KEYS_TARGET,
  matchesQuery,
  userTarget,
} from '../store/audit.ts';
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
import type { HttpRedirectSetting, PasswordRules } from '../store/settings.ts';
import {
  type GroupMapping,
  UnknownIdentity,
  type UpstreamFields,
  UpstreamKind,
  type UpstreamLink,
  type UpstreamProvider,
} from '../store/upstreams.ts';
import type { NewUser, PublicUser, UserFields } from '../store/users.ts';
import { upstreamTarget } from '../upstream/accounts.ts';
import { apiResolvers } from './apis.ts';
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

/** How much of a pairing's id names it in the audit log. */
const PAIRING_NAME_LENGTH = 8;

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
 * Records what the signed-in admin did, and passes the resolver's value on. Only changes that worked get here.
 *
 * @param ctx - Request context.
 * @param type - What they did.
 * @param target - What they did it to.
 * @param value - What the resolver returns.
 * @param [detail] - What else to keep. Never a password, token, secret or setup URL.
 * @returns The value.
 */
function audited<T>(ctx: Context, type: AuditType, target: AuditTarget, value: T, detail?: AuditEvent['detail']): T {
  ctx.audit.record({ type, actor: actorOf(ctx.viewer), ip: ctx.ip, target, detail });
  return value;
}

/**
 * Names a client as an entry's target.
 *
 * @param client - The client.
 * @returns The target.
 */
function clientTarget(client: OidcClient): AuditTarget {
  return { kind: AuditTargetKind.Client, id: client.clientId, name: client.name };
}

/**
 * Names a group as an entry's target. A group's name is its id.
 *
 * @param name - The group.
 * @returns The target.
 */
function groupTarget(name: string): AuditTarget {
  return { kind: AuditTargetKind.Group, id: name, name };
}

/**
 * Names a pairing as an entry's target.
 *
 * @param pairing - The pairing.
 * @returns The target.
 */
function pairingTarget(pairing: Pairing): AuditTarget {
  return {
    kind: AuditTargetKind.Pairing,
    id: pairing.id,
    name: `Setup URL ${pairing.id.slice(0, PAIRING_NAME_LENGTH)}`,
  };
}

/** The target of settings changes. */
const SETTINGS_TARGET: AuditTarget = Object.freeze({
  kind: AuditTargetKind.Settings,
  id: 'settings',
  name: 'Settings',
});
/** The target of branding changes. */
const BRANDING_TARGET: AuditTarget = Object.freeze({
  kind: AuditTargetKind.Branding,
  id: 'branding',
  name: 'Branding',
});

/**
 * Maps a vocabulary's GraphQL enum names, the values in capitals, to the values the files use.
 *
 * @param values - The vocabulary.
 * @returns The enum's resolver.
 */
function enumOf(values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map((value) => [value.toUpperCase(), value]));
}

/** What `AuditEntry` resolves from. */
interface AuditEntryView extends Omit<AuditEntry, 'detail'> {
  detail: { name: string; value: string }[];
}

/** What `AuditPage` resolves from. */
interface AuditPageView {
  entries: AuditEntryView[];
  nextCursor: string | null;
}

/**
 * Describes an entry for the admin UI: its detail as name and value pairs.
 *
 * @param entry - The stored entry.
 * @returns What `AuditEntry` resolves from.
 */
function auditEntryView(entry: AuditEntry): AuditEntryView {
  const { detail, ...rest } = entry;
  return { ...rest, detail: Object.entries(detail ?? {}).map(([name, value]) => ({ name, value })) };
}

/** The entries after which a pairing may read differently. */
const PAIRING_CHANGES: readonly AuditType[] = [AuditType.PairingCompleted, AuditType.PairingCancelled];

/**
 * Streams the entries recorded while a subscription is open.
 *
 * @param ctx - Request context.
 * @param args - The filters, as `Query.auditLog` takes them.
 * @returns The entries, each wrapped as the `auditEntryAdded` payload.
 */
function auditEntriesAdded(
  ctx: Context,
  args: { type?: AuditType | null; userId?: string | null },
): Repeater<{ auditEntryAdded: AuditEntryView }> {
  const query = { types: args.type === null || args.type === undefined ? null : [args.type], userId: args.userId };
  return new Repeater(async (push, stop) => {
    const off = ctx.audit.onRecord((entry) => {
      if (matchesQuery(entry, query)) {
        void push({ auditEntryAdded: auditEntryView(entry) });
      }
    });
    await stop;
    off();
  });
}

/**
 * Streams a pairing: as it is now, again when an app registers with it or it is cancelled, and null when it has
 * expired or gone, which ends the stream.
 *
 * @param ctx - Request context.
 * @param id - The pairing.
 * @returns The pairing views, each wrapped as the `pairingChanged` payload.
 */
function pairingChanges(ctx: Context, id: string): Repeater<{ pairingChanged: PairingView | null }> {
  return new Repeater(async (push, stop) => {
    /**
     * Sends the pairing as it is now, and ends the stream once it has stopped working.
     *
     * @returns Whether the stream goes on.
     */
    const send = (): boolean => {
      const pairing = ctx.pairings.find(id);
      void push({ pairingChanged: pairing === null ? null : pairingView(ctx, pairing) });
      if (pairing === null) {
        stop();
        return false;
      }
      return true;
    };
    if (send() === false) {
      return;
    }
    const expiry = ctx.pairings.find(id)?.expiresAt ?? Date.now();
    const timer = setTimeout(send, Math.max(expiry - Date.now(), 0) + 1);
    const off = ctx.audit.onRecord((entry) => {
      if (PAIRING_CHANGES.includes(entry.type)) {
        send();
      }
    });
    await stop;
    clearTimeout(timer);
    off();
  });
}

/**
 * Ends everything a user is signed in with: the provider's sessions and tokens and the web app's sessions.
 *
 * @param ctx - Request context.
 * @param userId - The user.
 * @returns Once the apps with a back-channel logout URI have been told.
 */
async function signOutEverywhere(ctx: Context, userId: string): Promise<void> {
  ctx.adminSessions.removeUser(userId);
  await ctx.sessions.revokeAccount(userId, ctx.ip);
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

/** What `UpstreamLink` resolves from. */
interface UpstreamLinkView extends Pick<UpstreamLink, 'providerId' | 'label' | 'linkedAt' | 'lastUsedAt'> {
  providerName: string;
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
  AuditType: enumOf(AUDIT_TYPES),
  UpstreamKind: enumOf(Object.values(UpstreamKind)),
  UnknownIdentity: enumOf(Object.values(UnknownIdentity)),
  Upstream: {
    /**
     * Resolves `Upstream.hasClientSecret`.
     *
     * @param upstream - The provider.
     * @returns Whether a secret is saved; the secret itself never leaves the server.
     */
    hasClientSecret: (upstream: UpstreamProvider): boolean => upstream.clientSecret !== null,
    /**
     * Resolves `Upstream.redirectUri`.
     *
     * @param upstream - The provider.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The URI to register there.
     */
    redirectUri: (upstream: UpstreamProvider, _args: unknown, ctx: Context): string =>
      ctx.upstreamFlows.redirectUriOf(upstream.id),
    /**
     * Resolves `Upstream.linkCount`.
     *
     * @param upstream - The provider.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns How many identities are linked through it.
     */
    linkCount: (upstream: UpstreamProvider, _args: unknown, ctx: Context): number =>
      ctx.upstreams.linkCount(upstream.id),
  },
  AuditTargetKind: enumOf(Object.values(AuditTargetKind)),
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
    /**
     * Resolves `User.secondFactors`.
     *
     * @param user - The user.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns What they have set up.
     */
    secondFactors: (user: PublicUser, _args: unknown, ctx: Context) => {
      const { hasTotp, recoveryCodesLeft, passkeys } = ctx.factors.summary(user.id);
      return { hasTotp, recoveryCodesLeft, passkeyCount: passkeys.length };
    },
    /**
     * Resolves `User.upstreamLinks`.
     *
     * @param user - The user.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Their linked identities, with the providers' names.
     */
    upstreamLinks: (user: PublicUser, _args: unknown, ctx: Context): UpstreamLinkView[] =>
      ctx.upstreams.linksOf(user.id).map(({ providerId, label, linkedAt, lastUsedAt }) => ({
        providerId,
        providerName: ctx.upstreams.find(providerId)?.name ?? providerId,
        label,
        linkedAt,
        lastUsedAt,
      })),
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
     * Resolves `Query.passwordRules`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The strength and breach rules.
     */
    passwordRules: (_parent: unknown, _args: unknown, ctx: Context): PasswordRules => ctx.settings.passwordRules(),
    /**
     * Resolves `Query.upstreams`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The upstream providers, oldest first.
     */
    upstreams: (_parent: unknown, _args: unknown, ctx: Context): UpstreamProvider[] => ctx.upstreams.list(),
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
    /**
     * Resolves `Query.auditLog`.
     *
     * @param _parent - Unused.
     * @param args - The page and the filters.
     * @param ctx - Request context.
     * @returns A page of entries, newest first.
     */
    auditLog: (
      _parent: unknown,
      args: { first?: number | null; after?: string | null; type?: AuditType | null; userId?: string | null },
      ctx: Context,
    ): AuditPageView => {
      const page = ctx.audit.list({
        first: args.first ?? undefined,
        after: args.after,
        types: args.type === null || args.type === undefined ? null : [args.type],
        userId: args.userId,
      });
      return { entries: page.entries.map(auditEntryView), nextCursor: page.nextCursor };
    },
  },
  Subscription: {
    auditEntryAdded: {
      /**
       * Opens `Subscription.auditEntryAdded`.
       *
       * @param _parent - Unused.
       * @param args - The filters.
       * @param ctx - Request context.
       * @returns The stream.
       */
      subscribe: (_parent: unknown, args: { type?: AuditType | null; userId?: string | null }, ctx: Context) =>
        auditEntriesAdded(ctx, args),
    },
    pairingChanged: {
      /**
       * Opens `Subscription.pairingChanged`.
       *
       * @param _parent - Unused.
       * @param args - The pairing.
       * @param ctx - Request context.
       * @returns The stream.
       */
      subscribe: (_parent: unknown, args: { id: string }, ctx: Context) => pairingChanges(ctx, args.id),
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
    createClient: (_parent: unknown, args: { input: NewClient }, ctx: Context): OidcClient => {
      const client = ctx.clients.create(args.input);
      return audited(ctx, AuditType.ClientCreated, clientTarget(client), refreshed(ctx, client));
    },
    /**
     * Resolves `Mutation.updateClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID and its new settings.
     * @param ctx - Request context.
     * @returns The changed client.
     */
    updateClient: (_parent: unknown, args: { clientId: string; input: ClientFields }, ctx: Context): OidcClient => {
      const client = ctx.clients.update(args.clientId, args.input);
      return audited(ctx, AuditType.ClientUpdated, clientTarget(client), refreshed(ctx, client));
    },
    /**
     * Resolves `Mutation.rotateClientSecret`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @returns The client, with its new secret.
     */
    rotateClientSecret: (_parent: unknown, args: { clientId: string }, ctx: Context): OidcClient => {
      const client = ctx.clients.rotateSecret(args.clientId);
      return audited(ctx, AuditType.ClientSecretRotated, clientTarget(client), client);
    },
    /**
     * Resolves `Mutation.deleteClient`.
     *
     * @param _parent - Unused.
     * @param args - The client's ID.
     * @param ctx - Request context.
     * @returns The removed client.
     */
    deleteClient: (_parent: unknown, args: { clientId: string }, ctx: Context): OidcClient => {
      const client = ctx.clients.remove(args.clientId);
      return audited(ctx, AuditType.ClientDeleted, clientTarget(client), refreshed(ctx, client));
    },
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
      const view = { pairing: pairingView(ctx, started), setupUrl: started.setupUrl };
      // The setup URL holds the token, so only who may sign in is kept.
      return audited(ctx, AuditType.PairingStarted, pairingTarget(started), view, {
        allowedGroups: started.allowedGroups.join(', '),
        groupsClaim: started.groupsClaim,
      });
    },
    /**
     * Resolves `Mutation.cancelPairing`.
     *
     * @param _parent - Unused.
     * @param args - The pairing's id.
     * @param ctx - Request context.
     * @returns Whether it was still there to cancel.
     */
    cancelPairing: (_parent: unknown, args: { id: string }, ctx: Context): boolean => {
      const pairing = ctx.pairings.find(args.id);
      const wasCancelled = ctx.pairings.cancel(args.id);
      return pairing === null || wasCancelled === false
        ? wasCancelled
        : audited(ctx, AuditType.PairingCancelled, pairingTarget(pairing), wasCancelled);
    },
    /**
     * Resolves `Mutation.createUser`.
     *
     * @param _parent - Unused.
     * @param args - The user to add.
     * @param ctx - Request context.
     * @returns The new user.
     */
    createUser: async (_parent: unknown, args: { input: NewUser }, ctx: Context): Promise<PublicUser> => {
      const { password, username, name, email } = args.input;
      const hasPassword = password !== undefined && password !== null && password !== '';
      if (hasPassword) {
        await ctx.passwordPolicy.check(password, { username, name, email });
      }
      const user = ctx.users.create(args.input);
      return audited(ctx, AuditType.UserCreated, userTarget(user), refreshed(ctx, user));
    },
    /**
     * Resolves `Mutation.updateUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new details.
     * @param ctx - Request context.
     * @returns The changed user.
     */
    updateUser: (_parent: unknown, args: { id: string; input: UserFields }, ctx: Context): PublicUser => {
      const user = ctx.users.update(args.id, args.input);
      return audited(ctx, AuditType.UserUpdated, userTarget(user), refreshed(ctx, user));
    },
    /**
     * Resolves `Mutation.setUserPassword`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new password.
     * @param ctx - Request context.
     * @returns The user.
     */
    setUserPassword: async (
      _parent: unknown,
      args: { id: string; password: string },
      ctx: Context,
    ): Promise<PublicUser> => {
      const owner = ctx.users.find(args.id);
      if (owner === null) {
        throw notFound(`No user has the ID "${args.id}".`);
      }
      await ctx.passwordPolicy.check(args.password, owner);
      const user = ctx.users.setPassword(args.id, args.password);
      ctx.passwordLinks.cancelFor(user.id);
      return audited(ctx, AuditType.UserPasswordSet, userTarget(user), user);
    },
    /**
     * Resolves `Mutation.deleteUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The removed user.
     */
    deleteUser: async (_parent: unknown, args: { id: string }, ctx: Context): Promise<PublicUser> => {
      const user = ctx.users.remove(args.id);
      await signOutEverywhere(ctx, user.id);
      ctx.passwordLinks.cancelFor(user.id);
      ctx.factors.removeAll(user.id);
      ctx.upstreams.removeUser(user.id);
      return audited(ctx, AuditType.UserDeleted, userTarget(user), refreshed(ctx, user));
    },
    /**
     * Resolves `Mutation.setUserDisabled`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and whether to disable them.
     * @param ctx - Request context.
     * @returns The user.
     */
    setUserDisabled: async (
      _parent: unknown,
      args: { id: string; disabled: boolean },
      ctx: Context,
    ): Promise<PublicUser> => {
      const user = ctx.users.setDisabled(args.id, args.disabled);
      if (user.disabled) {
        await signOutEverywhere(ctx, user.id);
      }
      return audited(ctx, user.disabled ? AuditType.UserDisabled : AuditType.UserEnabled, userTarget(user), user);
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
    endUserSession: async (
      _parent: unknown,
      args: { id: string; sessionId: string },
      ctx: Context,
    ): Promise<PublicUser> => {
      const user = loadUser(ctx, args.id);
      const isEnded = await ctx.sessions.endSession(user.id, args.sessionId, ctx.ip);
      if (isEnded === false) {
        throw notFound(`"${user.username}" has no session "${args.sessionId}".`);
      }
      return audited(ctx, AuditType.UserSessionEnded, userTarget(user), user, { sessionId: args.sessionId });
    },
    /**
     * Resolves `Mutation.signOutUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The user.
     */
    signOutUser: async (_parent: unknown, args: { id: string }, ctx: Context): Promise<PublicUser> => {
      const user = loadUser(ctx, args.id);
      await signOutEverywhere(ctx, user.id);
      return audited(ctx, AuditType.UserSignedOut, userTarget(user), user);
    },
    /**
     * Resolves `Mutation.resetSecondFactors`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The user.
     */
    resetSecondFactors: (_parent: unknown, args: { id: string }, ctx: Context): PublicUser => {
      const user = loadUser(ctx, args.id);
      ctx.factors.removeAll(user.id);
      return audited(ctx, AuditType.UserSecondFactorsReset, userTarget(user), user);
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
      // The URL holds the token, so only that a link was made is kept.
      return audited(ctx, AuditType.PasswordLinkCreated, userTarget(user), {
        url,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },
    /**
     * Resolves `Mutation.renameGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group and its new name.
     * @param ctx - Request context.
     * @returns The renamed group.
     */
    renameGroup: (_parent: unknown, args: { name: string; newName: string }, ctx: Context): GroupView => {
      const group = groupView(ctx, renameGroup(ctx, args.name, args.newName));
      return audited(ctx, AuditType.GroupRenamed, groupTarget(group.name), group, { from: args.name });
    },
    /**
     * Resolves `Mutation.deleteGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group.
     * @param ctx - Request context.
     * @returns How many users were in it.
     */
    deleteGroup: (_parent: unknown, args: { name: string }, ctx: Context): number => {
      const members = deleteGroup(ctx, args.name);
      return audited(ctx, AuditType.GroupDeleted, groupTarget(args.name), members, { members: String(members) });
    },
    /**
     * Resolves `Mutation.rotateKeys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The keys after the rotation.
     */
    rotateKeys: (_parent: unknown, _args: unknown, ctx: Context): KeysView => {
      const keys = refreshed(ctx, keysView(ctx.keys.rotate()));
      return audited(ctx, AuditType.KeysRotated, KEYS_TARGET, keys, { kid: keys.signingKeys[0]?.kid ?? '' });
    },
    /**
     * Resolves `Mutation.setBrandingName`.
     *
     * @param _parent - Unused.
     * @param args - The name.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingName: (_parent: unknown, args: { name: string }, ctx: Context): BrandingView => {
      const branding = ctx.branding.setName(args.name);
      return audited(ctx, AuditType.BrandingNameSet, BRANDING_TARGET, brandingView(branding), { name: branding.name });
    },
    /**
     * Resolves `Mutation.setBrandingLogo`.
     *
     * @param _parent - Unused.
     * @param args - The image as a data URL, or null.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingLogo: (_parent: unknown, args: { dataUrl?: string | null }, ctx: Context): BrandingView => {
      const branding = ctx.branding.setLogo(args.dataUrl ?? null);
      return audited(ctx, AuditType.BrandingLogoSet, BRANDING_TARGET, brandingView(branding), {
        logo: branding.logo === null ? 'removed' : 'set',
      });
    },
    /**
     * Resolves `Mutation.setHttpRedirects`.
     *
     * @param _parent - Unused.
     * @param args - Whether to allow them, or null to follow the issuer.
     * @param ctx - Request context.
     * @returns The setting.
     */
    setHttpRedirects: (_parent: unknown, args: { allowed?: boolean | null }, ctx: Context): HttpRedirectSetting => {
      const setting = ctx.settings.setHttpRedirects(args.allowed ?? null);
      return audited(ctx, AuditType.HttpRedirectsSet, SETTINGS_TARGET, setting, {
        httpRedirects: setting.isAllowed ? 'allowed' : 'refused',
        chosenBy: setting.isSet ? 'operator' : 'issuer',
      });
    },
    /**
     * Resolves `Mutation.setPasswordRules`.
     *
     * @param _parent - Unused.
     * @param args - The rules to change; null or left out keeps one.
     * @param ctx - Request context.
     * @returns The rules.
     */
    setPasswordRules: (
      _parent: unknown,
      args: { minScore?: number | null; checkBreaches?: boolean | null },
      ctx: Context,
    ): PasswordRules => {
      const rules = ctx.settings.setPasswordRules({
        ...(args.minScore === undefined || args.minScore === null ? {} : { minScore: args.minScore }),
        ...(args.checkBreaches === undefined || args.checkBreaches === null
          ? {}
          : { checkBreaches: args.checkBreaches }),
      });
      return audited(ctx, AuditType.PasswordRulesSet, SETTINGS_TARGET, rules, {
        minScore: String(rules.minScore),
        breachCheck: rules.checkBreaches ? 'on' : 'off',
      });
    },
    /**
     * Resolves `Mutation.createUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id and settings.
     * @param ctx - Request context.
     * @returns The provider.
     */
    createUpstream: (
      _parent: unknown,
      args: { id: string; input: UpstreamInputArgs },
      ctx: Context,
    ): UpstreamProvider => {
      const upstream = ctx.upstreams.create({ ...upstreamFieldsOf(args.input), id: args.id });
      return audited(ctx, AuditType.UpstreamCreated, upstreamTarget(upstream), upstream, { kind: upstream.kind });
    },
    /**
     * Resolves `Mutation.updateUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id and settings.
     * @param ctx - Request context.
     * @returns The provider.
     */
    updateUpstream: (
      _parent: unknown,
      args: { id: string; input: UpstreamInputArgs },
      ctx: Context,
    ): UpstreamProvider => {
      const isNewSecret = (args.input.clientSecret ?? '').trim() !== '';
      const upstream = ctx.upstreams.update(args.id, upstreamFieldsOf(args.input));
      return audited(ctx, AuditType.UpstreamUpdated, upstreamTarget(upstream), upstream, {
        clientSecret: isNewSecret ? 'replaced' : 'kept',
      });
    },
    /**
     * Resolves `Mutation.deleteUpstream`.
     *
     * @param _parent - Unused.
     * @param args - Its id.
     * @param ctx - Request context.
     * @returns The removed provider.
     */
    deleteUpstream: (_parent: unknown, args: { id: string }, ctx: Context): UpstreamProvider => {
      const { provider, unlinked } = ctx.upstreams.remove(args.id);
      return audited(ctx, AuditType.UpstreamDeleted, upstreamTarget(provider), provider, {
        unlinked: String(unlinked),
      });
    },
    /**
     * Resolves `Mutation.unlinkUserUpstream`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and the provider's.
     * @param ctx - Request context.
     * @returns The user.
     */
    unlinkUserUpstream: (_parent: unknown, args: { id: string; providerId: string }, ctx: Context): PublicUser => {
      const user = loadUser(ctx, args.id);
      const link = ctx.upstreams.unlink(user.id, args.providerId);
      const provider = ctx.upstreams.find(link.providerId) ?? { id: link.providerId, name: link.providerId };
      return audited(ctx, AuditType.UpstreamUnlinked, upstreamTarget(provider), user, {
        identity: link.label,
        user: user.username,
      });
    },
  },
};

/** The schema this server serves at `/graphql`. */
export const schema: GraphQLSchema = createSchema<Context>({
  typeDefs: TYPE_DEFS,
  resolvers: [resolvers, apiResolvers],
});
