import type { Adapter, AdapterFactory, AdapterPayload, ResponseType } from 'oidc-provider';
import { DEVICE_FLOW_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import { type DataDocument, type DocumentStore, documentFromRows, type Row } from '../db/document.ts';
import { oidcModelDocument } from '../db/documents.ts';
import { oidcModels } from '../db/schema.ts';
import { ClientAuthMethod, type ClientStore, type OidcClient } from '../store/clients.ts';

/** One stored artefact: a session, a code, a token, a grant. */
export interface StoredEntry {
  payload: AdapterPayload;
  /** When it stops being found, in epoch milliseconds. Null for never. */
  expiresAt: number | null;
}

/** Every artefact of one model, by id. */
export type ModelDocument = Record<string, StoredEntry>;

/**
 * The provider's models, one document each, each opened once. The provider is rebuilt when its keys or claims
 * change, and the session tools read the same models, so every reader must share one in-memory copy.
 */
export interface ModelDocuments {
  /**
   * Returns a model's document. Every model's rows were read when these were opened, so this reads nothing.
   *
   * @param model - The model's name, such as `Session`.
   * @returns Its document.
   */
  open: (model: string) => DataDocument<ModelDocument>;
  /** Reads every model again, after a restore replaced them. */
  reload: () => Promise<void>;
  /** The clock, in epoch milliseconds. */
  now: () => number;
}

/**
 * Opens the provider's models: reads every row of `oidc_models` once, so a model is then found without a query.
 *
 * @param store - The database and its write queue.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The models.
 */
export async function openModelDocuments(store: DocumentStore, now: () => number = Date.now): Promise<ModelDocuments> {
  const opened = new Map<string, DataDocument<ModelDocument>>();
  /**
   * Reads every model's rows, grouped by model.
   *
   * @returns The rows of each model.
   */
  const loadAll = async (): Promise<Map<string, Row[]>> => {
    const byModel = new Map<string, Row[]>();
    for (const row of await store.db.select().from(oidcModels)) {
      byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
    }
    return byModel;
  };
  const rowsAtOpen = await loadAll();
  return {
    open: (model) => {
      const existing = opened.get(model);
      if (existing !== undefined) {
        return existing;
      }
      const document = documentFromRows(store, oidcModelDocument(model), [rowsAtOpen.get(model) ?? []]);
      opened.set(model, document);
      return document;
    },
    reload: async () => {
      for (const document of opened.values()) {
        await document.reload();
      }
    },
    now,
  };
}

/**
 * Says whether a stored entry has not expired.
 *
 * @param entry - The entry.
 * @param now - The time, in epoch milliseconds.
 * @returns True until its expiry.
 */
export function isLive(entry: StoredEntry, now: number): boolean {
  return entry.expiresAt === null || entry.expiresAt > now;
}

/** The model whose records are the operator's clients rather than the provider's own artefacts. */
const CLIENT_MODEL = 'Client';
/** The device flow's codes, one per device waiting for its user to approve. */
const DEVICE_CODE_MODEL = 'DeviceCode';
const AUTHORIZATION_CODE = 'authorization_code';
const REFRESH_TOKEN = 'refresh_token';
const CLIENT_CREDENTIALS = 'client_credentials';
/** The device flow's grant (RFC 8628). */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const RESPONSE_TYPES: ResponseType[] = ['code'];

/**
 * Describes a client the way the provider reads one.
 *
 * @param client - The operator's client.
 * @returns Its OIDC client metadata.
 */
export function clientMetadata(client: OidcClient): AdapterPayload {
  const isPublic = client.authMethod === ClientAuthMethod.None;
  // A client with no redirect URIs signs users in only with the device flow, or is a service that only gets tokens
  // for itself.
  const signsUsersIn = client.redirectUris.length > 0;
  const grantTypes = [
    ...(signsUsersIn ? [AUTHORIZATION_CODE] : []),
    ...(client.allowDeviceFlow ? [DEVICE_CODE_GRANT] : []),
    ...(signsUsersIn || client.allowDeviceFlow ? [REFRESH_TOKEN] : []),
    ...(client.allowClientCredentials && isPublic === false ? [CLIENT_CREDENTIALS] : []),
  ];
  return {
    client_id: client.clientId,
    client_name: client.name,
    ...(isPublic ? {} : { client_secret: client.clientSecret ?? undefined }),
    token_endpoint_auth_method: client.authMethod,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: grantTypes,
    response_types: signsUsersIn ? RESPONSE_TYPES : [],
    ...(client.backchannelLogoutUri === null
      ? {}
      : {
          backchannel_logout_uri: client.backchannelLogoutUri,
          backchannel_logout_session_required: client.backchannelLogoutSessionRequired,
        }),
  };
}

/**
 * Serves the provider's `Client` model from the client store. The provider writes a client only when an app
 * registers or updates itself with a setup URL, and the pairing policy (`pairing.ts`) has stored it by then, so a
 * write is only checked. An app removing itself (RFC 7592) removes its client from the store.
 *
 * @param clients - The client store.
 * @param builtIns - Clients the server itself is, such as the admin UI. They are not in the store.
 * @returns The adapter.
 */
function createClientAdapter(clients: ClientStore, builtIns: AdapterPayload[]): Adapter {
  const ignore = async (): Promise<void> => {};
  const isBuiltIn = (id: string): boolean => builtIns.some((candidate) => candidate.client_id === id);
  return {
    find: async (id) => {
      const builtIn = builtIns.find((candidate) => candidate.client_id === id);
      if (builtIn !== undefined) {
        return builtIn;
      }
      const client = clients.find(id);
      return client === null ? undefined : clientMetadata(client);
    },
    upsert: async (id) => {
      const isUnknown = isBuiltIn(id) === false && clients.find(id) === null;
      if (isUnknown) {
        throw new Error(`Client "${id}" was written without going through the pairing policy.`);
      }
    },
    findByUserCode: async () => undefined,
    findByUid: async () => undefined,
    consume: ignore,
    destroy: async (id) => {
      const isStored = isBuiltIn(id) === false && clients.find(id) !== null;
      if (isStored) {
        await clients.remove(id);
      }
    },
    revokeByGrantId: ignore,
  };
}

/**
 * Keeps one model's artefacts in its file.
 *
 * @param document - The model's file.
 * @param now - The clock, in epoch milliseconds.
 * @param [keptSeconds] - How long an entry is kept past its expiry, for a model whose expired entries still answer.
 * @returns The adapter.
 *
 * @remarks
 * Expired entries are dropped whenever the file is written, so it only grows with live sessions and tokens.
 */
function createDocumentAdapter(document: DataDocument<ModelDocument>, now: () => number, keptSeconds = 0): Adapter {
  const live = (): [string, StoredEntry][] =>
    Object.entries(document.read()).filter(([, entry]) => isLive(entry, now()));

  const write = async (change: (entries: [string, StoredEntry][]) => [string, StoredEntry][]): Promise<void> => {
    await document.update(() => Object.fromEntries(change(live())));
  };

  const findWhere = (matches: (payload: AdapterPayload) => boolean): AdapterPayload | undefined =>
    live().find(([, entry]) => matches(entry.payload))?.[1].payload;

  return {
    upsert: async (id, payload, expiresIn) => {
      const expiresAt = expiresIn === undefined ? null : now() + (expiresIn + keptSeconds) * MS_PER_SECOND;
      await write((entries) => [...entries.filter(([key]) => key !== id), [id, { payload, expiresAt }]]);
    },
    find: async (id) => {
      const entry = document.read()[id];
      const isFound = entry !== undefined && isLive(entry, now());
      return isFound ? entry.payload : undefined;
    },
    findByUid: async (uid) => findWhere((payload) => payload.uid === uid),
    findByUserCode: async (userCode) => findWhere((payload) => payload.userCode === userCode),
    consume: async (id) => {
      const consumedAt = Math.floor(now() / MS_PER_SECOND);
      await write((entries) =>
        entries.map(([key, entry]) => [
          key,
          key === id ? { ...entry, payload: { ...entry.payload, consumed: consumedAt } } : entry,
        ]),
      );
    },
    destroy: async (id) => {
      await write((entries) => entries.filter(([key]) => key !== id));
    },
    revokeByGrantId: async (grantId) => {
      await write((entries) => entries.filter(([, entry]) => entry.payload.grantId !== grantId));
    },
  };
}

/** What the adapter factory is built from. */
export interface AdapterSettings {
  /** The provider's models. */
  models: ModelDocuments;
  clients: ClientStore;
  /** Client metadata served before the store's, for the server's own clients. */
  builtInClients?: AdapterPayload[];
}

/**
 * Builds the provider's adapter: clients from the client store, every other model in its own document.
 *
 * @param settings - The models, the clients and the built-in clients.
 * @returns A factory the provider calls once per model.
 */
export function createAdapterFactory(settings: AdapterSettings): AdapterFactory {
  const { models, clients, builtInClients = [] } = settings;
  return (model) => {
    if (model === CLIENT_MODEL) {
      return createClientAdapter(clients, builtInClients);
    }
    // A device still polling after its code expired is told `expired_token` (RFC 8628), which needs the code found.
    const keptSeconds = model === DEVICE_CODE_MODEL ? DEVICE_FLOW_DEFAULTS.expiredKeptSeconds : 0;
    return createDocumentAdapter(models.open(model), models.now, keptSeconds);
  };
}
