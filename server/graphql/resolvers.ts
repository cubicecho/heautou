// The hand-written fields of the admin API (`type-defs.ts`): what the generated reads can't give, and every change.
// A field whose type is a generated one (User, Client, Api, Upstream, AuditEntry) answers with the row drizzle-graphql
// reads for it (`rows.ts`), after the store has saved, so the result carries whatever the request selected.
import type { GraphQLResolveInfo } from 'graphql';
import { Repeater } from 'graphql-yoga';
import { adminUrls, type BrandingView, brandingView, sessionClientName, WEB_APP_PAGE } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { CLIENT_TOKEN_LIFETIME_DEFAULTS, PROFILE_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { type StartedPairing, startPairing } from '../oidc/pairing.ts';
import type { OfferedApi } from '../oidc/pairing-offers.ts';
import { SCOPES } from '../oidc/provider.ts';
import type { SessionInfo } from '../oidc/sessions.ts';
import { TOKEN_FORMAT_JWT } from '../store/apis.ts';
import {
  type AuditEntry,
  type AuditTarget,
  AuditTargetKind,
  AuditType,
  KEYS_TARGET,
  matchesQuery,
  recordAdminChange,
  userTarget,
} from '../store/audit.ts';
import { withoutBlanks } from '../store/claims.ts';
import {
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
import type { GroupMapping, UnknownIdentity, UpstreamFields, UpstreamKind } from '../store/upstreams.ts';
import type { NewUser, PublicUser, UserFields } from '../store/users.ts';
import { upstreamTarget } from '../upstream/accounts.ts';
import { type GeneratedRow, GeneratedTable, requiredRow, rowsWhere, rowWhere } from './rows.ts';

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
  finished: boolean;
  /** The stored pairing, for `client` and `offers`. */
  pairing: Pairing;
}

/** What `PairingOffers` resolves from. */
interface PairingOffersView {
  deviceClient: OidcClient | null;
  api: OfferedApi | null;
}

/** What `ClientApp` resolves from. */
interface ClientApp {
  id: string;
  uri: string | null;
}

/** The part of a generated `User` row the hand-written fields read. */
interface UserRow {
  id: string;
}

/** The part of a generated `Client` row the hand-written fields read. */
interface ClientRow {
  clientId: string;
}

/** The part of a generated `Upstream` row the hand-written fields read. */
interface UpstreamRow {
  id: string;
}

/** What the operator chose to set up for a paired app. */
interface FinishPairingInput {
  deviceFlow: boolean;
  api: boolean;
}

/**
 * Picks a user's row out by id.
 *
 * @param id - The user.
 * @returns The filter.
 */
const userById = (id: string) => ({ id: { eq: id } });

/**
 * Picks a client's row out by its client ID.
 *
 * @param clientId - The client.
 * @returns The filter.
 */
const clientById = (clientId: string) => ({ clientId: { eq: clientId } });

/**
 * Picks an upstream provider's row out by id.
 *
 * @param id - The provider.
 * @returns The filter.
 */
const upstreamById = (id: string) => ({ id: { eq: id } });

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
 * Describes a pairing for the admin UI.
 *
 * @param pairing - The stored pairing.
 * @returns What `Pairing` resolves from.
 */
function pairingView(pairing: Pairing): PairingView {
  const { id, allowedGroups, groupsClaim, clientId } = pairing;
  return {
    id,
    status: clientId === null ? PAIRING_WAITING : PAIRING_PAIRED,
    expiresAt: new Date(pairing.expiresAt).toISOString(),
    allowedGroups,
    groupsClaim,
    finished: pairing.isFinished,
    pairing,
  };
}

/**
 * Reads the device client a pairing's app registered, while it waits for its device flow.
 *
 * @param ctx - Request context.
 * @param pairing - The pairing.
 * @returns The client, or null when there is none or it is gone.
 */
function waitingDeviceClientOf(ctx: Context, pairing: Pairing): OidcClient | null {
  const client = pairing.deviceClientId === null ? null : ctx.clients.find(pairing.deviceClientId);
  return client === null || client.allowDeviceFlow ? null : client;
}

/**
 * Looks up the API a pairing's app describes.
 *
 * @param ctx - Request context.
 * @param pairing - The pairing.
 * @returns The API, or null.
 */
async function offeredApiOf(ctx: Context, pairing: Pairing): Promise<OfferedApi | null> {
  const client = pairing.clientId === null ? null : ctx.clients.find(pairing.clientId);
  return client === null ? null : ctx.pairingOffers.apiFor(pairing.id, pairing.clientUri, client.redirectUris);
}

/**
 * Sets up what a paired app offers, as the operator chose: turns its device client's device flow on or removes the
 * device client, and adds its API or allows its clients on the one there already.
 *
 * @param ctx - Request context.
 * @param pairing - The pairing, paired and not finished.
 * @param input - What the operator chose.
 * @returns What was done, for the audit entry.
 */
async function setUpOffers(ctx: Context, pairing: Pairing, input: FinishPairingInput): Promise<Record<string, string>> {
  const done: Record<string, string> = {};
  const appClientIds = pairing.clientId === null ? [] : [pairing.clientId];
  const deviceClient = waitingDeviceClientOf(ctx, pairing);
  if (deviceClient !== null && input.deviceFlow) {
    const { name, authMethod, redirectUris, postLogoutRedirectUris } = deviceClient;
    await ctx.clients.update(deviceClient.clientId, {
      name,
      authMethod,
      redirectUris,
      postLogoutRedirectUris,
      allowDeviceFlow: true,
    });
    appClientIds.push(deviceClient.clientId);
    done.deviceFlow = 'on';
  } else if (deviceClient !== null && deviceClient.clientId !== pairing.clientId) {
    await ctx.clients.remove(deviceClient.clientId);
    done.deviceFlow = 'removed';
  }
  const offered = input.api ? await offeredApiOf(ctx, pairing) : null;
  if (offered !== null) {
    const existing = ctx.apis.find(offered.identifier);
    const allowedClientIds = [...new Set([...(existing?.allowedClientIds ?? []), ...appClientIds])];
    const api =
      existing === null
        ? await ctx.apis.create({ ...offered, tokenFormat: TOKEN_FORMAT_JWT, allowedClientIds })
        : await ctx.apis.update(offered.identifier, { allowedClientIds });
    const type = existing === null ? AuditType.ApiCreated : AuditType.ApiUpdated;
    recordAdminChange(ctx, type, { kind: AuditTargetKind.Api, id: api.identifier, name: api.name });
    done.api = api.identifier;
  }
  return done;
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

/** The entries after which a pairing may read differently. */
const PAIRING_CHANGES: readonly AuditType[] = [
  AuditType.PairingCompleted,
  AuditType.PairingCancelled,
  AuditType.PairingFinished,
];

/**
 * Streams the entries recorded while a subscription is open.
 *
 * @param ctx - Request context.
 * @param args - The filters.
 * @returns The entries, each wrapped as the `auditEntryAdded` payload.
 */
function auditEntriesAdded(
  ctx: Context,
  args: { type?: AuditType | null; userId?: string | null },
): Repeater<{ auditEntryAdded: AuditEntry }> {
  const query = { types: args.type === null || args.type === undefined ? null : [args.type], userId: args.userId };
  return new Repeater(async (push, stop) => {
    const off = ctx.audit.onRecord((entry) => {
      if (matchesQuery(entry, query)) {
        void push({ auditEntryAdded: entry });
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
      void push({ pairingChanged: pairing === null ? null : pairingView(pairing) });
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
  await ctx.adminSessions.removeUser(userId);
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

/** The hand-written resolvers, merged with the generated schema in `build-schema.ts`. */
export const resolvers = {
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
  Pairing: {
    /**
     * Resolves `Pairing.client`.
     *
     * @param view - The pairing.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The client the app registered as, or null while it waits.
     */
    client: (view: PairingView, _args: unknown, ctx: Context, info: GraphQLResolveInfo) => {
      const { clientId } = view.pairing;
      return clientId === null ? null : rowWhere(ctx, info, GeneratedTable.Clients, clientById(clientId));
    },
    /**
     * Resolves `Pairing.offers`.
     *
     * @param view - The pairing.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns What its app offers, or null while it waits or once it is finished.
     */
    offers: async (view: PairingView, _args: unknown, ctx: Context): Promise<PairingOffersView | null> => {
      if (view.status === PAIRING_WAITING || view.finished) {
        return null;
      }
      return { deviceClient: waitingDeviceClientOf(ctx, view.pairing), api: await offeredApiOf(ctx, view.pairing) };
    },
  },
  PairingOffers: {
    /**
     * Resolves `PairingOffers.deviceClient`.
     *
     * @param offers - What the app offers.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The device client waiting for its device flow, or null.
     */
    deviceClient: (offers: PairingOffersView, _args: unknown, ctx: Context, info: GraphQLResolveInfo) =>
      offers.deviceClient === null
        ? null
        : rowWhere(ctx, info, GeneratedTable.Clients, clientById(offers.deviceClient.clientId)),
  },
  OfferedApi: {
    /**
     * Resolves `OfferedApi.existing`.
     *
     * @param api - The offered API.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The API with its identifier, or null.
     */
    existing: (api: OfferedApi, _args: unknown, ctx: Context, info: GraphQLResolveInfo) =>
      rowWhere(ctx, info, GeneratedTable.Apis, { identifier: { eq: api.identifier } }),
  },
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
  User: {
    /**
     * Resolves `User.hasPassword`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns False for an invited user who has not set one.
     */
    hasPassword: (row: UserRow, _args: unknown, ctx: Context): boolean => ctx.users.find(row.id)?.hasPassword ?? false,
    /**
     * Resolves `User.pictureUrl`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The URL the picture claim holds, or null.
     */
    pictureUrl: (row: UserRow, _args: unknown, ctx: Context): string | null => {
      const user = ctx.users.find(row.id);
      return user === null ? null : ctx.pictures.urlOf(user);
    },
    /**
     * Resolves `User.sessions`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Their provider sessions, with client names.
     */
    sessions: (row: UserRow, _args: unknown, ctx: Context): SessionView[] =>
      ctx.sessions.sessionsOf(row.id).map(({ clientIds, ...session }) => ({
        ...session,
        clientNames: clientIds.map((clientId) => sessionClientName(clientId, ctx.clients, ctx.branding.read())),
      })),
    /**
     * Resolves `User.secondFactors`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns What they have set up.
     */
    secondFactors: (row: UserRow, _args: unknown, ctx: Context) => {
      const { hasTotp, recoveryCodesLeft, passkeys } = ctx.factors.summary(row.id);
      return { hasTotp, recoveryCodesLeft, passkeyCount: passkeys.length };
    },
  },
  Group: {
    /**
     * Resolves `Group.members`.
     *
     * @param group - The group.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the rows' selection.
     * @returns Its users.
     */
    members: (group: Group, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow[]> =>
      rowsWhere(ctx, info, GeneratedTable.Users, { id: { inArray: group.memberIds } }),
    /**
     * Resolves `Group.clients`.
     *
     * @param group - The group.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the rows' selection.
     * @returns The clients limited to it.
     */
    clients: (group: Group, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow[]> =>
      rowsWhere(ctx, info, GeneratedTable.Clients, { clientId: { inArray: group.clientIds } }),
  },
  Query: {
    /**
     * Resolves `Query.profilePictures`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Whether pictures are on, and the largest upload.
     */
    profilePictures: (_parent: unknown, _args: unknown, ctx: Context) => ({
      isEnabled: ctx.pictures.isEnabled,
      maxBytes: PROFILE_DEFAULTS.maxPictureBytes,
    }),
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
     * @param info - The field, for the row's selection.
     * @returns The signed-in admin.
     */
    viewer: (_parent: unknown, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow> =>
      requiredRow(ctx, info, GeneratedTable.Users, userById(ctx.viewer.id)),
    /**
     * Resolves `Query.groups`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every group.
     */
    groups: (_parent: unknown, _args: unknown, ctx: Context): Group[] => listGroups(ctx),
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
      return pairing === null ? null : pairingView(pairing);
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
      /**
       * Reads each entry's row once it is saved, so it carries whatever the subscription selected.
       *
       * @param payload - The entry, as it was recorded.
       * @param payload.auditEntryAdded - The entry.
       * @param _args - Unused.
       * @param ctx - Request context.
       * @param info - The field, for the row's selection.
       * @returns The entry's row.
       */
      resolve: async (
        { auditEntryAdded: entry }: { auditEntryAdded: AuditEntry },
        _args: unknown,
        ctx: Context,
        info: GraphQLResolveInfo,
      ): Promise<GeneratedRow> => {
        await ctx.audit.settled();
        return requiredRow(ctx, info, GeneratedTable.AuditEntries, { id: { eq: entry.id } });
      },
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
      // The setup URL holds the token, so only who may sign in is kept.
      recordAdminChange(ctx, AuditType.PairingStarted, pairingTarget(started), {
        allowedGroups: started.allowedGroups.join(', '),
        groupsClaim: started.groupsClaim,
      });
      return { pairing: pairingView(started), setupUrl: started.setupUrl };
    },
    /**
     * Resolves `Mutation.finishPairing`.
     *
     * @param _parent - Unused.
     * @param args - The pairing's id, and what the operator chose to set up.
     * @param ctx - Request context.
     * @returns The pairing, finished.
     */
    finishPairing: async (
      _parent: unknown,
      args: { id: string; input: FinishPairingInput },
      ctx: Context,
    ): Promise<PairingView> => {
      const pairing = ctx.pairings.find(args.id);
      if (pairing === null) {
        throw notFound('That setup URL has expired or been cancelled.');
      }
      if (pairing.clientId === null) {
        throw badInput('No app has paired with that setup URL yet.');
      }
      if (pairing.isFinished) {
        throw badInput('That pairing is finished already.');
      }
      const done = await setUpOffers(ctx, pairing, args.input);
      await ctx.pairings.finish(pairing.id);
      const finished = ctx.pairings.find(pairing.id) ?? { ...pairing, isFinished: true };
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.PairingFinished, pairingTarget(pairing), done);
      return pairingView(finished);
    },
    /**
     * Resolves `Mutation.cancelPairing`.
     *
     * @param _parent - Unused.
     * @param args - The pairing's id.
     * @param ctx - Request context.
     * @returns Whether it was still there to cancel.
     */
    cancelPairing: async (_parent: unknown, args: { id: string }, ctx: Context): Promise<boolean> => {
      const pairing = ctx.pairings.find(args.id);
      const wasCancelled = await ctx.pairings.cancel(args.id);
      if (pairing !== null && wasCancelled) {
        recordAdminChange(ctx, AuditType.PairingCancelled, pairingTarget(pairing));
      }
      return wasCancelled;
    },
    /**
     * Resolves `Mutation.createUser`.
     *
     * @param _parent - Unused.
     * @param args - The user to add.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The new user.
     */
    createUser: async (_parent: unknown, args: { input: NewUser }, ctx: Context, info: GraphQLResolveInfo) => {
      const { password, username, name, email } = args.input;
      const hasPassword = password !== undefined && password !== null && password !== '';
      if (hasPassword) {
        await ctx.passwordPolicy.check(password, { username, name, email });
      }
      const user = await ctx.users.create(args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserCreated, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.updateUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new details.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The changed user.
     */
    updateUser: async (
      _parent: unknown,
      args: { id: string; input: UserFields },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = await ctx.users.update(args.id, args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserUpdated, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.setUserPassword`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new password.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    setUserPassword: async (
      _parent: unknown,
      args: { id: string; password: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const owner = loadUser(ctx, args.id);
      await ctx.passwordPolicy.check(args.password, owner);
      const user = await ctx.users.setPassword(args.id, args.password);
      await ctx.passwordLinks.cancelFor(user.id);
      recordAdminChange(ctx, AuditType.UserPasswordSet, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.deleteUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The removed user, as they were.
     */
    deleteUser: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.Users, userById(args.id));
      const user = await ctx.users.remove(args.id);
      await signOutEverywhere(ctx, user.id);
      await ctx.passwordLinks.cancelFor(user.id);
      await ctx.factors.removeAll(user.id);
      await ctx.upstreams.removeUser(user.id);
      await ctx.pictures.discard(user);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserDeleted, userTarget(user));
      return row;
    },
    /**
     * Resolves `Mutation.setUserDisabled`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and whether to disable them.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    setUserDisabled: async (
      _parent: unknown,
      args: { id: string; disabled: boolean },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = await ctx.users.setDisabled(args.id, args.disabled);
      if (user.disabled) {
        await signOutEverywhere(ctx, user.id);
      }
      recordAdminChange(ctx, user.disabled ? AuditType.UserDisabled : AuditType.UserEnabled, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.endUserSession`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and the session's.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     * @throws NOT_FOUND when the user has no such session.
     */
    endUserSession: async (
      _parent: unknown,
      args: { id: string; sessionId: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = loadUser(ctx, args.id);
      const isEnded = await ctx.sessions.endSession(user.id, args.sessionId, ctx.ip);
      if (isEnded === false) {
        throw notFound(`"${user.username}" has no session "${args.sessionId}".`);
      }
      recordAdminChange(ctx, AuditType.UserSessionEnded, userTarget(user), { sessionId: args.sessionId });
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.signOutUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    signOutUser: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const user = loadUser(ctx, args.id);
      await signOutEverywhere(ctx, user.id);
      recordAdminChange(ctx, AuditType.UserSignedOut, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.resetSecondFactors`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    resetSecondFactors: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const user = loadUser(ctx, args.id);
      await ctx.factors.removeAll(user.id);
      recordAdminChange(ctx, AuditType.UserSecondFactorsReset, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.createPasswordLink`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The link and when it expires.
     */
    createPasswordLink: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ): Promise<{ url: string; expiresAt: string }> => {
      const user = loadUser(ctx, args.id);
      const { token, expiresAt } = await ctx.passwordLinks.issue(user.id);
      const url = `${adminUrls(ctx.issuer).base}${WEB_APP_PAGE.setPassword}#token=${token}`;
      // The URL holds the token, so only that a link was made is kept.
      recordAdminChange(ctx, AuditType.PasswordLinkCreated, userTarget(user));
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
    renameGroup: async (_parent: unknown, args: { name: string; newName: string }, ctx: Context): Promise<Group> => {
      const group = await renameGroup(ctx, args.name, args.newName);
      recordAdminChange(ctx, AuditType.GroupRenamed, groupTarget(group.name), { from: args.name });
      return group;
    },
    /**
     * Resolves `Mutation.deleteGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group.
     * @param ctx - Request context.
     * @returns How many users were in it.
     */
    deleteGroup: async (_parent: unknown, args: { name: string }, ctx: Context): Promise<number> => {
      const members = await deleteGroup(ctx, args.name);
      recordAdminChange(ctx, AuditType.GroupDeleted, groupTarget(args.name), { members: String(members) });
      return members;
    },
    /**
     * Resolves `Mutation.rotateKeys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The keys after the rotation.
     */
    rotateKeys: async (_parent: unknown, _args: unknown, ctx: Context): Promise<KeysView> => {
      const keys = keysView(await ctx.keys.rotate());
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.KeysRotated, KEYS_TARGET, { kid: keys.signingKeys[0]?.kid ?? '' });
      return keys;
    },
    /**
     * Resolves `Mutation.setBrandingName`.
     *
     * @param _parent - Unused.
     * @param args - The name.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingName: async (_parent: unknown, args: { name: string }, ctx: Context): Promise<BrandingView> => {
      const branding = await ctx.branding.setName(args.name);
      recordAdminChange(ctx, AuditType.BrandingNameSet, BRANDING_TARGET, { name: branding.name });
      return brandingView(branding);
    },
    /**
     * Resolves `Mutation.setBrandingLogo`.
     *
     * @param _parent - Unused.
     * @param args - The image as a data URL, or null.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingLogo: async (
      _parent: unknown,
      args: { dataUrl?: string | null },
      ctx: Context,
    ): Promise<BrandingView> => {
      const branding = await ctx.branding.setLogo(args.dataUrl ?? null);
      recordAdminChange(ctx, AuditType.BrandingLogoSet, BRANDING_TARGET, {
        logo: branding.logo === null ? 'removed' : 'set',
      });
      return brandingView(branding);
    },
    /**
     * Resolves `Mutation.setHttpRedirects`.
     *
     * @param _parent - Unused.
     * @param args - Whether to allow them, or null to follow the issuer.
     * @param ctx - Request context.
     * @returns The setting.
     */
    setHttpRedirects: async (
      _parent: unknown,
      args: { allowed?: boolean | null },
      ctx: Context,
    ): Promise<HttpRedirectSetting> => {
      const setting = await ctx.settings.setHttpRedirects(args.allowed ?? null);
      recordAdminChange(ctx, AuditType.HttpRedirectsSet, SETTINGS_TARGET, {
        httpRedirects: setting.isAllowed ? 'allowed' : 'refused',
        chosenBy: setting.isSet ? 'operator' : 'issuer',
      });
      return setting;
    },
    /**
     * Resolves `Mutation.setPasswordRules`.
     *
     * @param _parent - Unused.
     * @param args - The rules to change; null or left out keeps one.
     * @param ctx - Request context.
     * @returns The rules.
     */
    setPasswordRules: async (
      _parent: unknown,
      args: { minScore?: number | null; checkBreaches?: boolean | null },
      ctx: Context,
    ): Promise<PasswordRules> => {
      const rules = await ctx.settings.setPasswordRules({
        ...(args.minScore === undefined || args.minScore === null ? {} : { minScore: args.minScore }),
        ...(args.checkBreaches === undefined || args.checkBreaches === null
          ? {}
          : { checkBreaches: args.checkBreaches }),
      });
      recordAdminChange(ctx, AuditType.PasswordRulesSet, SETTINGS_TARGET, {
        minScore: String(rules.minScore),
        breachCheck: rules.checkBreaches ? 'on' : 'off',
      });
      return rules;
    },
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
