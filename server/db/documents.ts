// How each store's document is laid out in the tables, and back. Each mapping also reads the file a version before the
// database wrote, for the first import and for a restore from an older backup, so it fills in what an older file
// lacks the way the store did when it read one.
import { eq } from 'drizzle-orm';
import type { AdapterPayload } from 'oidc-provider';
import type { ModelDocument } from '../oidc/adapter.ts';
import type { Api } from '../store/apis.ts';
import type { Branding } from '../store/branding.ts';
import { DEFAULT_GROUPS_CLAIM } from '../store/claims.ts';
import { CLIENT_SOURCE_ADMIN, type OidcClient } from '../store/clients.ts';
import type { FactorsDocument, UserFactors } from '../store/factors.ts';
import type { ProviderKeys } from '../store/keys.ts';
import type { MailDocument } from '../store/mail.ts';
import type { PairingDocument } from '../store/pairings.ts';
import type { PasswordLinkDocument } from '../store/password-links.ts';
import { EMPTY_PROTECTED_SITES, type ProtectedSitesDocument } from '../store/protected-sites.ts';
import type { ProxySessionDocument } from '../store/proxy-sessions.ts';
import type { SettingsDocument } from '../store/settings.ts';
import { EMPTY_UPSTREAMS, UnknownIdentity, type UpstreamsDocument } from '../store/upstreams.ts';
import type { User } from '../store/users.ts';
import type { WebSessionDocument } from '../store/web-sessions.ts';
import { type DocumentMapping, type LooseMapping, loosen } from './document.ts';
import {
  apiClients,
  apis,
  clients,
  documents,
  oidcModels,
  pairings,
  passkeys,
  passwordLinks,
  protectedSites,
  proxySessions,
  recoveryCodes,
  totpFactors,
  upstreamGroupMappings,
  upstreamLinks,
  upstreams,
  users,
  webSessions,
} from './schema.ts';

/**
 * The documents' names: the concept each one holds. The documents table keys a single document by its name, and a
 * backup archive keeps each document as a JSON file named after it (`archivePathOf`). Until 2026-10-23 the names were
 * the files the data directory held before the database (`keys.json`, `admin-sessions.json`); the `document_names`
 * migration renamed the rows.
 */
export const DOCUMENT_NAMES = {
  clients: 'clients',
  users: 'users',
  keys: 'keys',
  webSessions: 'web-sessions',
  passwordLinks: 'password-links',
  branding: 'branding',
  pairings: 'pairings',
  settings: 'settings',
  factors: 'factors',
  upstreams: 'upstreams',
  apis: 'apis',
  mail: 'mail',
  protectedSites: 'protected-sites',
  proxySessions: 'proxy-sessions',
} as const;

/** The directory oidc-provider's models were kept in, one file per model. */
export const OIDC_DIRECTORY = 'oidc';
/** What a document's file in an archive or an older data directory is called after its name. */
const JSON_EXTENSION = '.json';

/**
 * Says where a document is in a backup archive, which is also the file an older data directory kept it in.
 *
 * @param name - The document's name, such as `keys` or `oidc/Session`.
 * @returns Its path, such as `keys.json`.
 */
export function archivePathOf(name: string): string {
  return `${name}${JSON_EXTENSION}`;
}

/**
 * Reads an instant a document keeps as an ISO 8601 string.
 *
 * @param iso - The string.
 * @returns The instant.
 */
const toDate = (iso: string): Date => new Date(iso);

/**
 * Reads an instant a document keeps as an ISO 8601 string, or null.
 *
 * @param iso - The string, or null.
 * @returns The instant, or null.
 */
const toDateOrNull = (iso: string | null | undefined): Date | null =>
  iso === null || iso === undefined ? null : new Date(iso);

/**
 * Writes an instant as a document keeps it.
 *
 * @param date - The instant.
 * @returns It as an ISO 8601 string.
 */
const toIso = (date: Date): string => date.toISOString();

/**
 * Writes an instant as a document keeps it, or null.
 *
 * @param date - The instant, or null.
 * @returns It as an ISO 8601 string, or null.
 */
const toIsoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Orders rows oldest first, as the stores listed them.
 *
 * @typeParam R - The rows.
 * @param rows - Rows with a creation time and a key.
 * @param keyOf - Their key, which breaks a tie.
 * @returns The rows, oldest first.
 */
function oldestFirst<R extends { createdAt: Date }>(rows: readonly R[], keyOf: (row: R) => string): R[] {
  return rows.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || keyOf(a).localeCompare(keyOf(b)));
}

/**
 * Orders rows by the position they were saved at.
 *
 * @typeParam R - The rows.
 * @param rows - Rows with a position.
 * @returns The rows in order.
 */
function byPosition<R extends { position: number }>(rows: readonly R[]): R[] {
  return rows.toSorted((a, b) => a.position - b.position);
}

/**
 * Lays out a document that is one row of `documents`.
 *
 * @typeParam T - The document's shape.
 * @param name - Its name, which is its row's name.
 * @param fallback - The document a new install starts with. A null document has no row.
 * @returns The mapping.
 */
function singleDocument<T>(name: string, fallback: T): DocumentMapping<T, readonly [typeof documents]> {
  return {
    name,
    fallback,
    tables: [{ table: documents, keys: ['name'], scope: eq(documents.name, name) }],
    toRows: (document) => [document === null ? [] : [{ name, body: document }]],
    // The body is what toRows wrote: this document, as JSON.
    fromRows: ([rows]) => (rows[0]?.body as T | undefined) ?? fallback,
  };
}

export const USERS_DOCUMENT: DocumentMapping<User[], readonly [typeof users]> = {
  name: DOCUMENT_NAMES.users,
  fallback: [],
  tables: [{ table: users, keys: ['id'] }],
  toRows: (list) => [
    list.map((user) => ({
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash ?? '',
      email: user.email ?? '',
      name: user.name ?? '',
      groups: user.groups ?? [],
      claims: user.claims ?? {},
      disabled: user.disabled ?? false,
      createdAt: toDate(user.createdAt),
      pictureVersion: user.pictureVersion ?? null,
    })),
  ],
  fromRows: ([rows]) =>
    oldestFirst(rows, (row) => row.id).map((row) => ({
      id: row.id,
      username: row.username,
      passwordHash: row.passwordHash,
      email: row.email,
      name: row.name,
      groups: row.groups,
      claims: row.claims,
      disabled: row.disabled,
      createdAt: toIso(row.createdAt),
      pictureVersion: row.pictureVersion,
    })),
};

export const CLIENTS_DOCUMENT: DocumentMapping<OidcClient[], readonly [typeof clients]> = {
  name: DOCUMENT_NAMES.clients,
  fallback: [],
  tables: [{ table: clients, keys: ['clientId'] }],
  toRows: (list) => [
    list.map((client) => ({
      clientId: client.clientId,
      name: client.name,
      clientSecret: client.clientSecret ?? null,
      authMethod: client.authMethod,
      redirectUris: client.redirectUris ?? [],
      postLogoutRedirectUris: client.postLogoutRedirectUris ?? [],
      allowedGroups: client.allowedGroups ?? [],
      groupsClaim: client.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      allowClientCredentials: client.allowClientCredentials ?? false,
      allowDeviceFlow: client.allowDeviceFlow ?? false,
      source: client.source ?? CLIENT_SOURCE_ADMIN,
      logoUri: client.logoUri ?? null,
      accessTokenSeconds: client.tokenLifetimes?.accessTokenSeconds ?? null,
      idTokenSeconds: client.tokenLifetimes?.idTokenSeconds ?? null,
      refreshTokenSeconds: client.tokenLifetimes?.refreshTokenSeconds ?? null,
      backchannelLogoutUri: client.backchannelLogoutUri ?? null,
      backchannelLogoutSessionRequired: client.backchannelLogoutSessionRequired ?? true,
      preset: client.preset ?? null,
      pairingId: client.pairingId ?? null,
      clientUri: client.clientUri ?? null,
      createdAt: toDate(client.createdAt),
    })),
  ],
  fromRows: ([rows]) =>
    oldestFirst(rows, (row) => row.clientId).map((row) => ({
      clientId: row.clientId,
      name: row.name,
      clientSecret: row.clientSecret,
      authMethod: row.authMethod,
      redirectUris: row.redirectUris,
      postLogoutRedirectUris: row.postLogoutRedirectUris,
      allowedGroups: row.allowedGroups,
      groupsClaim: row.groupsClaim,
      allowClientCredentials: row.allowClientCredentials,
      allowDeviceFlow: row.allowDeviceFlow,
      source: row.source,
      logoUri: row.logoUri,
      tokenLifetimes: {
        accessTokenSeconds: row.accessTokenSeconds,
        idTokenSeconds: row.idTokenSeconds,
        refreshTokenSeconds: row.refreshTokenSeconds,
      },
      backchannelLogoutUri: row.backchannelLogoutUri,
      backchannelLogoutSessionRequired: row.backchannelLogoutSessionRequired,
      preset: row.preset,
      pairingId: row.pairingId,
      clientUri: row.clientUri,
      createdAt: toIso(row.createdAt),
    })),
};

