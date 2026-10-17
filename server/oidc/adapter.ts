import path from 'node:path';
import type { Adapter, AdapterFactory, AdapterPayload, ResponseType } from 'oidc-provider';
import { MS_PER_SECOND } from '../core/wire.ts';
import { ClientAuthMethod, type ClientStore, type OidcClient } from '../store/clients.ts';
import { type JsonFile, openJsonFile } from '../store/json-file.ts';

/** One stored artefact: a session, a code, a token, a grant. */
export interface StoredEntry {
  payload: AdapterPayload;
  /** When it stops being found, in epoch milliseconds. Null for never. */
  expiresAt: number | null;
}

/** Every artefact of one model, by id. */
export type ModelDocument = Record<string, StoredEntry>;

/**
 * The provider's model files, one per model, each opened once. The provider is rebuilt when its keys or claims
 * change, and the session tools read the same files, so every reader must share one in-memory copy.
 */
export interface ModelFiles {
  /**
   * Opens a model's file, or returns the one already open.
   *
   * @param model - The model's name, such as `Session`.
   * @returns Its document.
   */
  open: (model: string) => JsonFile<ModelDocument>;
  /** The clock, in epoch milliseconds. */
  now: () => number;
}

/**
 * Opens model files under a directory as `<dir>/<Model>.json`.
 *
 * @param dir - The directory.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The files.
 */
export function createModelFiles(dir: string, now: () => number = Date.now): ModelFiles {
  const opened = new Map<string, JsonFile<ModelDocument>>();
  return {
    open: (model) => {
      const existing = opened.get(model);
      if (existing !== undefined) {
        return existing;
      }
      const file = openJsonFile<ModelDocument>(path.join(dir, `${model}.json`), {});
      opened.set(model, file);
      return file;
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
/** The flows every client may use. */
const SIGN_IN_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const CLIENT_CREDENTIALS = 'client_credentials';
const RESPONSE_TYPES: ResponseType[] = ['code'];

/**
 * Describes a client the way the provider reads one.
 *
 * @param client - The operator's client.
 * @returns Its OIDC client metadata.
 */
export function clientMetadata(client: OidcClient): AdapterPayload {
  const isPublic = client.authMethod === ClientAuthMethod.None;
  // A client with no redirect URIs is a service that only gets tokens for itself.
  const signsUsersIn = client.redirectUris.length > 0;
  const grantTypes = [
    ...(signsUsersIn ? SIGN_IN_GRANT_TYPES : []),
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
        clients.remove(id);
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
 * @returns The adapter.
 *
 * @remarks
 * Expired entries are dropped whenever the file is written, so it only grows with live sessions and tokens.
 */
function createFileAdapter(document: JsonFile<ModelDocument>, now: () => number): Adapter {
  const live = (): [string, StoredEntry][] =>
    Object.entries(document.read()).filter(([, entry]) => isLive(entry, now()));

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
      const isFound = entry !== undefined && isLive(entry, now());
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
  /** The model files. */
  files: ModelFiles;
  clients: ClientStore;
  /** Client metadata served before the store's, for the server's own clients. */
  builtInClients?: AdapterPayload[];
}

/**
 * Builds the provider's adapter: clients from the client store, everything else in flat files.
 *
 * @param settings - Where the files go, the clients, and the clock.
 * @returns A factory the provider calls once per model.
 */
export function createAdapterFactory(settings: AdapterSettings): AdapterFactory {
  const { files, clients, builtInClients = [] } = settings;
  return (model) => {
    if (model === CLIENT_MODEL) {
      return createClientAdapter(clients, builtInClients);
    }
    return createFileAdapter(files.open(model), files.now);
  };
}
