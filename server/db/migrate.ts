// `npm run db:migrate`: applies the migrations to the database DATABASE_URL (or DATA_DIR's PGlite) names, as boot does,
// without starting the server. Stop the server first when the data is in PGlite.
import { databaseUrl, dataDir, dbConnectTimeoutMs, isProduction } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import { DatabaseKind, openDatabase } from './client.ts';
import { waitForDatabase } from './wait.ts';

try {
  const database = await openDatabase({ url: databaseUrl(), dataDir: dataDir(), isProduction: isProduction() });
  try {
    if (database.kind === DatabaseKind.Postgres) {
      await waitForDatabase(database.db, { connectTimeoutMs: dbConnectTimeoutMs() });
    }
    await database.migrate();
    console.log(`[db] ${database.label} is up to date.`);
  } finally {
    await database.close();
  }
} catch (error) {
  console.error(`[db] ${errorMessage(error)}`);
  process.exitCode = 1;
}
