// The schema `/graphql` serves. The reads are generated from the tables by drizzle-graphql: users, clients, APIs,
// upstream providers and their links, protected sites and the audit log, with filters, ordering, keyset pages and their
// relations. Everything else is written by hand, one module per concept (`clients.ts`, `users.ts`...): the fields a
// row can't hold (sessions, second factors, a client's opened secret), the settings that are no table, and every
// change. A change is never a generated write: each one is validated, audited and made through a store, whose document the provider reads
// from memory, so a write past the store would leave the provider reading old data.
import { addResolversToSchema } from '@graphql-tools/schema';
import { buildSchema, GraphQLDateTime } from '@vantreeseba/drizzle-graphql';
import { extendSchema, type GraphQLField, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../core/defaults.ts';
import type { Database } from '../db/client.ts';
import { API_TYPE_DEFS, apiResolvers } from './apis.ts';
import { AUDIT_TYPE_DEFS, auditResolvers } from './audit.ts';
import { CLIENT_TYPE_DEFS, clientResolvers } from './clients.ts';
import { TABLE_DESCRIPTION, TABLE_DOCS } from './docs.ts';
import { FORWARD_AUTH_TYPE_DEFS, forwardAuthResolvers } from './forward-auth.ts';
import { GROUP_TYPE_DEFS, groupResolvers } from './groups.ts';
import { MAIL_TYPE_DEFS, mailResolvers } from './mail.ts';
import { PAIRING_TYPE_DEFS, pairingResolvers } from './pairing.ts';
import { SELECTION_NAMING, withKeysSelected } from './rows.ts';
import { SETTINGS_TYPE_DEFS, settingsResolvers } from './settings.ts';
import { ROOT_TYPE_DEFS } from './type-defs.ts';
import { UPSTREAM_TYPE_DEFS, upstreamResolvers } from './upstreams.ts';
import { USER_TYPE_DEFS, userResolvers } from './users.ts';

/**
 * Tables only the server reads: secrets, hashed tokens, sessions, the provider's own models and the settings
 * documents. They generate nothing.
 */
const SERVER_TABLES = [
  'apiClients',
  'totpFactors',
  'recoveryCodes',
  'passkeys',
  'pairings',
  'passwordLinks',
  'webSessions',
  'proxySessions',
  'documents',
  'oidcModels',
];

/** Columns that hold a hash or a sealed secret. `Client.clientSecret` is written by hand, opened. */
const SECRET_COLUMNS = {
  users: ['passwordHash'],
  clients: ['clientSecret'],
  upstreams: ['clientSecret'],
};

/** The tables only ever read as another table's relation, whose lists are short. */
const RELATED_TABLES = ['upstreamLinks', 'upstreamGroupMappings'];

/** Drizzle's name for a Postgres timestamp column. */
const TIMESTAMP_COLUMN = 'PgTimestamp';

/** The generated reads of the audit log. */
const AUDIT_READS = ['auditEntries', 'auditEntry', 'auditEntriesAggregate'];

/** Each concept's hand-written SDL and resolvers. */
const HAND_WRITTEN = [
  { typeDefs: CLIENT_TYPE_DEFS, resolvers: clientResolvers },
  { typeDefs: PAIRING_TYPE_DEFS, resolvers: pairingResolvers },
  { typeDefs: USER_TYPE_DEFS, resolvers: userResolvers },
  { typeDefs: GROUP_TYPE_DEFS, resolvers: groupResolvers },
  { typeDefs: SETTINGS_TYPE_DEFS, resolvers: settingsResolvers },
  { typeDefs: UPSTREAM_TYPE_DEFS, resolvers: upstreamResolvers },
  { typeDefs: API_TYPE_DEFS, resolvers: apiResolvers },
  { typeDefs: AUDIT_TYPE_DEFS, resolvers: auditResolvers },
  { typeDefs: MAIL_TYPE_DEFS, resolvers: mailResolvers },
  { typeDefs: FORWARD_AUTH_TYPE_DEFS, resolvers: forwardAuthResolvers },
];

/** The ordering a list runs with when the request passes none: oldest first, and the audit log newest first. */
const OLDEST_FIRST = { createdAt: { direction: 'asc', priority: 1 } } as const;

/**
 * Names a database enum after itself: `client_auth_method` is `ClientAuthMethod`, as the schema called it before.
 *
 * @param info - The enum.
 * @param info.enumName - Its name in the database.
 * @returns The GraphQL name, or undefined to keep drizzle-graphql's.
 */
function enumName({ enumName: name }: { enumName: string | undefined }): string | undefined {
  return name
    ?.split('_')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('');
}

/**
 * Merges resolver maps type by type.
 *
 * @param maps - The maps.
 * @returns One map.
 */
function mergeResolvers(maps: readonly Record<string, object>[]): Record<string, object> {
  const merged: Record<string, object> = {};
  for (const map of maps) {
    for (const [type, fields] of Object.entries(map)) {
      merged[type] = { ...merged[type], ...fields };
    }
  }
  return merged;
}

/**
 * Makes the generated reads of the audit log wait for the entries still queued, as `audit.list` and the subscription
 * do, so a change just made is in the list. `audit.record` does not wait for its write.
 *
 * @param schema - The built schema. Its audit fields are changed in place.
 * @returns The same schema.
 */
function waitingForAudit(schema: GraphQLSchema): GraphQLSchema {
  const fields = schema.getQueryType()?.getFields() ?? {};
  for (const name of AUDIT_READS) {
    const field: GraphQLField<unknown, Pick<Context, 'audit'>> | undefined = fields[name];
    const resolve = field?.resolve;
    if (field !== undefined && resolve !== undefined) {
      field.resolve = async (parent, args, ctx, info) => {
        await ctx.audit.settled();
        return resolve(parent, args, ctx, info);
      };
    }
  }
  return schema;
}

/**
 * Builds the served schema over a database.
 *
 * @param db - The database the generated reads query. `write-schema.ts` passes one that never connects.
 * @returns The schema.
 */
export function createSchema(db: Database): GraphQLSchema {
  const { defaultPageSize, maxPageSize, relationPageSize } = OPERATION_LIMIT_DEFAULTS;
  const relatedLimits = { defaultLimit: relationPageSize, maxLimit: maxPageSize };
  const { schema: generated } = buildSchema(db, {
    ...SELECTION_NAMING,
    mutations: false,
    features: {
      insert: false,
      update: false,
      updateMany: false,
      delete: false,
      groupBy: false,
      distinct: false,
      // Stated, though no write is generated: nested writes would skip the stores' rules.
      nestedWrites: false,
    },
    exclude: { tables: SERVER_TABLES, columns: SECRET_COLUMNS },
    enumNameMapper: enumName,
    enumValueNameMapper: 'constant',
    limits: {
      defaultLimit: defaultPageSize,
      maxLimit: maxPageSize,
      tables: Object.fromEntries(RELATED_TABLES.map((table) => [table, relatedLimits])),
    },
    complexity: true,
    defaults: {
      users: { orderBy: OLDEST_FIRST },
      clients: { orderBy: OLDEST_FIRST },
      apis: { orderBy: OLDEST_FIRST },
      upstreams: { orderBy: OLDEST_FIRST },
      protectedSites: { orderBy: OLDEST_FIRST },
      upstreamGroupMappings: { orderBy: { position: { direction: 'asc', priority: 1 } } },
      auditEntries: { orderBy: { seq: { direction: 'desc', priority: 1 } } },
    },
    // Without this, a null timestamp in a filter parses as the epoch.
    mapColumnType: (column) => (column.columnType === TIMESTAMP_COLUMN ? { input: GraphQLDateTime } : undefined),
    describeTable: (table) => TABLE_DOCS[table]?.[TABLE_DESCRIPTION],
    describeColumn: (_column, { tableName, columnName }) => TABLE_DOCS[tableName]?.[columnName],
    describeRelation: (table, relation) => TABLE_DOCS[table]?.[relation],
  });
  const typeDefs = [ROOT_TYPE_DEFS, ...HAND_WRITTEN.map((module) => module.typeDefs)];
  const extended = extendSchema(generated, parse(typeDefs.join('\n')));
  const resolved = addResolversToSchema({
    schema: extended,
    resolvers: mergeResolvers(HAND_WRITTEN.map((module) => module.resolvers)),
  });
  return waitingForAudit(withKeysSelected(resolved));
}
