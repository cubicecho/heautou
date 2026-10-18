import path from 'node:path';
import type Provider from 'oidc-provider';
import type { Client, KoaContextWithOIDC } from 'oidc-provider';
import { adminClientMetadata } from '../admin/admin-client.ts';
import { createSetupGate, type SetupGate } from '../admin/setup.ts';
import { createAdapterFactory, createModelFiles } from '../oidc/adapter.ts';
import { recordProviderEvents } from '../oidc/audit-events.ts';
import { createProviderHost, type ProviderHost } from '../oidc/host.ts';
import { claimNamesIn, createProvider } from '../oidc/provider.ts';
import { createSessionTools, type SessionTools } from '../oidc/sessions.ts';
import { type AdminSessionDocument, type AdminSessionStore, createAdminSessionStore } from '../store/admin-sessions.ts';
import { type AuditLog, AuditTargetKind, AuditType, KEYS_TARGET, openAuditLog } from '../store/audit.ts';
import { type Branding, type BrandingStore, createBrandingStore } from '../store/branding.ts';
import { type ClientStore, clientSecretsIn, createClientStore, type OidcClient } from '../store/clients.ts';
import { createFactorStore, type FactorStore, type FactorsDocument, factorSecretsIn } from '../store/factors.ts';
import { openJsonFile } from '../store/json-file.ts';
import { type KeyStore, openKeyStore, type ProviderKeys, privateKeysIn } from '../store/keys.ts';
import { createPairingStore, type PairingDocument, type PairingStore } from '../store/pairings.ts';
import { createPasswordLinkStore, type PasswordLinkDocument, type PasswordLinkStore } from '../store/password-links.ts';
import { openSealedFile } from '../store/sealed-file.ts';
import { createSettingsStore, type SettingsDocument, type SettingsStore } from '../store/settings.ts';
import { createUserStore, type User, type UserStore } from '../store/users.ts';
import { createPasswordPolicy, type FetchRange, type PasswordPolicy } from './password-policy.ts';
import { createSecretBox, type SecretKeys } from './secret-box.ts';

/** The files under the data directory. */
const DATA_FILES = {
  clients: 'clients.json',
  users: 'users.json',
  keys: 'keys.json',
  adminSessions: 'admin-sessions.json',
  passwordLinks: 'password-links.json',
  branding: 'branding.json',
  pairings: 'pairings.json',
  settings: 'settings.json',
  /** Second factors: authenticator app secrets (sealed), recovery code hashes, passkeys. */
  factors: 'factors.json',
  /** JSON lines, rotated by size into `audit.1.jsonl` and so on. */
  audit: 'audit.jsonl',
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
  /** The clock, in epoch milliseconds, for the setup window, the setup URLs and key rotation. */
  now?: () => number;
  /** The keys client secrets and private keys are sealed with. Unset or null keeps them plain text. */
  secretKeys?: SecretKeys | null;
  /** Fetches from Have I Been Pwned for the breach check. Unset, the global `fetch`. */
  fetchRange?: FetchRange;
}

