import type Provider from 'oidc-provider';
import type { Client, KoaContextWithOIDC } from 'oidc-provider';
import { adminClientMetadata, adminUrls } from '../admin/admin-client.ts';
import { createSetupGate, type SetupGate } from '../admin/setup.ts';
import type { Database } from '../db/client.ts';
import { createDataSet, type DataSet } from '../db/data-set.ts';
import { createWriteQueue, type DataDocument, type DocumentStore, openDocument } from '../db/document.ts';
import {
  ADMIN_SESSIONS_DOCUMENT,
  APIS_DOCUMENT,
  BRANDING_DOCUMENT,
  CLIENTS_DOCUMENT,
  DOCUMENT_FILES,
  FACTORS_DOCUMENT,
  KEYS_DOCUMENT,
  MAIL_DOCUMENT,
  PAIRINGS_DOCUMENT,
  PASSWORD_LINKS_DOCUMENT,
  PROTECTED_SITES_DOCUMENT,
  PROXY_SESSIONS_DOCUMENT,
  SETTINGS_DOCUMENT,
  UPSTREAMS_DOCUMENT,
  USERS_DOCUMENT,
} from '../db/documents.ts';
import { forwardAuthUrls, proxyClientMetadata } from '../forward-auth/client.ts';
import type { ForwardAuthConfig } from '../forward-auth/routes.ts';
import { createMailer, type Mailer, type MailTransportFactory, smtpTransport } from '../mail/mailer.ts';
import { sendNotifications } from '../mail/notifications.ts';
import { createAdapterFactory, openModelDocuments } from '../oidc/adapter.ts';
import { recordProviderEvents } from '../oidc/audit-events.ts';
import { createLogoutNotifier } from '../oidc/backchannel.ts';
import { createProviderHost, type ProviderHost } from '../oidc/host.ts';
import { createPairingOffers, type PairingOffers } from '../oidc/pairing-offers.ts';
import { claimNamesIn, createProvider, SCOPES } from '../oidc/provider.ts';
import { createSessionTools, type SessionTools } from '../oidc/sessions.ts';
import { type AdminSessionStore, createAdminSessionStore } from '../store/admin-sessions.ts';
import { type ApiStore, createApiStore } from '../store/apis.ts';
import { type AuditLog, AuditTargetKind, AuditType, KEYS_TARGET, openAuditLog } from '../store/audit.ts';
import {
  type BackupLayout,
  type BackupOptions,
  createBackup,
  filesToRestore,
  type RestoreSummary,
  readBackup,
} from '../store/backup.ts';
import { type BrandingStore, createBrandingStore } from '../store/branding.ts';
import { type ClientStore, clientSecretsIn, createClientStore } from '../store/clients.ts';
import { createFactorStore, type FactorStore, factorSecretsIn } from '../store/factors.ts';
import { type KeyStore, openKeyStore, privateKeysIn } from '../store/keys.ts';
import { createMailStore, type MailServer, mailSecretsIn } from '../store/mail.ts';
import { createPairingStore, type PairingStore } from '../store/pairings.ts';
import { createPasswordLinkStore, type PasswordLinkStore } from '../store/password-links.ts';
import { createProtectedSiteStore, type ProtectedSiteStore } from '../store/protected-sites.ts';
import { createProxySessionStore, type ProxySessionStore } from '../store/proxy-sessions.ts';
import { checkSecrets, openSealedDocument } from '../store/sealed-document.ts';
import { createSettingsStore, type SettingsStore } from '../store/settings.ts';
import { createUpstreamStore, type UpstreamStore, upstreamSecretsIn } from '../store/upstreams.ts';
import { createUserStore, type UserStore } from '../store/users.ts';
import { createUpstreamClient } from '../upstream/client.ts';
import { createUpstreamFlows, type UpstreamFlows } from '../upstream/flows.ts';
import type { ObjectStorage } from './object-storage.ts';
import { createPasswordPolicy, type FetchRange, type PasswordPolicy } from './password-policy.ts';
import { createProfilePictures, type ProfilePictures } from './pictures.ts';
import { createSecretBox, type SecretKeys } from './secret-box.ts';

/**
 * What a backup leaves out or needs. Every other store's file is taken, so a new store is backed up without being
 * listed here.
 */
export const BACKUP_LAYOUT: BackupLayout = Object.freeze({
  /** The web app's sessions: a restore signs everyone out rather than bringing back sessions from the backup. */
  skipped: Object.freeze([DOCUMENT_FILES.adminSessions, DOCUMENT_FILES.proxySessions]),
  required: Object.freeze([DOCUMENT_FILES.keys]),
});

