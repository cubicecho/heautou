import path from 'node:path';
import type Provider from 'oidc-provider';
import { adminClientMetadata } from '../admin/admin-client.ts';
import { createSetupGate, type SetupGate } from '../admin/setup.ts';
import { createAdapterFactory, createModelFiles } from '../oidc/adapter.ts';
import { createProviderHost, type ProviderHost } from '../oidc/host.ts';
import { claimNamesIn, createProvider } from '../oidc/provider.ts';
import { createSessionTools, type SessionTools } from '../oidc/sessions.ts';
import { type AdminSessionDocument, type AdminSessionStore, createAdminSessionStore } from '../store/admin-sessions.ts';
import { type Branding, type BrandingStore, createBrandingStore } from '../store/branding.ts';
import { type ClientStore, createClientStore, type OidcClient } from '../store/clients.ts';
import { openJsonFile } from '../store/json-file.ts';
import { type KeyStore, openKeyStore, type ProviderKeys } from '../store/keys.ts';
import { createPairingStore, type PairingDocument, type PairingStore } from '../store/pairings.ts';
import { createPasswordLinkStore, type PasswordLinkDocument, type PasswordLinkStore } from '../store/password-links.ts';
import { createUserStore, type User, type UserStore } from '../store/users.ts';

/** The files under the data directory. */
const DATA_FILES = {
  clients: 'clients.json',
  users: 'users.json',
  keys: 'keys.json',
  adminSessions: 'admin-sessions.json',
  passwordLinks: 'password-links.json',
  branding: 'branding.json',
  pairings: 'pairings.json',
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
  /** The clock, in epoch milliseconds, for the setup window and the setup URLs. */
  now?: () => number;
}

/** Everything the HTTP app is built from. */
export interface Services {
  clients: ClientStore;
  users: UserStore;
  /** The web app's sessions, for admins and for users on their account page. */
  adminSessions: AdminSessionStore;
  passwordLinks: PasswordLinkStore;
  /** Setup URLs handed out for apps to pair with. */
  pairings: PairingStore;
  branding: BrandingStore;
  /** Guards making the first admin; its token is logged at boot while one is needed. */
  setup: SetupGate;
  keys: KeyStore;
  /** The provider, built again when its keys or claim names change. */
  host: ProviderHost;
  /** The provider's sessions and tokens per user. */
  sessions: SessionTools;
  issuer: string;
}

/**
 * Opens the flat files and builds the provider on them. Keys are made on first use and rotated at boot once they
 * are `KEY_DEFAULTS.rotationDays` old. The admin UI is a built-in client of the provider.
 *
 * @param settings - Where the files are and the issuer.
 * @returns The stores and the provider.
 */
export function openServices(settings: ServiceSettings): Services {
  const at = (name: string): string => path.join(settings.dataDir, name);
  const clients = createClientStore(openJsonFile<OidcClient[]>(at(DATA_FILES.clients), []));
  const users = createUserStore(openJsonFile<User[]>(at(DATA_FILES.users), []));
  const keys = openKeyStore(openJsonFile<ProviderKeys | null>(at(DATA_FILES.keys), null));
  if (keys.isDue()) {
    keys.rotate();
  }
  const adminSessions = createAdminSessionStore(openJsonFile<AdminSessionDocument>(at(DATA_FILES.adminSessions), {}));
  const passwordLinks = createPasswordLinkStore(openJsonFile<PasswordLinkDocument>(at(DATA_FILES.passwordLinks), {}));
  const pairings = createPairingStore(openJsonFile<PairingDocument>(at(DATA_FILES.pairings), {}), settings.now);
  const branding = createBrandingStore(openJsonFile<Partial<Branding>>(at(DATA_FILES.branding), {}));
  const files = createModelFiles(at(DATA_FILES.oidc));
  const adapter = createAdapterFactory({
    files,
    clients,
    builtInClients: [adminClientMetadata(settings.issuer)],
  });
  const build = (): Provider => {
    const provider = createProvider({
      issuer: settings.issuer,
      clients,
      users,
      pairings,
      keys: keys.current(),
      adapter,
      isProxied: settings.isProxied,
      claimNames: claimNamesIn(users, clients),
    });
    // A paired client may bring a new groups claim, which the provider has to be built again to release.
    const refreshSoon = (): void => {
      setImmediate(() => host.refresh());
    };
    provider.on('registration_create.success', refreshSoon);
    provider.on('registration_update.success', refreshSoon);
    provider.on('registration_delete.success', refreshSoon);
    return provider;
  };
  const host: ProviderHost = createProviderHost(build, () =>
    JSON.stringify({ kids: keys.current().jwks.map((jwk) => jwk.kid), claims: claimNamesIn(users, clients) }),
  );
  const setup = createSetupGate(users, settings.now);
  return {
    clients,
    users,
    adminSessions,
    passwordLinks,
    pairings,
    branding,
    setup,
    keys,
    host,
    sessions: createSessionTools(files),
    issuer: settings.issuer,
  };
}
