// Every table heautou keeps. One table per kind of record; the settings that are one document each (branding, the
// keys, mail, the operator's settings) are rows of `documents`. Each store's mapping to these tables is in
// `server/db/documents/`, and the GraphQL schema's reads are generated from them (`server/graphql/build-schema.ts`).
//
// Rows that point at another store's rows (a link at a user, an API at a client) hold the id without a foreign key:
// each store keeps its own references tidy, as it did in the JSON files, and an import must not fail on an id an
// older version left behind. Foreign keys tie the tables of one store together.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { TOKEN_FORMAT_JWT, TOKEN_FORMAT_OPAQUE } from '../store/apis.ts';
import { AuditTargetKind, AuditType } from '../store/audit-vocabulary.ts';
import { CLIENT_SOURCE_ADMIN, CLIENT_SOURCE_PAIRED, ClientAuthMethod } from '../store/clients.ts';
import { UnknownIdentity, UpstreamKind } from '../store/upstreams.ts';

/**
 * Lists a vocabulary's values in the shape `pgEnum` takes.
 *
 * @typeParam T - The values.
 * @param vocabulary - An `as const` vocabulary object.
 * @returns Its values, at least one.
 */
function valuesOf<T extends string>(vocabulary: Record<string, T>): [T, ...T[]] {
  const [first, ...rest] = Object.values(vocabulary);
  if (first === undefined) {
    throw new Error('A database enum needs at least one value.');
  }
  return [first, ...rest];
}

/** An empty text array, the default of every list column. */
const NO_TEXT = sql`'{}'::text[]`;

/**
 * A timestamp column: an instant, read back as a `Date`.
 *
 * @param name - The SQL name.
 * @returns The column builder.
 */
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * A list of strings, empty by default.
 *
 * @param name - The SQL name.
 * @returns The column builder.
 */
const textList = (name: string) => text(name).array().notNull().default(NO_TEXT);

export const clientAuthMethod = pgEnum('client_auth_method', valuesOf(ClientAuthMethod));
export const clientSource = pgEnum('client_source', [CLIENT_SOURCE_ADMIN, CLIENT_SOURCE_PAIRED]);
export const tokenFormat = pgEnum('token_format', [TOKEN_FORMAT_JWT, TOKEN_FORMAT_OPAQUE]);
export const upstreamKind = pgEnum('upstream_kind', valuesOf(UpstreamKind));
export const unknownIdentity = pgEnum('unknown_identity', valuesOf(UnknownIdentity));
export const auditType = pgEnum('audit_type', valuesOf(AuditType));
export const auditTargetKind = pgEnum('audit_target_kind', valuesOf(AuditTargetKind));

/** Someone who can sign in through the provider. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** scrypt; empty for an invited user who has not set a password. Never in the GraphQL schema. */
    passwordHash: text('password_hash').notNull().default(''),
    email: text('email').notNull().default(''),
    name: text('name').notNull().default(''),
    groups: textList('groups'),
    /** Claims of the operator's own, by name. */
    claims: jsonb('claims').$type<Record<string, string>>().notNull().default({}),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: instant('created_at').notNull().defaultNow(),
    /** The profile picture in the bucket, by a hash of its bytes. Null for none. */
    pictureVersion: text('picture_version'),
  },
  (table) => [uniqueIndex('uq_users_username').on(table.username)],
);

