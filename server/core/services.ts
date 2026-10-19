import path from 'node:path';
import type Provider from 'oidc-provider';
import type { Client, KoaContextWithOIDC } from 'oidc-provider';
import { adminClientMetadata, adminUrls } from '../admin/admin-client.ts';
import { createSetupGate, type SetupGate } from '../admin/setup.ts';
import { forwardAuthUrls, proxyClientMetadata } from '../forward-auth/client.ts';
import type { ForwardAuthConfig } from '../forward-auth/routes.ts';
import { createMailer, type Mailer, type MailTransportFactory, smtpTransport } from '../mail/mailer.ts';
import { sendNotifications } from '../mail/notifications.ts';
import { createAdapterFactory, createModelFiles } from '../oidc/adapter.ts';
import { recordProviderEvents } from '../oidc/audit-events.ts';
import { createLogoutNotifier } from '../oidc/backchannel.ts';
import { createProviderHost, type ProviderHost } from '../oidc/host.ts';
import { claimNamesIn, createProvider, SCOPES } from '../oidc/provider.ts';
import { createSessionTools, type SessionTools } from '../oidc/sessions.ts';
import { type AdminSessionDocument, type AdminSessionStore, createAdminSessionStore } from '../store/admin-sessions.ts';
import { type Api, type ApiStore, createApiStore } from '../store/apis.ts';
import { type AuditLog, AuditTargetKind, AuditType, KEYS_TARGET, openAuditLog } from '../store/audit.ts';
import {
  type BackupLayout,
  type BackupOptions,
  createBackup,
  type RestoreSummary,
  readBackup,
  restoreBackup,
} from '../store/backup.ts';
import { type Branding, type BrandingStore, createBrandingStore } from '../store/branding.ts';
import { type ClientStore, clientSecretsIn, createClientStore, type OidcClient } from '../store/clients.ts';
import { createFactorStore, type FactorStore, type FactorsDocument, factorSecretsIn } from '../store/factors.ts';
import { type JsonFile, openJsonFile } from '../store/json-file.ts';
import { type KeyStore, openKeyStore, type ProviderKeys, privateKeysIn } from '../store/keys.ts';
import { createMailStore, type MailDocument, type MailServer, mailSecretsIn } from '../store/mail.ts';
import { createPairingStore, type PairingDocument, type PairingStore } from '../store/pairings.ts';
import { createPasswordLinkStore, type PasswordLinkDocument, type PasswordLinkStore } from '../store/password-links.ts';
import {
  createProtectedSiteStore,
  EMPTY_PROTECTED_SITES,
  type ProtectedSiteStore,
  type ProtectedSitesDocument,
} from '../store/protected-sites.ts';
import { createProxySessionStore, type ProxySessionDocument, type ProxySessionStore } from '../store/proxy-sessions.ts';
import { openSealedFile } from '../store/sealed-file.ts';
import { createSettingsStore, type SettingsDocument, type SettingsStore } from '../store/settings.ts';
import {
  createUpstreamStore,
  EMPTY_UPSTREAMS,
  type UpstreamStore,
  type UpstreamsDocument,
  upstreamSecretsIn,
} from '../store/upstreams.ts';
import { createUserStore, type User, type UserStore } from '../store/users.ts';
import { createUpstreamClient } from '../upstream/client.ts';
import { createUpstreamFlows, type UpstreamFlows } from '../upstream/flows.ts';
import type { ObjectStorage } from './object-storage.ts';
import { createPasswordPolicy, type FetchRange, type PasswordPolicy } from './password-policy.ts';
import { createProfilePictures, type ProfilePictures } from './pictures.ts';
import { createSecretBox, type SecretKeys } from './secret-box.ts';

/** The files under the data directory. */
export const DATA_FILES = {
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
  /** Upstream sign-in providers (client secrets sealed) and the identities linked to users. */
  upstreams: 'upstreams.json',
  /** The APIs (resource servers) apps ask for access tokens to. */
  apis: 'apis.json',
  /** JSON lines, rotated by size into `audit.1.jsonl` and so on. */
  audit: 'audit.jsonl',
  /** A directory: one file per provider model (sessions, codes, tokens...). */
  oidc: 'oidc',
  /** The SMTP server saved under Settings (password sealed) and the email options. */
  mail: 'mail.json',
  /** The sites forward auth protects, and the proxy cookie's domain. */
  protectedSites: 'protected-sites.json',
  /** Forward auth sessions, by the hash of their token. */
  proxySessions: 'proxy-sessions.json',
} as const;

/**
 * What a backup leaves out or needs. Every other data file under the data directory is taken, so a new store is
 * backed up without being listed here.
 */
