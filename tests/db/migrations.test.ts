import { createHash } from 'node:crypto';
import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fromPglite, MIGRATIONS_FOLDER, type OpenDatabase } from '../../server/db/client.ts';
import { isUnstarted } from '../../server/db/import.ts';
import { startTestApp, tempDir } from '../helpers.ts';

/** The first migration, which every database made before the stored names changed was created by. */
const INITIAL_MIGRATION = '20261023051954_initial';
/** A web session token, as a browser's cookie held it. */
const TOKEN = 'session-token-from-before-the-upgrade';
/** When the session expires: well after the test runs. */
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';

/**
 * Opens a PGlite database in memory with only the first migration applied, as a server released before the renames
 * left it.
 *
 * @returns The client, for seeding rows, and a folder to clean up.
 */
async function openAtInitialMigration(): Promise<{ client: PGlite; folder: string }> {
  const folder = tempDir();
  cpSync(path.join(MIGRATIONS_FOLDER, INITIAL_MIGRATION), path.join(folder, INITIAL_MIGRATION), { recursive: true });
  const client = new PGlite('memory://');
  await migrate(drizzle({ client }), { migrationsFolder: folder });
  return { client, folder };
}

describe('migrations', () => {
  let database: OpenDatabase | undefined;
  let folder = '';

  afterEach(async () => {
    await database?.close();
    database = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  it('keeps the web sessions an older database holds when admin_sessions becomes web_sessions', async () => {
    const older = await openAtInitialMigration();
    folder = older.folder;
    const tokenHash = createHash('sha256').update(TOKEN).digest('base64url');
    await older.client.query(
      'INSERT INTO "admin_sessions" ("token_hash", "user_id", "expires_at") VALUES ($1, $2, $3)',
      [tokenHash, 'u-ada', EXPIRES_AT],
    );

    database = fromPglite(older.client);
    await database.migrate();

    const tables = await older.client.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_name IN ('admin_sessions', 'web_sessions')",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['web_sessions']);
    const app = await startTestApp({ database });
    try {
      expect(app.services.webSessions.find(TOKEN)).toBe('u-ada');
    } finally {
      await app.close();
    }
  });

  it('renames the documents an older database holds, keeping what they say', async () => {
    const older = await openAtInitialMigration();
    folder = older.folder;
    const keys = { jwks: [], cookieKeys: ['cookie-key-from-before'], rotatedAt: new Date().toISOString() };
    const insert = 'INSERT INTO "documents" ("name", "body") VALUES ($1, $2)';
    await older.client.query(insert, ['keys.json', JSON.stringify(keys)]);
    await older.client.query(insert, ['branding.json', JSON.stringify({ name: 'Home sign-in' })]);
    await older.client.query(insert, ['settings.json', JSON.stringify({ minPasswordScore: 1 })]);

    database = fromPglite(older.client);
    await database.migrate();

    const rows = await older.client.query<{ name: string }>('SELECT "name" FROM "documents" ORDER BY "name"');
    expect(rows.rows.map((row) => row.name)).toEqual(['branding', 'keys', 'settings']);
    const app = await startTestApp({ database });
    try {
      expect(app.services.keys.current().cookieKeys).toEqual(keys.cookieKeys);
      expect(app.services.branding.read().name).toBe('Home sign-in');
      expect(app.services.settings.passwordRules().minScore).toBe(1);
      expect(await isUnstarted(database.db)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