/** Backs the data up and puts a backup back, from the running server. */
export interface DataBackup {
  /** Whether secrets are sealed under `SECRET_KEY`, and so stay sealed in a backup. */
  isSealed: boolean;
  /**
   * Makes an archive of the data as it is once every change made so far is saved.
   *
   * @param options - Whether to take the provider's sessions and tokens.
   * @returns The gzipped archive.
   */
  create: (options: BackupOptions) => Promise<Buffer>;
  /**
   * Checks an archive, puts its data back in one transaction, reads every store again and rebuilds the provider.
   * Everyone signed in to the web app is signed out.
   *
   * @param archive - The gzipped archive.
   * @returns What was put back.
   * @throws BackupError when the archive is refused; nothing is written then.
   */
  restore: (archive: Buffer) => Promise<RestoreSummary>;
}

/** Where the services keep their data and how the provider is reached. */
export interface ServiceSettings {
  /** The database, migrated. */
  database: Database;
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
  /** Fetches paired apps' protected resource metadata. Unset, the global `fetch`. */
  fetchPairing?: typeof globalThis.fetch;
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
  /** The database, which the GraphQL schema's generated reads query. */
  db: Database;
  /** Everything kept, as files: backups, restores and the import from an older data directory. */
  dataSet: DataSet;
  /**
   * Waits for every change made so far to be saved, or to fail.
   *
   * @returns Once they have.
   */
  settled: () => Promise<void>;
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
  /** What paired apps offer to set up besides their sign-in. */
  pairingOffers: PairingOffers;
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
  /** Backups of the data. */
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
 * Opens every store's data and builds the provider on it. Keys are made on first use and rotated at boot once they are
 * `KEY_DEFAULTS.rotationDays` old. The admin UI is a built-in client of the provider.
 *
 * @param settings - The database, the issuer and the secret key.
 * @returns The stores and the provider.
 * @throws SecretKeyError when the stored secrets don't open with the key, or are sealed and no key is set. Nothing is
 * written then.
 */
export async function openServices(settings: ServiceSettings): Promise<Services> {
  const db = settings.database;
  const store: DocumentStore = { db, queue: createWriteQueue() };
  const sealingKeys = settings.secretKeys ?? null;
  const box = sealingKeys === null ? null : createSecretBox(sealingKeys);
  // Every store's document, read again after a restore puts other data in the tables.
  const reloads: Array<() => Promise<void>> = [];
  /**
   * Opens a document and remembers it, so a restore reads it again.
   *
   * @param document - The document the store is built on: the sealed one, for a store with secrets.
   * @returns The same document.
   */
  const tracked = <T>(document: DataDocument<T>): DataDocument<T> => {
    reloads.push(document.reload);
    return document;
  };
  // Every sealed document is checked against the key before any is re-sealed.
  const clientDocument = await openDocument(store, CLIENTS_DOCUMENT);
  const keyDocument = await openDocument(store, KEYS_DOCUMENT);
  const factorDocument = await openDocument(store, FACTORS_DOCUMENT);
  const upstreamDocument = await openDocument(store, UPSTREAMS_DOCUMENT);
  const mailDocument = await openDocument(store, MAIL_DOCUMENT);
  checkSecrets(clientDocument.read(), box, clientSecretsIn);
  checkSecrets(keyDocument.read(), box, privateKeysIn);
  checkSecrets(factorDocument.read(), box, factorSecretsIn);
  checkSecrets(upstreamDocument.read(), box, upstreamSecretsIn);
  checkSecrets(mailDocument.read(), box, mailSecretsIn);
  const providerSettings = createSettingsStore(tracked(await openDocument(store, SETTINGS_DOCUMENT)), settings.issuer);
  const clients = createClientStore(tracked(await openSealedDocument(clientDocument, box, clientSecretsIn)), {
    allowsHttpRedirects: () => providerSettings.httpRedirects().isAllowed,
    // A removed client, by an admin or by an app's own RFC 7592 delete, is taken off every API.
    onRemove: (clientId) => apis.removeClient(clientId),
  });
  const apis: ApiStore = createApiStore(tracked(await openDocument(store, APIS_DOCUMENT)), {
    clientExists: (clientId) => clients.find(clientId) !== null,
    reservedScopes: SCOPES,
  });
  const users = createUserStore(tracked(await openDocument(store, USERS_DOCUMENT)));
  const pictures = createProfilePictures({
    storage: settings.objectStorage ?? null,
    users,
    base: adminUrls(settings.issuer).base,
  });
  const factors = createFactorStore(
    tracked(await openSealedDocument(factorDocument, box, factorSecretsIn)),
    settings.now,
  );
  const audit = openAuditLog(store, settings.now);
  const now = settings.now ?? Date.now;
  const upstreams = createUpstreamStore(tracked(await openSealedDocument(upstreamDocument, box, upstreamSecretsIn)), {
    now: () => new Date(now()),
    allowsHttp: () => providerSettings.httpRedirects().isAllowed,
  });
  const upstreamFlows = createUpstreamFlows({
    upstreams,
    client: createUpstreamClient({ fetch: settings.fetchUpstream ?? globalThis.fetch, now }),
    issuer: settings.issuer,
    now,
  });
  const keys = await openKeyStore(
    tracked(await openSealedDocument(keyDocument, box, privateKeysIn)),
    () => new Date(now()),
  );
  if (keys.isDue()) {
    const rotated = await keys.rotate();
    audit.record({
      type: AuditType.KeysRotated,
      actor: null,
      ip: null,
      target: KEYS_TARGET,
      detail: { kid: rotated.jwks[0]?.kid ?? '', reason: 'scheduled' },
    });
  }
  const adminSessions = createAdminSessionStore(tracked(await openDocument(store, ADMIN_SESSIONS_DOCUMENT)));
  const passwordLinks = createPasswordLinkStore(tracked(await openDocument(store, PASSWORD_LINKS_DOCUMENT)));
  const pairings = createPairingStore(tracked(await openDocument(store, PAIRINGS_DOCUMENT)), settings.now);
  const branding = createBrandingStore(tracked(await openDocument(store, BRANDING_DOCUMENT)));
  const mail = createMailer({
    store: createMailStore(tracked(await openSealedDocument(mailDocument, box, mailSecretsIn))),
    envServer: settings.mailServer ?? null,
    transport: settings.mailTransport ?? smtpTransport,
    branding,
    audit,
  });
  sendNotifications({ audit, mailer: mail, users, branding });
  const protectedSites = createProtectedSiteStore(tracked(await openDocument(store, PROTECTED_SITES_DOCUMENT)), {
    issuerHost: forwardAuthUrls(settings.issuer).host,
    now,
  });
  const proxySessions = createProxySessionStore(tracked(await openDocument(store, PROXY_SESSIONS_DOCUMENT)), now);
  const environmentCookieDomain = settings.proxyCookieDomain ?? null;
  const forwardAuth: ForwardAuthConfig = {
    cookieDomain: () => environmentCookieDomain ?? protectedSites.cookieDomain(),
    environmentCookieDomain,
    trustedProxies: settings.trustedProxies ?? null,
  };
  const models = await openModelDocuments(store);
  const adapter = createAdapterFactory({
    models,
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
            // As the store names it now; the provider passes an update the client as it was before.
            name: clients.find(client.clientId)?.name ?? client.clientName ?? client.clientId,
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
  const dataSet = createDataSet(store);
  const backup: DataBackup = {
    isSealed: box !== null,
    create: async (options) => {
      const files = await dataSet.exportFiles({ ...options, skipped: BACKUP_LAYOUT.skipped });
      return createBackup(files, BACKUP_LAYOUT, options, settings.now);
    },
    restore: async (archive) => {
      const checked = readBackup(archive, BACKUP_LAYOUT, box);
      const { files, summary } = filesToRestore(BACKUP_LAYOUT, checked);
      await dataSet.replaceAll(files);
      for (const reload of reloads) {
        await reload();
      }
      await models.reload();
      host.rebuild();
      return summary;
    },
  };
  return {
    db,
    dataSet,
    settled: () => store.queue.run(async () => {}),
    clients,
    users,
    apis,
    factors,
    upstreams,
    upstreamFlows,
    adminSessions,
    passwordLinks,
    pairings,
    pairingOffers: createPairingOffers({
      issuer: settings.issuer,
      reservedScopes: SCOPES,
      fetch: settings.fetchPairing ?? globalThis.fetch,
      now,
    }),
    branding,
    settings: providerSettings,
    passwordPolicy: createPasswordPolicy(providerSettings.passwordRules, {}, settings.fetchRange),
    audit,
    setup,
    keys,
    host,
    sessions: createSessionTools(models, createLogoutNotifier(host, { audit, users, clients })),
    backup,
    pictures,
    issuer: settings.issuer,
    mail,
    protectedSites,
    proxySessions,
    forwardAuth,
  };
}