export const BACKUP_LAYOUT: BackupLayout = Object.freeze({
  sessionsDir: DATA_FILES.oidc,
  /** The web app's sessions: a restore signs everyone out rather than bringing back sessions from the backup. */
  skipped: Object.freeze([DATA_FILES.adminSessions, DATA_FILES.proxySessions]),
  required: Object.freeze([DATA_FILES.keys]),
});

/** Backs the data directory up and puts a backup back, from the running server. */
export interface DataBackup {
  /** Whether secrets are sealed under `SECRET_KEY`, and so stay sealed in a backup. */
  isSealed: boolean;
  /**
   * Makes an archive of the data directory as it is now.
   *
   * @param options - Whether to take the provider's sessions and tokens.
   * @returns The gzipped archive.
   */
  create: (options: BackupOptions) => Buffer;
  /**
   * Checks an archive, swaps its files in, reads every store again and rebuilds the provider. Everyone signed in to
   * the web app is signed out.
   *
   * @param archive - The gzipped archive.
   * @returns What was put back.
   * @throws BackupError when the archive is refused; nothing is written then.
   */
  restore: (archive: Buffer) => RestoreSummary;
}

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
  /** Makes the requests to upstream sign-in providers. Unset, the global `fetch`. */
  fetchUpstream?: typeof globalThis.fetch;
  /** The SMTP server `SMTP_URL` or `SMTP_HOST` sets, which wins over Settings. Unset or null, Settings decides. */
  mailServer?: MailServer | null;
  /** Sends email. Unset, nodemailer over SMTP. */
  mailTransport?: MailTransportFactory;
  /** The S3 bucket profile pictures are kept in. Unset or null, pictures are off. */
  objectStorage?: ObjectStorage | null;
  /** `FORWARD_AUTH_COOKIE_DOMAIN`, which wins over the admin's choice. Unset or null leaves it to the admin. */
  proxyCookieDomain?: string | null;
  /** `FORWARD_AUTH_TRUSTED_PROXIES`. Unset or null falls back to `TRUST_PROXY` and loopback. */
  trustedProxies?: readonly string[] | null;
}

