// Test databases: PGlite in memory, with every migration applied. Booting one takes about a second, so each test file
// keeps the ones it has made and empties one for the next test rather than booting another; a test that needs two at
// once (a backup and the server it is restored into) gets a second.
import { PGlite } from '@electric-sql/pglite';
import { getTableName, is, sql, Table } from 'drizzle-orm';
import { type Database, fromPglite, type OpenDatabase } from '../server/db/client.ts';
import { createWriteQueue, type DocumentStore } from '../server/db/document.ts';
import * as schema from '../server/db/schema.ts';

/** Every table, quoted for a statement that names them all. */
const TABLE_LIST = Object.values(schema)
  .flatMap((value) => (is(value, Table) ? [`"${getTableName(value)}"`] : []))
  .join(', ');

/** The databases this file has made, emptied and waiting for the next test. */
const idle: OpenDatabase[] = [];
/** Every database this file has made, closed when it is done. */
const made: OpenDatabase[] = [];

afterAll(async () => {
  await Promise.all(made.map((database) => database.close()));
});

/**
 * Empties every table, so the next test starts from a database as `createTestDatabase` first returned it.
 *
 * @param db - The database.
 */
async function emptyTables(db: Database): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLE_LIST} RESTART IDENTITY CASCADE`));
}

/**
 * Boots a database and applies the migrations.
 *
 * @returns The database.
 */
async function bootDatabase(): Promise<OpenDatabase> {
  const database = fromPglite(new PGlite('memory://'));
  await database.migrate();
  made.push(database);
  return database;
}

/**
 * Gives an empty database with the current tables. Close it when the test is done, which empties it for the next.
 *
 * @returns The database.
 */
export async function createTestDatabase(): Promise<OpenDatabase> {
  const database = idle.pop() ?? (await bootDatabase());
  return {
    ...database,
    close: async () => {
      await emptyTables(database.db);
      idle.push(database);
    },
  };
}

/** A test database and a write queue on it, for a store's own tests. */
export interface TestStore extends DocumentStore {
  /** Waits for the queued writes, then empties the database for the next test. */
  close: () => Promise<void>;
}

/**
 * Gives an empty database and a write queue on it, for a store's own tests.
 *
 * @returns The database, its queue, and a function that hands it back.
 */
export async function createTestStore(): Promise<TestStore> {
  const database = await createTestDatabase();
  const queue = createWriteQueue();
  return {
    db: database.db,
    queue,
    close: async () => {
      await queue.run(async () => {});
      await database.close();
    },
  };
}