export const APIS_DOCUMENT: DocumentMapping<Api[], readonly [typeof apis, typeof apiClients]> = {
  name: DOCUMENT_NAMES.apis,
  fallback: [],
  tables: [
    { table: apis, keys: ['identifier'] },
    { table: apiClients, keys: ['apiIdentifier', 'clientId'] },
  ],
  toRows: (list) => [
    list.map((api) => ({
      identifier: api.identifier,
      name: api.name,
      scopes: api.scopes ?? [],
      tokenFormat: api.tokenFormat,
      accessTokenSeconds: api.accessTokenSeconds ?? null,
      createdAt: toDate(api.createdAt),
    })),
    list.flatMap((api) =>
      [...new Set(api.allowedClientIds ?? [])].map((clientId, position) => ({
        apiIdentifier: api.identifier,
        clientId,
        position,
      })),
    ),
  ],
  fromRows: ([rows, allowed]) =>
    oldestFirst(rows, (row) => row.identifier).map((row) => ({
      identifier: row.identifier,
      name: row.name,
      scopes: row.scopes,
      tokenFormat: row.tokenFormat,
      accessTokenSeconds: row.accessTokenSeconds,
      allowedClientIds: byPosition(allowed.filter((each) => each.apiIdentifier === row.identifier)).map(
        (each) => each.clientId,
      ),
      createdAt: toIso(row.createdAt),
    })),
};

export const UPSTREAMS_DOCUMENT: DocumentMapping<
  UpstreamsDocument,
  readonly [typeof upstreams, typeof upstreamGroupMappings, typeof upstreamLinks]
> = {
  name: DOCUMENT_NAMES.upstreams,
  fallback: EMPTY_UPSTREAMS,
  tables: [
    { table: upstreams, keys: ['id'] },
    { table: upstreamGroupMappings, keys: ['upstreamId', 'position'] },
    { table: upstreamLinks, keys: ['providerId', 'issuer', 'subject'] },
  ],
  toRows: ({ providers = [], links = [] }) => [
    providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      issuer: provider.issuer ?? null,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret ?? null,
      scopes: provider.scopes ?? [],
      unknownIdentity: provider.unknownIdentity ?? UnknownIdentity.Refuse,
      createDomains: provider.createDomains ?? [],
      createGroups: provider.createGroups ?? [],
      countsAsBothFactors: provider.countsAsBothFactors ?? false,
      groupsClaim: provider.groupsClaim ?? null,
      createdAt: toDate(provider.createdAt),
    })),
    providers.flatMap((provider) =>
      (provider.groupMappings ?? []).map((mapping, position) => ({
        upstreamId: provider.id,
        position,
        upstream: mapping.upstream,
        local: mapping.local,
      })),
    ),
    // A link to a provider that is gone was removed with it; one an older version left behind is dropped.
    links
      .filter((link) => providers.some((provider) => provider.id === link.providerId))
      .map((link) => ({
        providerId: link.providerId,
        issuer: link.issuer,
        subject: link.subject,
        userId: link.userId,
        label: link.label,
        linkedAt: toDate(link.linkedAt),
        lastUsedAt: toDateOrNull(link.lastUsedAt),
      })),
  ],
  fromRows: ([providerRows, mappingRows, linkRows]) => ({
    providers: oldestFirst(providerRows, (row) => row.id).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      scopes: row.scopes,
      unknownIdentity: row.unknownIdentity,
      createDomains: row.createDomains,
      createGroups: row.createGroups,
      countsAsBothFactors: row.countsAsBothFactors,
      groupsClaim: row.groupsClaim,
      groupMappings: byPosition(mappingRows.filter((mapping) => mapping.upstreamId === row.id)).map(
        ({ upstream, local }) => ({ upstream, local }),
      ),
      createdAt: toIso(row.createdAt),
    })),
    links: linkRows
      .toSorted((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime())
      .map((row) => ({
        userId: row.userId,
        providerId: row.providerId,
        issuer: row.issuer,
        subject: row.subject,
        label: row.label,
        linkedAt: toIso(row.linkedAt),
        lastUsedAt: toIsoOrNull(row.lastUsedAt),
      })),
  }),
};