/** Everything the HTTP app is built from. */
export interface Services {
  clients: ClientStore;
  users: UserStore;
  /** The APIs apps ask for access tokens to with a resource indicator. */
  apis: ApiStore;
  /** Each user's second factors. */
  factors: FactorStore;
  /** Providers users may sign in through, such as Google or GitHub, and the identities linked to users. */
  upstreams: UpstreamStore;
  /** The upstream sign-ins and links under way. */
  upstreamFlows: UpstreamFlows;
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
  /** Backups of the data directory. */
  backup: DataBackup;
  /** Profile pictures, kept in the S3 bucket; off without one. */
  pictures: ProfilePictures;
  issuer: string;
  /** Sends invite and reset links, the forgot-password link and notifications, once SMTP is set up. */
  mail: Mailer;
  /** The sites behind the reverse proxy that forward auth protects. */
  protectedSites: ProtectedSiteStore;
  /** The forward auth sessions the verify endpoint reads. */
  proxySessions: ProxySessionStore;
  /** Forward auth's cookie domain and trusted proxies. */
  forwardAuth: ForwardAuthConfig;
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
  // Every store's file, read again after a restore swaps the files under them.
  const reloads: Array<() => void> = [];
  /**
   * Remembers a store's file so a restore reads it again.
   *
   * @param file - The file the store is built on: the sealed one, for a store with secrets.
   * @returns The same file.
   */
  const tracked = <T>(file: JsonFile<T>): JsonFile<T> => {
    reloads.push(file.reload);
    return file;
  };
  // Every sealed file is opened, and so checked against the key, before any is re-sealed.
  const clientFile = openJsonFile<OidcClient[]>(at(DATA_FILES.clients), []);
  const keyFile = openJsonFile<ProviderKeys | null>(at(DATA_FILES.keys), null);
  const factorFile = openJsonFile<FactorsDocument>(at(DATA_FILES.factors), {});
  const upstreamFile = openJsonFile<UpstreamsDocument>(at(DATA_FILES.upstreams), EMPTY_UPSTREAMS);
  const mailFile = openJsonFile<MailDocument>(at(DATA_FILES.mail), {});
  if (box !== null) {
    clientSecretsIn(clientFile.read(), box.open);
    privateKeysIn(keyFile.read(), box.open);
    factorSecretsIn(factorFile.read(), box.open);
    upstreamSecretsIn(upstreamFile.read(), box.open);
    mailSecretsIn(mailFile.read(), box.open);
  }
  const providerSettings = createSettingsStore(
    tracked(openJsonFile<SettingsDocument>(at(DATA_FILES.settings), {})),
    settings.issuer,
  );
  const clients = createClientStore(tracked(openSealedFile(clientFile, box, clientSecretsIn)), {
    allowsHttpRedirects: () => providerSettings.httpRedirects().isAllowed,
    // A removed client, by an admin or by an app's own RFC 7592 delete, is taken off every API.
    onRemove: (clientId) => apis.removeClient(clientId),
  });
  const apis: ApiStore = createApiStore(tracked(openJsonFile<Api[]>(at(DATA_FILES.apis), [])), {
    clientExists: (clientId) => clients.find(clientId) !== null,
    reservedScopes: SCOPES,
  });
  const users = createUserStore(tracked(openJsonFile<User[]>(at(DATA_FILES.users), [])));
  const pictures = createProfilePictures({
    storage: settings.objectStorage ?? null,
    users,
    base: adminUrls(settings.issuer).base,
  });
  const factors = createFactorStore(tracked(openSealedFile(factorFile, box, factorSecretsIn)), settings.now);
  const audit = openAuditLog(at(DATA_FILES.audit), settings.now);
  const now = settings.now ?? Date.now;
  const upstreams = createUpstreamStore(tracked(openSealedFile(upstreamFile, box, upstreamSecretsIn)), {
    now: () => new Date(now()),
    allowsHttp: () => providerSettings.httpRedirects().isAllowed,
  });
  const upstreamFlows = createUpstreamFlows({
    upstreams,
    client: createUpstreamClient({ fetch: settings.fetchUpstream ?? globalThis.fetch, now }),
    issuer: settings.issuer,
    now,
  });
  const keys = openKeyStore(tracked(openSealedFile(keyFile, box, privateKeysIn)), () => new Date(now()));
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
  const adminSessions = createAdminSessionStore(
    tracked(openJsonFile<AdminSessionDocument>(at(DATA_FILES.adminSessions), {})),
  );
  const passwordLinks = createPasswordLinkStore(
    tracked(openJsonFile<PasswordLinkDocument>(at(DATA_FILES.passwordLinks), {})),
  );
  const pairings = createPairingStore(
    tracked(openJsonFile<PairingDocument>(at(DATA_FILES.pairings), {})),
    settings.now,
  );
  const branding = createBrandingStore(tracked(openJsonFile<Partial<Branding>>(at(DATA_FILES.branding), {})));
  const mail = createMailer({
    store: createMailStore(tracked(openSealedFile(mailFile, box, mailSecretsIn))),
    envServer: settings.mailServer ?? null,
    transport: settings.mailTransport ?? smtpTransport,
    branding,
    audit,
  });
  sendNotifications({ audit, mailer: mail, users, branding });
  const protectedSites = createProtectedSiteStore(
    tracked(openJsonFile<ProtectedSitesDocument>(at(DATA_FILES.protectedSites), EMPTY_PROTECTED_SITES)),
    { issuerHost: forwardAuthUrls(settings.issuer).host, now },
  );
  const proxySessions = createProxySessionStore(
    tracked(openJsonFile<ProxySessionDocument>(at(DATA_FILES.proxySessions), {})),
    now,
  );
  const environmentCookieDomain = settings.proxyCookieDomain ?? null;
  const forwardAuth: ForwardAuthConfig = {
    cookieDomain: () => environmentCookieDomain ?? protectedSites.cookieDomain(),
    environmentCookieDomain,
    trustedProxies: settings.trustedProxies ?? null,
  };
  const files = createModelFiles(at(DATA_FILES.oidc));
  const adapter = createAdapterFactory({
    files,
    clients,
    builtInClients: [adminClientMetadata(settings.issuer), proxyClientMetadata(settings.issuer)],
  });
  const build = (): Provider => {
    const provider = createProvider({
      issuer: settings.issuer,
      clients,
      users,
      apis,
      pairings,
      settings: providerSettings,
      keys: keys.current(),
      adapter,
      isProxied: settings.isProxied,
      claimNames: claimNamesIn(users, clients),
      pictureUrlOf: pictures.urlOf,
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
  const backup: DataBackup = {
    isSealed: box !== null,
    create: (options) => createBackup(settings.dataDir, BACKUP_LAYOUT, options, settings.now),
    restore: (archive) => {
      const checked = readBackup(archive, BACKUP_LAYOUT, box);
      const summary = restoreBackup(settings.dataDir, BACKUP_LAYOUT, checked);
      for (const reload of reloads) {
        reload();
      }
      files.reload();
      host.rebuild();
      return summary;
    },
  };
  return {
    clients,
    users,
    apis,
    factors,
    upstreams,
    upstreamFlows,
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
    sessions: createSessionTools(files, createLogoutNotifier(host, { audit, users, clients })),
    backup,
    pictures,
    issuer: settings.issuer,
    mail,
    protectedSites,
    proxySessions,
    forwardAuth,
  };
}
