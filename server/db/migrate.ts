// `npm run db:migrate`: applies the migrations to the database DATABASE_URL (or DATA_DIR's PGlite) names, as boot does,
// without starting the server. It takes the database lock as the server does, so it refuses while one runs.
import { databaseUrl, dataDir, dbConnectTimeoutMs, isProduction } from '../core/config.ts';
import { openDatabase } from './client.ts';
import { openFailure } from './lock.ts';

try {
  const database = await openDatabase(
    { url: databaseUrl(), dataDir: dataDir(), isProduction: isProduction() },
    { connectTimeoutMs: dbConnectTimeoutMs() },
  );
  try {
    await database.migrate();
    console.log(`[db] ${database.label} is up to date.`);
  } finally {
    await database.close();
  }
} catch (error) {
  console.error(`[db] ${openFailure(error)}`);
  process.exitCode = 1;
}