/** A user with no second factor of any kind, before their rows are read. */
const NO_FACTORS: Readonly<UserFactors> = Object.freeze({ totp: null, recoveryCodes: [], passkeys: [] });

export const FACTORS_DOCUMENT: DocumentMapping<
  FactorsDocument,
  readonly [typeof totpFactors, typeof recoveryCodes, typeof passkeys]
> = {
  name: DOCUMENT_NAMES.factors,
  fallback: {},
  tables: [
    { table: totpFactors, keys: ['userId'] },
    { table: recoveryCodes, keys: ['userId', 'codeHash'] },
    { table: passkeys, keys: ['id'] },
  ],
  toRows: (document) => {
    const entries = Object.entries(document);
    return [
      entries.flatMap(([userId, { totp }]) =>
        totp === null || totp === undefined
          ? []
          : [{ userId, secret: totp.secret, lastStep: totp.lastStep, createdAt: toDate(totp.createdAt) }],
      ),
      entries.flatMap(([userId, factors]) =>
        [...new Set(factors.recoveryCodes ?? [])].map((codeHash, position) => ({ userId, codeHash, position })),
      ),
      entries.flatMap(([userId, factors]) =>
        (factors.passkeys ?? []).map((passkey, position) => ({
          id: passkey.id,
          userId,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports ?? [],
          name: passkey.name,
          createdAt: toDate(passkey.createdAt),
          lastUsedAt: toDateOrNull(passkey.lastUsedAt),
          position,
        })),
      ),
    ];
  },
  fromRows: ([totpRows, codeRows, passkeyRows]) => {
    const document: FactorsDocument = {};
    const of = (userId: string): UserFactors => {
      const factors = document[userId] ?? { ...NO_FACTORS, recoveryCodes: [], passkeys: [] };
      document[userId] = factors;
      return factors;
    };
    for (const row of totpRows) {
      of(row.userId).totp = { secret: row.secret, lastStep: row.lastStep, createdAt: toIso(row.createdAt) };
    }
    for (const row of byPosition(codeRows)) {
      of(row.userId).recoveryCodes.push(row.codeHash);
    }
    for (const row of byPosition(passkeyRows)) {
      of(row.userId).passkeys.push({
        id: row.id,
        publicKey: row.publicKey,
        counter: row.counter,
        transports: row.transports,
        name: row.name,
        createdAt: toIso(row.createdAt),
        lastUsedAt: toIsoOrNull(row.lastUsedAt),
      });
    }
    return document;
  },
};

