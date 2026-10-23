import type { GraphQLResolveInfo } from 'graphql';
import { Repeater } from 'graphql-yoga';
import type { Context } from '../core/context.ts';
import { badInput, notFound } from '../core/errors.ts';
import { type StartedPairing, startPairing } from '../oidc/pairing.ts';
import type { OfferedApi } from '../oidc/pairing-offers.ts';
import { TOKEN_FORMAT_JWT } from '../store/apis.ts';
import { AuditType, apiTarget, pairingTarget, recordAdminChange } from '../store/audit.ts';
import { withoutBlanks } from '../store/claims.ts';
import type { OidcClient } from '../store/clients.ts';
import type { Pairing, PairingInput } from '../store/pairings.ts';
import { clientById } from './clients.ts';
import { GeneratedTable, rowWhere } from './rows.ts';

/** The pairing part of the admin API: setup URLs an app registers itself with, and what it offers once it has. */
export const PAIRING_TYPE_DEFS = /* GraphQL */ `
  "Where a setup URL is."
  enum PairingStatus {
    "No app has registered with it yet."
    WAITING
    "An app has, and is the pairing's client."
    PAIRED
  }

  "A setup URL handed out for an app to register itself with."
  type Pairing {
    id: ID!
    status: PairingStatus!
    "When the URL stops working, and the pairing is forgotten, as an ISO 8601 string."
    expiresAt: String!
    "The allowed groups the app's client gets."
    allowedGroups: [String!]!
    "The groups claim the app's client gets."
    groupsClaim: String!
    "The client the app registered as. Null while WAITING."
    client: Client
    "Whether the operator has chosen what else to set up for the app."
    finished: Boolean!
    "What the app offers to set up besides its sign-in. Null while WAITING, and once finished."
    offers: PairingOffers
  }

  "What a paired app offers to set up besides its sign-in, for the operator to turn on or leave off."
  type PairingOffers {
    "The client the app registered for its devices (the device flow), waiting for the flow to be turned on. Null when it asked for none."
    deviceClient: Client
    "The API the app describes in its protected resource metadata (RFC 9728), found under its client_uri. Null when it describes none heautou can add."
    api: OfferedApi
  }

  "An API a paired app describes, for the operator to add."
  type OfferedApi {
    "The resource indicator apps send, and the aud of its access tokens."
    identifier: String!
    "What the app calls it."
    name: String!
    "The scopes it lists."
    scopes: [String!]!
    "The API already added with this identifier, which the app's clients would join. Null when it is new."
    existing: Api
  }

  "A pairing just started, with the URL to paste into the app. The URL is shown only this once."
  type StartedPairing {
    pairing: Pairing!
    "The issuer, with a single-use initial access token in the fragment."
    setupUrl: String!
  }

  "What the client of an app that pairs gets."
  input PairingInput {
    allowedGroups: [String!]
    groupsClaim: String
  }

  "What the operator sets up for a paired app, from what it offers."
  input FinishPairingInput {
    "Turn its device client's device flow on. False removes the device client."
    deviceFlow: Boolean!
    "Add its API with its clients allowed, or allow them on the API when it is there already."
    api: Boolean!
  }

  extend type Query {
    "A pairing. Null once it has expired or been cancelled."
    pairing(id: ID!): Pairing
  }

  extend type Mutation {
    "Makes a setup URL an app registers itself with (OAuth 2.0 Dynamic Client Registration): its client, and optionally a device client. It works for a few minutes."
    startPairing(input: PairingInput!): StartedPairing!
    "Stops a setup URL working. False when it had already expired or been used."
    cancelPairing(id: ID!): Boolean!
    "Sets up what a paired app offers besides its sign-in, as the operator chose. Once per pairing."
    finishPairing(id: ID!, input: FinishPairingInput!): Pairing!
  }

  extend type Subscription {
    "The pairing now, then again each time it changes. Null once it has expired or been cancelled, and the stream ends."
    pairingChanged(id: ID!): Pairing
  }
`;

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
  finished: boolean;
  /** The stored pairing, for `client` and `offers`. */
  pairing: Pairing;
}

/** What `PairingOffers` resolves from. */
interface PairingOffersView {
  deviceClient: OidcClient | null;
  api: OfferedApi | null;
}

/** What the operator chose to set up for a paired app. */
interface FinishPairingInput {
  deviceFlow: boolean;
  api: boolean;
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
    recordAdminChange(ctx, type, apiTarget(api));
    done.api = api.identifier;
  }
  return done;
}

/** The entries after which a pairing may read differently. */
const PAIRING_CHANGES: readonly AuditType[] = [
  AuditType.PairingCompleted,
  AuditType.PairingCancelled,
  AuditType.PairingFinished,
];

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

/** The resolvers for pairing, merged with the rest of the schema's. */
export const pairingResolvers = {
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
  Query: {
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
  },
};