/** An application that signs its users in through this provider. */
export const clients = pgTable('clients', {
  clientId: text('client_id').primaryKey(),
  name: text('name').notNull(),
  /** Sealed under `SECRET_KEY` when one is set. Never in the generated schema; `Client.clientSecret` opens it. */
  clientSecret: text('client_secret'),
  authMethod: clientAuthMethod('auth_method').notNull(),
  redirectUris: textList('redirect_uris'),
  postLogoutRedirectUris: textList('post_logout_redirect_uris'),
  allowedGroups: textList('allowed_groups'),
  groupsClaim: text('groups_claim').notNull(),
  allowClientCredentials: boolean('allow_client_credentials').notNull().default(false),
  allowDeviceFlow: boolean('allow_device_flow').notNull().default(false),
  source: clientSource('source').notNull().default(CLIENT_SOURCE_ADMIN),
  logoUri: text('logo_uri'),
  /** Its own access token lifetime; null is the server's. */
  accessTokenSeconds: integer('access_token_seconds'),
  idTokenSeconds: integer('id_token_seconds'),
  refreshTokenSeconds: integer('refresh_token_seconds'),
  backchannelLogoutUri: text('backchannel_logout_uri'),
  backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required').notNull().default(true),
  preset: text('preset'),
  pairingId: text('pairing_id'),
  clientUri: text('client_uri'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** An API (a resource server) apps ask for access tokens to. */
export const apis = pgTable('apis', {
  identifier: text('identifier').primaryKey(),
  name: text('name').notNull(),
  scopes: textList('scopes'),
  tokenFormat: tokenFormat('token_format').notNull(),
  accessTokenSeconds: integer('access_token_seconds'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** The clients an API lets ask for its tokens, in the order the operator listed them. */
export const apiClients = pgTable(
  'api_clients',
  {
    apiIdentifier: text('api_identifier')
      .notNull()
      .references(() => apis.identifier, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [
    primaryKey({ name: 'pk_api_clients', columns: [table.apiIdentifier, table.clientId] }),
    index('idx_api_clients_client_id').on(table.clientId),
  ],
);

/** A provider users may sign in through instead of with a password. */
export const upstreams = pgTable('upstreams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: upstreamKind('kind').notNull(),
  issuer: text('issuer'),
  clientId: text('client_id').notNull(),
  /** Sealed under `SECRET_KEY` when one is set. Never in the GraphQL schema. */
  clientSecret: text('client_secret'),
  scopes: textList('scopes'),
  unknownIdentity: unknownIdentity('unknown_identity').notNull(),
  createDomains: textList('create_domains'),
  createGroups: textList('create_groups'),
  countsAsBothFactors: boolean('counts_as_both_factors').notNull().default(false),
  groupsClaim: text('groups_claim'),
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** An upstream group that gives a group here, in the order the operator listed them. */
export const upstreamGroupMappings = pgTable(
  'upstream_group_mappings',
  {
    upstreamId: text('upstream_id')
      .notNull()
      .references(() => upstreams.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    upstream: text('upstream').notNull(),
    local: text('local').notNull(),
  },
  (table) => [primaryKey({ name: 'pk_upstream_group_mappings', columns: [table.upstreamId, table.position] })],
);

/** An upstream identity a user signs in with. */
export const upstreamLinks = pgTable(
  'upstream_links',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => upstreams.id, { onDelete: 'cascade' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id').notNull(),
    label: text('label').notNull(),
    linkedAt: instant('linked_at').notNull(),
    lastUsedAt: instant('last_used_at'),
  },
  (table) => [
    primaryKey({ name: 'pk_upstream_links', columns: [table.providerId, table.issuer, table.subject] }),
    index('idx_upstream_links_user_id').on(table.userId),
  ],
);

/** A user's authenticator app. */
export const totpFactors = pgTable('totp_factors', {
  userId: text('user_id').primaryKey(),
  /** Sealed under `SECRET_KEY` when one is set. */
  secret: text('secret').notNull(),
  /** The last time step a code was accepted for, so no code works twice. */
  lastStep: bigint('last_step', { mode: 'number' }).notNull(),
  createdAt: instant('created_at').notNull(),
});

/** A user's unused recovery codes, hashed. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [primaryKey({ name: 'pk_recovery_codes', columns: [table.userId, table.codeHash] })],
);

/** A passkey (WebAuthn credential) a user registered. */
export const passkeys = pgTable(
  'passkeys',
  {
    /** The credential id, base64url. */
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull(),
    transports: textList('transports'),
    name: text('name').notNull(),
    createdAt: instant('created_at').notNull(),
    lastUsedAt: instant('last_used_at'),
    position: integer('position').notNull(),
  },
  (table) => [index('idx_passkeys_user_id').on(table.userId)],
);

/** A setup URL handed out for an app to register itself with. */
export const pairings = pgTable('pairings', {
  id: text('id').primaryKey(),
  /** sha256 of the initial access token in the setup URL. */
  tokenHash: text('token_hash').notNull(),
  allowedGroups: textList('allowed_groups'),
  groupsClaim: text('groups_claim').notNull(),
  expiresAt: instant('expires_at').notNull(),
  clientId: text('client_id'),
  clientUri: text('client_uri'),
  deviceClientId: text('device_client_id'),
  isFinished: boolean('is_finished').notNull().default(false),
});

/** An invite or reset link, by the sha256 of its token. */
export const passwordLinks = pgTable('password_links', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: instant('expires_at').notNull(),
});

/** A web app session, by the sha256 of its cookie's token. */
export const adminSessions = pgTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: instant('expires_at').notNull(),
});

/** A forward auth session, by the sha256 of its cookie's token. */
export const proxySessions = pgTable('proxy_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  grantId: text('grant_id').notNull(),
  amr: textList('amr'),
  acr: text('acr').notNull(),
  expiresAt: instant('expires_at').notNull(),
  lastSeenAt: instant('last_seen_at').notNull(),
});

/** A site behind the reverse proxy that forward auth protects. */
export const protectedSites = pgTable(
  'protected_sites',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    pathPrefix: text('path_prefix').notNull().default(''),
    allowedGroups: textList('allowed_groups'),
    requireSecondFactor: boolean('require_second_factor').notNull().default(false),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_protected_sites_host_path_prefix').on(table.host, table.pathPrefix)],
);

/** The settings that are one document each: branding, the keys, mail, the operator's settings, the proxy cookie. */
export const documents = pgTable('documents', {
  /** The document's file name in a backup, such as `branding.json`. */
  name: text('name').primaryKey(),
  /** The document as the store keeps it, secrets sealed. */
  body: jsonb('body').$type<unknown>().notNull(),
});

/** oidc-provider's models: sessions, grants, codes, tokens, interactions. */
export const oidcModels = pgTable(
  'oidc_models',
  {
    /** The model's name, such as `Session` or `AccessToken`. */
    model: text('model').notNull(),
    id: text('id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** When it may be dropped. Null for one that never expires. */
    expiresAt: instant('expires_at'),
  },
  (table) => [
    primaryKey({ name: 'pk_oidc_models', columns: [table.model, table.id] }),
    index('idx_oidc_models_expires_at').on(table.expiresAt),
  ],
);

/** One thing that happened: a sign-in, an admin change, an account change. Append-only. */
export const auditEntries = pgTable(
  'audit_entries',
  {
    id: text('id').primaryKey(),
    /** The order entries were recorded in, which several in one millisecond share no other way. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    at: instant('at').notNull(),
    type: auditType('type').notNull(),
    /** Who did it, or for a sign-in the account it was for. Null when nobody is known. */
    actorUserId: text('actor_user_id'),
    /** Their username at the time. */
    actorUsername: text('actor_username'),
    ip: text('ip'),
    targetKind: auditTargetKind('target_kind'),
    targetId: text('target_id'),
    /** Its name at the time, so the entry still reads after a rename or delete. */
    targetName: text('target_name'),
    /** Facts the entry keeps, by name. Never a password, token, secret or setup URL. */
    detail: jsonb('detail').$type<Record<string, string>>().notNull().default({}),
  },
  (table) => [
    uniqueIndex('uq_audit_entries_seq').on(table.seq),
    index('idx_audit_entries_actor_user_id').on(table.actorUserId),
    index('idx_audit_entries_target').on(table.targetKind, table.targetId),
  ],
);