export const PAIRINGS_DOCUMENT: DocumentMapping<PairingDocument, readonly [typeof pairings]> = {
  name: DOCUMENT_NAMES.pairings,
  fallback: {},
  tables: [{ table: pairings, keys: ['id'] }],
  toRows: (document) => [
    Object.entries(document).map(([id, record]) => ({
      id,
      tokenHash: record.tokenHash,
      allowedGroups: record.allowedGroups ?? [],
      groupsClaim: record.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      expiresAt: new Date(record.expiresAt),
      clientId: record.clientId ?? null,
      clientUri: record.clientUri ?? null,
      deviceClientId: record.deviceClientId ?? null,
      isFinished: record.isFinished ?? false,
    })),
  ],
  fromRows: ([rows]) =>
    Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          tokenHash: row.tokenHash,
          allowedGroups: row.allowedGroups,
          groupsClaim: row.groupsClaim,
          expiresAt: row.expiresAt.getTime(),
          clientId: row.clientId,
          clientUri: row.clientUri,
          deviceClientId: row.deviceClientId,
          isFinished: row.isFinished,
        },
      ]),
    ),
};

/** Tokens kept by their hash, each naming a user until it expires: the password links and the web sessions. */
type HashedTokens = Record<string, { userId: string; expiresAt: number }>;

/** A hashed token's row, in either of their tables. */
interface HashedTokenRow {
  tokenHash: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Lays out hashed tokens as rows.
 *
 * @param document - The tokens, by hash.
 * @returns Their rows.
 */
function hashedTokenRows(document: HashedTokens): HashedTokenRow[] {
  return Object.entries(document).map(([tokenHash, { userId, expiresAt }]) => ({
    tokenHash,
    userId,
    expiresAt: new Date(expiresAt),
  }));
}

/**
 * Builds hashed tokens from their rows.
 *
 * @param rows - The rows.
 * @returns The tokens, by hash.
 */
function hashedTokensOf(rows: readonly HashedTokenRow[]): HashedTokens {
  return Object.fromEntries(
    rows.map((row) => [row.tokenHash, { userId: row.userId, expiresAt: row.expiresAt.getTime() }]),
  );
}

export const PASSWORD_LINKS_DOCUMENT: DocumentMapping<PasswordLinkDocument, readonly [typeof passwordLinks]> = {
  name: DOCUMENT_NAMES.passwordLinks,
  fallback: {},
  tables: [{ table: passwordLinks, keys: ['tokenHash'] }],
  toRows: (document) => [hashedTokenRows(document)],
  fromRows: ([rows]) => hashedTokensOf(rows),
};

export const WEB_SESSIONS_DOCUMENT: DocumentMapping<WebSessionDocument, readonly [typeof webSessions]> = {
  name: DOCUMENT_NAMES.webSessions,
  fallback: {},
  tables: [{ table: webSessions, keys: ['tokenHash'] }],
  toRows: (document) => [hashedTokenRows(document)],
  fromRows: ([rows]) => hashedTokensOf(rows),
};

export const PROXY_SESSIONS_DOCUMENT: DocumentMapping<ProxySessionDocument, readonly [typeof proxySessions]> = {
  name: DOCUMENT_NAMES.proxySessions,
  fallback: {},
  tables: [{ table: proxySessions, keys: ['tokenHash'] }],
  toRows: (document) => [
    Object.entries(document).map(([tokenHash, session]) => ({
      tokenHash,
      userId: session.userId,
      grantId: session.grantId,
      amr: session.amr ?? [],
      acr: session.acr,
      expiresAt: new Date(session.expiresAt),
      lastSeenAt: new Date(session.lastSeenAt),
    })),
  ],
  fromRows: ([rows]) =>
    Object.fromEntries(
      rows.map((row) => [
        row.tokenHash,
        {
          userId: row.userId,
          grantId: row.grantId,
          amr: row.amr,
          acr: row.acr,
          expiresAt: row.expiresAt.getTime(),
          lastSeenAt: row.lastSeenAt.getTime(),
        },
      ]),
    ),
};

/** The part of the protected sites document kept as one row: everything but the sites. */
const PROTECTED_SITES_SETTINGS = singleDocument<Omit<ProtectedSitesDocument, 'sites'>>(
  DOCUMENT_NAMES.protectedSites,
  {},
);

export const PROTECTED_SITES_DOCUMENT: DocumentMapping<
  ProtectedSitesDocument,
  readonly [typeof documents, typeof protectedSites]
> = {
  name: DOCUMENT_NAMES.protectedSites,
  fallback: EMPTY_PROTECTED_SITES,
  tables: [PROTECTED_SITES_SETTINGS.tables[0], { table: protectedSites, keys: ['id'] }],
  toRows: ({ sites = [], ...settings }) => [
    PROTECTED_SITES_SETTINGS.toRows(settings)[0],
    sites.map((site) => ({
      id: site.id,
      name: site.name,
      host: site.host,
      pathPrefix: site.pathPrefix ?? '',
      allowedGroups: site.allowedGroups ?? [],
      requireSecondFactor: site.requireSecondFactor ?? false,
      createdAt: toDate(site.createdAt),
    })),
  ],
  fromRows: ([settingRows, siteRows]) => ({
    ...PROTECTED_SITES_SETTINGS.fromRows([settingRows]),
    sites: oldestFirst(siteRows, (row) => row.id).map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      pathPrefix: row.pathPrefix,
      allowedGroups: row.allowedGroups,
      requireSecondFactor: row.requireSecondFactor,
      createdAt: toIso(row.createdAt),
    })),
  }),
};

