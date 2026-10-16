import path from 'node:path';
import type { Adapter, AdapterFactory, AdapterPayload, ResponseType } from 'oidc-provider';
import { MS_PER_SECOND } from '../core/wire.ts';
import { ClientAuthMethod, type ClientStore, type OidcClient } from '../store/clients.ts';
import { openJsonFile } from '../store/json-file.ts';

/** One stored artefact: a session, a code, a token, a grant. */
interface StoredEntry {
  payload: AdapterPayload;
  /** When it stops being found, in epoch milliseconds. Null for never. */
  expiresAt: number | null;
}

/** Every artefact of one model, by id. */
type ModelDocument = Record<string, StoredEntry>;

/** The model whose records are the operator's clients rather than the provider's own artefacts. */
const CLIENT_MODEL = 'Client';
/** The flows every client may use. */
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const RESPONSE_TYPES: ResponseType[] = ['code'];

/**
 * Describes a client the way the provider reads one.
 *
 * @param client - The operator's client.
 * @returns Its OIDC client metadata.
 */
export function clientMetadata(client: OidcClient): AdapterPayload {
  const isPublic = client.authMethod === ClientAuthMethod.None;
  return {
    client_id: client.clientId,
    client_name: client.name,
    ...(isPublic ? {} : { client_secret: client.clientSecret ?? undefined }),
    token_endpoint_auth_method: client.authMethod,
    redirect_uris: client.redirectUris,
    post_logout_redirect_uris: client.postLogoutRedirectUris,
    grant_types: GRANT_TYPES,
    response_types: RESPONSE_TYPES,
  };
}

/**
 * Serves the provider's `Client` model from the client store. Clients are added and removed in the
 * web app, never by the provider, so its writes are ignored.
 *
 * @param clients - The client store.
 * @param builtIns - Clients the server itself is, such as the admin UI. They are not in the store.
 * @returns The adapter.
 */
function createClientAdapter(clients: ClientStore, builtIns: AdapterPayload[]): Adapter {
  const ignore = async (): Promise<void> => {};
  return {
    find: async (id) => {
      const builtIn = builtIns.find((candidate) => candidate.client_id === id);
      if (builtIn !== undefined) {
        return builtIn;
      }
      const client = clients.find(id);
      return client === null ? undefined : clientMetadata(client);
    },
    upsert: ignore,
    findByUserCode: async () => undefined,
    findByUid: async () => undefined,
    consume: ignore,
    destroy: ignore,
    revokeByGrantId: ignore,
  };
}

/**
 * Keeps one model's artefacts in `<dir>/<Model>.json`.
 *
 * @param file - The model's file.
 * @param now - The clock, in epoch milliseconds.
 * @returns The adapter.
 *
 * @remarks
 * Expired entries are dropped whenever the file is written, so it only grows with live sessions and tokens.
 */
function createFileAdapter(file: string, now: () => number): Adapter {
  const document = openJsonFile<ModelDocument>(file, {});

  const isLive = (entry: StoredEntry): boolean => entry.expiresAt === null || entry.expiresAt > now();

  const live = (): [string, StoredEntry][] => Object.entries(document.read()).filter(([, entry]) => isLive(entry));

  const write = (change: (entries: [string, StoredEntry][]) => [string, StoredEntry][]): void => {
    document.update(() => Object.fromEntries(change(live())));
  };

  const findWhere = (matches: (payload: AdapterPayload) => boolean): AdapterPayload | undefined =>
    live().find(([, entry]) => matches(entry.payload))?.[1].payload;

  return {
    upsert: async (id, payload, expiresIn) => {
      const expiresAt = expiresIn === undefined ? null : now() + expiresIn * MS_PER_SECOND;
      write((entries) => [...entries.filter(([key]) => key !== id), [id, { payload, expiresAt }]]);
    },
    find: async (id) => {
      const entry = document.read()[id];
      const isFound = entry !== undefined && isLive(entry);
      return isFound ? entry.payload : undefined;
    },
    findByUid: async (uid) => findWhere((payload) => payload.uid === uid),
    findByUserCode: async (userCode) => findWhere((payload) => payload.userCode === userCode),
    consume: async (id) => {
      const consumedAt = Math.floor(now() / MS_PER_SECOND);
      write((entries) =>
        entries.map(([key, entry]) => [
          key,
          key === id ? { ...entry, payload: { ...entry.payload, consumed: consumedAt } } : entry,
        ]),
      );
    },
    destroy: async (id) => {
      write((entries) => entries.filter(([key]) => key !== id));
    },
    revokeByGrantId: async (grantId) => {
      write((entries) => entries.filter(([, entry]) => entry.payload.grantId !== grantId));
    },
  };
}

/** What the adapter factory is built from. */
export interface AdapterSettings {
  /** The directory the model files go in. */
  dir: string;
  clients: ClientStore;
  /** Client metadata served before the store's, for the server's own clients. */
  builtInClients?: AdapterPayload[];
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

/**
 * Builds the provider's adapter: clients from the client store, everything else in flat files.
 *
 * @param settings - Where the files go, the clients, and the clock.
 * @returns A factory the provider calls once per model.
 */
export function createAdapterFactory(settings: AdapterSettings): AdapterFactory {
  const { dir, clients, builtInClients = [], now = Date.now } = settings;
  return (model) => {
    if (model === CLIENT_MODEL) {
      return createClientAdapter(clients, builtInClients);
    }
    return createFileAdapter(path.join(dir, `${model}.json`), now);
  };
}
