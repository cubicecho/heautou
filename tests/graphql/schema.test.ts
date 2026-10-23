import { drizzleExtension } from '@vantreeseba/drizzle-graphql';
import { type GraphQLSchema, graphql, isInputObjectType, isObjectType } from 'graphql';
import { OPERATION_LIMIT_DEFAULTS } from '../../server/core/defaults.ts';
import { createSchema } from '../../server/graphql/build-schema.ts';
import { AuditType, openAuditLog } from '../../server/store/audit.ts';
import { createTestDatabase, createTestStore } from '../db.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, signInAsAdmin } from '../oidc/browser.ts';

/**
 * Lists a type's fields, or an input's.
 *
 * @param schema - The schema.
 * @param name - The type.
 * @returns Its field names.
 */
function fieldsOf(schema: GraphQLSchema, name: string): string[] {
  const type = schema.getType(name);
  const isWithFields = isObjectType(type) || isInputObjectType(type);
  return isWithFields ? Object.keys(type.getFields()) : [];
}

describe('the generated schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const database = await createTestDatabase();
    schema = createSchema(database.db);
    await database.close();
  });

  it('never mentions a hash or a sealed secret, not even as a filter', () => {
    expect(fieldsOf(schema, 'User')).not.toContain('passwordHash');
    expect(fieldsOf(schema, 'UserFilters')).not.toContain('passwordHash');
    expect(fieldsOf(schema, 'Upstream')).not.toContain('clientSecret');
    expect(fieldsOf(schema, 'UpstreamFilters')).not.toContain('clientSecret');
    expect(fieldsOf(schema, 'ClientFilters')).not.toContain('clientSecret');
    expect(fieldsOf(schema, 'ClientOrderBy')).not.toContain('clientSecret');
  });

  it('reads none of the tables only the server reads', () => {
    const queries = fieldsOf(schema, 'Query');
    const serverOnly = ['pairings', 'passkeys', 'totpFactors', 'recoveryCodes', 'webSessions', 'proxySessions'];
    const more = ['passwordLinks', 'oidcModels', 'documents', 'apiClients'];
    expect(queries.filter((field) => [...serverOnly, ...more].includes(field))).toEqual([]);
  });

  it('generates no writes: every change goes through a store', () => {
    const mutations = Object.values(schema.getMutationType()?.getFields() ?? {});
    expect(mutations.filter((field) => drizzleExtension(field) !== undefined)).toEqual([]);
    expect(mutations.length).toBeGreaterThan(0);
  });
});

describe('the admin API', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp();
  });

  afterEach(() => app.close());

  it('answers the hand-written fields of a row whose key was not asked for', async () => {
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(admin, 'fragment Who on User { username hasPassword } { viewer { ...Who } }');
    expect(reply.data.viewer).toEqual({ username: 'root', hasPassword: true });
  });

  it('refuses a page larger than the largest', async () => {
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(admin, `{ users(limit: ${OPERATION_LIMIT_DEFAULTS.maxPageSize + 1}) { id } }`);
    expect(reply.errors[0].extensions.code).toBe('DRIZZLE_LIMIT_EXCEEDED');
  });

  it('returns the row a change saved, with what the request selected', async () => {
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(
      admin,
      `mutation($input: NewUserInput!) {
        createUser(input: $input) { username claims groups hasPassword upstreamLinks { label } }
      }`,
      { input: { username: 'ada', email: '', name: 'Ada', groups: ['ops'], claims: [{ name: 'team', value: 'db' }] } },
    );
    expect(reply.data.createUser).toEqual({
      username: 'ada',
      claims: { team: 'db' },
      groups: ['ops'],
      hasPassword: false,
      upstreamLinks: [],
    });
  });
});

describe('the activity list', () => {
  it('waits for the entries still queued, as the subscription does', async () => {
    const store = await createTestStore();
    try {
      const schema = createSchema(store.db);
      const audit = openAuditLog(store);
      // Hold the write queue, as a slow write ahead of the entry would.
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      void store.queue.run(() => held);
      audit.record({ type: AuditType.KeysRotated, actor: null, ip: null });

      const reading = graphql({
        schema,
        source: '{ auditEntries { type } auditEntriesAggregate { count } }',
        contextValue: { audit },
      });
      release();
      const { data, errors } = await reading;

      expect(errors).toBeUndefined();
      expect(data).toEqual({ auditEntries: [{ type: 'KEYS_ROTATED' }], auditEntriesAggregate: { count: 1 } });
    } finally {
      await store.close();
    }
  });
});