export const KEYS_DOCUMENT = singleDocument<ProviderKeys | null>(DOCUMENT_NAMES.keys, null);
export const BRANDING_DOCUMENT = singleDocument<Partial<Branding>>(DOCUMENT_NAMES.branding, {});
export const SETTINGS_DOCUMENT = singleDocument<SettingsDocument>(DOCUMENT_NAMES.settings, {});
export const MAIL_DOCUMENT = singleDocument<MailDocument>(DOCUMENT_NAMES.mail, {});

/**
 * Lays out one oidc-provider model's entries.
 *
 * @param model - The model, such as `Session`.
 * @returns The mapping.
 */
export function oidcModelDocument(model: string): DocumentMapping<ModelDocument, readonly [typeof oidcModels]> {
  return {
    name: `${OIDC_DIRECTORY}/${model}`,
    fallback: {},
    tables: [{ table: oidcModels, keys: ['model', 'id'], scope: eq(oidcModels.model, model) }],
    toRows: (document) => [
      Object.entries(document).map(([id, entry]) => ({
        model,
        id,
        payload: entry.payload,
        expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
      })),
    ],
    fromRows: ([rows]) =>
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          // The payload is what oidc-provider handed the adapter, as toRows wrote it.
          {
            payload: row.payload as AdapterPayload,
            expiresAt: row.expiresAt === null ? null : row.expiresAt.getTime(),
          },
        ]),
      ),
  };
}

/**
 * Reads a model's name from its file in a backup or an older data directory.
 *
 * @param file - Such as `oidc/Session.json`.
 * @returns The model, or null for any other file.
 */
export function modelOfFile(file: string): string | null {
  const prefix = `${OIDC_DIRECTORY}/`;
  const isModel = file.startsWith(prefix) && file.endsWith(JSON_EXTENSION);
  if (isModel === false) {
    return null;
  }
  const model = file.slice(prefix.length, file.length - JSON_EXTENSION.length);
  return /^\w+$/.test(model) ? model : null;
}

/** Every store's document but the provider's models, which `oidcModelDocument` lays out one model at a time. */
export const DOCUMENT_MAPPINGS: readonly LooseMapping[] = [
  loosen(USERS_DOCUMENT),
  loosen(CLIENTS_DOCUMENT),
  loosen(APIS_DOCUMENT),
  loosen(UPSTREAMS_DOCUMENT),
  loosen(FACTORS_DOCUMENT),
  loosen(PAIRINGS_DOCUMENT),
  loosen(PASSWORD_LINKS_DOCUMENT),
  loosen(WEB_SESSIONS_DOCUMENT),
  loosen(PROXY_SESSIONS_DOCUMENT),
  loosen(PROTECTED_SITES_DOCUMENT),
  loosen(KEYS_DOCUMENT),
  loosen(BRANDING_DOCUMENT),
  loosen(SETTINGS_DOCUMENT),
  loosen(MAIL_DOCUMENT),
];
