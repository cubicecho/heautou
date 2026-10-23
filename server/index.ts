// Boot only. Preflight is the first import: it exits with a sentence when the configuration is unusable.
import './core/preflight.ts';
import { adminUrls } from './admin/admin-client.ts';
import {
  databaseUrl,
  dataDir,
  dbConnectTimeoutMs,
  forwardAuthCookieDomain,
  forwardAuthTrustedProxies,
  isProduction,
  issuerUrl,
  port,
  s3Config,
  secretKeys,
  trustProxy,
  version,
} from './core/config.ts';
import { ADMIN_DEFAULTS } from './core/defaults.ts';
import { errorMessage } from './core/errors.ts';
import { createObjectStorage } from './core/object-storage.ts';
import { SecretKeyError } from './core/secret-box.ts';
import { openServices, type Services } from './core/services.ts';
import { type OpenDatabase, openDatabase } from './db/client.ts';
import { createDataSet } from './db/data-set.ts';
import { createWriteQueue } from './db/document.ts';
import { importDataDirectory, isUnstarted } from './db/import.ts';
import { openFailure } from './db/lock.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';
import { mailServerFromEnv } from './mail/env.ts';
import { cookieDomainProblem } from './store/protected-sites.ts';

const LISTEN_HOST = '0.0.0.0';
const SECONDS_PER_MINUTE = 60;

const sealingKeys = secretKeys();
const bucket = s3Config();

/**
 * Opens the database, waits for Postgres when it is one, takes the database lock and brings the tables up to date.
 * Stops with a sentence when it can't, before writing anything when another heautou has the database.
 *
 * @returns The database.
 */
async function openDatabaseOrExit(): Promise<OpenDatabase> {
  try {
    const database = await openDatabase(
      { url: databaseUrl(), dataDir: dataDir(), isProduction: isProduction() },
      { connectTimeoutMs: dbConnectTimeoutMs() },
    );
    await database.migrate();
    return database;
  } catch (error) {
    console.error(`[db] ${openFailure(error)}`);
    process.exit(1);
  }
}

/**
 * Puts an older version's JSON files in the database, the first time this version starts on their data directory.
 *
 * @param database - The database, migrated.
 */
async function importOrExit(database: OpenDatabase): Promise<void> {
  try {
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });
    const imported = await importDataDirectory(dataSet, dataDir(), await isUnstarted(database.db));
    if (imported !== null) {
      console.log(
        `[db] Imported ${imported.files} files from ${dataDir()} into ${database.label}, and moved them to ${imported.movedTo}. Delete them once you are happy.`,
      );
    }
  } catch (error) {
    console.error(`[db] Could not import the files in ${dataDir()}, so nothing was: ${errorMessage(error)}`);
    process.exit(1);
  }
}

/**
 * Opens the data, stopping with a sentence when the secret key doesn't fit it.
 *
 * @param database - The database, migrated.
 * @returns The services.
 */
async function openOrExit(database: OpenDatabase): Promise<Services> {
  try {
    return await openServices({
      database: database.db,
      issuer: issuerUrl(),
      isProxied: trustProxy() !== false,
      secretKeys: sealingKeys,
      mailServer: mailServerFromEnv(),
      objectStorage: bucket === null ? null : createObjectStorage(bucket),
      proxyCookieDomain: forwardAuthCookieDomain(),
      trustedProxies: forwardAuthTrustedProxies(),
    });
  } catch (error) {
    if (error instanceof SecretKeyError) {
      console.error(`[boot] ${error.code}: ${errorMessage(error)}`);
      process.exit(1);
    }
    throw error;
  }
}

const database = await openDatabaseOrExit();
await importOrExit(database);
const services = await openOrExit(database);
if (sealingKeys === null) {
  console.warn(
    `[boot] SECRET_KEY is not set: client secrets and signing keys are stored in plain text in ${database.label}. Set SECRET_KEY or SECRET_KEY_FILE to seal them.`,
  );
}

const environmentDomain = services.forwardAuth.environmentCookieDomain;
const domainProblem =
  environmentDomain === null ? null : cookieDomainProblem(environmentDomain, new URL(services.issuer).hostname);
if (domainProblem !== null) {
  console.warn(`[boot] FORWARD_AUTH_COOKIE_DOMAIN: ${domainProblem}. Signing in to protected sites will not stick.`);
}

const server = createApp(services).listen(port(), LISTEN_HOST, () => {
  console.log(
    `[boot] heautou ${version()} on http://localhost:${port()}, issuer ${services.issuer}, data in ${database.label}`,
  );
  if (services.setup.isNeeded()) {
    const { base } = adminUrls(services.issuer);
    const minutes = ADMIN_DEFAULTS.setupWindowSeconds / SECONDS_PER_MINUTE;
    console.log(
      `[setup] No admin yet. Open ${base} within ${minutes} minutes to make one. After that, or to make an existing user the admin, open ${base}/setup#token=${services.setup.token}. The token changes on every restart.`,
    );
  }
  stopOnSignals(server, {
    after: async () => {
      await services.settled();
      await database.close();
    },
  });
});
