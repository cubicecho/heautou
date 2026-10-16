import path from 'node:path';
import type Provider from 'oidc-provider';
import { createAdapterFactory } from '../oidc/adapter.ts';
import { createProvider } from '../oidc/provider.ts';
import { type ClientStore, createClientStore, type OidcClient } from '../store/clients.ts';
import { openJsonFile } from '../store/json-file.ts';
import { loadOrCreateKeys, type ProviderKeys } from '../store/keys.ts';
import { createUserStore, type User, type UserStore } from '../store/users.ts';

/** The files under the data directory. */
const DATA_FILES = {
  clients: 'clients.json',
  users: 'users.json',
  keys: 'keys.json',
  /** A directory: one file per provider model (sessions, codes, tokens...). */
  oidc: 'oidc',
} as const;

/** Where the services keep their files and how the provider is reached. */
export interface ServiceSettings {
  /** An existing, writable directory. */
  dataDir: string;
  /** The public URL of the provider, ending in `/oidc`. */
  issuer: string;
  /** Whether X-Forwarded-Proto and -Host are believed. */
  isProxied: boolean;
}

/** Everything the HTTP app is built from. */
export interface Services {
  clients: ClientStore;
  users: UserStore;
  provider: Provider;
  issuer: string;
}

/**
 * Opens the flat files and builds the provider on them. Keys are made on first use.
 *
 * @param settings - Where the files are and the issuer.
 * @returns The stores and the provider.
 */
export function openServices(settings: ServiceSettings): Services {
  const at = (name: string): string => path.join(settings.dataDir, name);
  const clients = createClientStore(openJsonFile<OidcClient[]>(at(DATA_FILES.clients), []));
  const users = createUserStore(openJsonFile<User[]>(at(DATA_FILES.users), []));
  const keys = loadOrCreateKeys(openJsonFile<ProviderKeys | null>(at(DATA_FILES.keys), null));
  const provider = createProvider({
    issuer: settings.issuer,
    clients,
    users,
    keys,
    adapter: createAdapterFactory(at(DATA_FILES.oidc), clients),
    isProxied: settings.isProxied,
  });
  return { clients, users, provider, issuer: settings.issuer };
}