/** Everything the HTTP app is built from. */
export interface Services {
  clients: ClientStore;
  users: UserStore;
  /** Each user's second factors. */
  factors: FactorStore;
  /** The web app's sessions, for admins and for users on their account page. */
  adminSessions: AdminSessionStore;
  passwordLinks: PasswordLinkStore;
  /** Setup URLs handed out for apps to pair with. */
  pairings: PairingStore;
  branding: BrandingStore;
  /** The operator's settings, such as whether plain http redirect URIs are allowed. */
  settings: SettingsStore;
  /** Checks a new password against the rules under Settings before a store saves it. */
  passwordPolicy: PasswordPolicy;
  /** Who did what: sign-ins, admin changes, account changes. */
  audit: AuditLog;
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
 * @param settings - Where the files are, the issuer and the secret key.
 * @returns The stores and the provider.
 * @throws SecretKeyError when the stored secrets don't open with the key, or are sealed and no key is set.
 */
export function openServices(settings: ServiceSettings): Services {
  const at = (name: string): string => path.join(settings.dataDir, name);
  const sealingKeys = settings.secretKeys ?? null;
  const box = sealingKeys === null ? null : createSecretBox(sealingKeys);
  // Every sealed file is opened, and so checked against the key, before any is re-sealed.
  const clientFile = openJsonFile<OidcClient[]>(at(DATA_FILES.clients), []);
  const keyFile = openJsonFile<ProviderKeys | null>(at(DATA_FILES.keys), null);
  const factorFile = openJsonFile<FactorsDocument>(at(DATA_FILES.factors), {});
  if (box !== null) {
    clientSecretsIn(clientFile.read(), box.open);
    privateKeysIn(keyFile.read(), box.open);
    factorSecretsIn(factorFile.read(), box.open);
  }
  const providerSettings = createSettingsStore(
    openJsonFile<SettingsDocument>(at(DATA_FILES.settings), {}),
    settings.issuer,
  );
  const clients = createClientStore(openSealedFile(clientFile, box, clientSecretsIn), {
    allowsHttpRedirects: () => providerSettings.httpRedirects().isAllowed,
  });
  const users = createUserStore(openJsonFile<User[]>(at(DATA_FILES.users), []));
  const factors = createFactorStore(openSealedFile(factorFile, box, factorSecretsIn), settings.now);
  const audit = openAuditLog(at(DATA_FILES.audit), settings.now);
  const now = settings.now ?? Date.now;
  const keys = openKeyStore(openSealedFile(keyFile, box, privateKeysIn), () => new Date(now()));
  if (keys.isDue()) {
    const rotated = keys.rotate();
    audit.record({
      type: AuditType.KeysRotated,
      actor: null,
      ip: null,
      target: KEYS_TARGET,
      detail: { kid: rotated.jwks[0]?.kid ?? '', reason: 'scheduled' },
    });
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
      settings: providerSettings,
      keys: keys.current(),
      adapter,
      isProxied: settings.isProxied,
      claimNames: claimNamesIn(users, clients),
    });
    // A paired client may bring a new groups claim, which the provider has to be built again to release.
    const refreshSoon = (): void => {
      setImmediate(() => host.refresh());
    };
    /**
     * Records what a paired app did to its own registration.
     *
     * @param type - Which change.
     * @returns A listener for the provider's `registration_*.success` events.
     */
    const recordRegistration =
      (type: AuditType) =>
      (ctx: KoaContextWithOIDC, client: Client): void => {
        audit.record({
          type,
          actor: null,
          ip: ctx.ip,
          target: {
            kind: AuditTargetKind.Client,
            id: client.clientId,
            name: client.clientName ?? clients.find(client.clientId)?.name ?? client.clientId,
          },
        });
        refreshSoon();
      };
    provider.on('registration_create.success', recordRegistration(AuditType.PairingCompleted));
    provider.on('registration_update.success', recordRegistration(AuditType.RegistrationUpdated));
    provider.on('registration_delete.success', recordRegistration(AuditType.RegistrationDeleted));
    recordProviderEvents(provider, { audit, users, clients });
    return provider;
  };
  const host: ProviderHost = createProviderHost(build, () =>
    JSON.stringify({ kids: keys.current().jwks.map((jwk) => jwk.kid), claims: claimNamesIn(users, clients) }),
  );
  const setup = createSetupGate(users, settings.now);
  return {
    clients,
    users,
    factors,
    adminSessions,
    passwordLinks,
    pairings,
    branding,
    settings: providerSettings,
    passwordPolicy: createPasswordPolicy(providerSettings.passwordRules, {}, settings.fetchRange),
    audit,
    setup,
    keys,
    host,
    sessions: createSessionTools(files),
    issuer: settings.issuer,
  };
}
