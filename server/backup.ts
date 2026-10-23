// The backup CLI: `node server/backup.ts export <file> [--sessions]` and `node server/backup.ts restore <file>`.
// It reads DATA_DIR, DATABASE_URL and SECRET_KEY as the server does, and shares the archive code with Settings.
import { readFileSync, writeFileSync } from 'node:fs';
import { databaseUrl, dataDir, dbConnectTimeoutMs, isProduction, secretKeys } from './core/config.ts';
import { createSecretBox } from './core/secret-box.ts';
import { FILE_MODE } from './core/wire.ts';
import { type OpenDatabase, openDatabase } from './db/client.ts';
import { createDataSet } from './db/data-set.ts';
import { createWriteQueue, type DocumentStore } from './db/document.ts';
import { openFailure } from './db/lock.ts';
import { AuditType, openAuditLog } from './store/audit.ts';
import { exportArchive, RestoreVia, restoreArchive, restoredDetail } from './store/backup.ts';

/** The commands. */
const Command = { Export: 'export', Restore: 'restore' } as const;
/** Takes the provider's sessions and tokens too. */
const SESSIONS_FLAG = '--sessions';
const USAGE = `Usage:
  node server/backup.ts export <file> [${SESSIONS_FLAG}]   back the data up to <file>; stop the server first
  node server/backup.ts restore <file>                 replace the data with <file>; stop the server first`;

/**
 * Opens the database the server uses, migrated. It takes the database lock as the server does, so it refuses while
 * one runs: an export would read what the server has not finished writing, and a restore would be overwritten from
 * the server's memory.
 *
 * @returns The database.
 */
async function openData(): Promise<OpenDatabase> {
  const database = await openDatabase(
    { url: databaseUrl(), dataDir: dataDir(), isProduction: isProduction() },
    { connectTimeoutMs: dbConnectTimeoutMs() },
  );
  await database.migrate();
  return database;
}

/**
 * Writes an archive of the data.
 *
 * @param store - The database and a write queue.
 * @param file - Where to.
 * @param includeSessions - Whether to take the provider's sessions and tokens.
 */
async function exportTo(store: DocumentStore, file: string, includeSessions: boolean): Promise<void> {
  const archive = await exportArchive(createDataSet(store), { includeSessions });
  writeFileSync(file, archive, { mode: FILE_MODE });
  const sealing =
    secretKeys() === null
      ? 'SECRET_KEY is not set, so its secrets are plain text'
      : 'its secrets are sealed under SECRET_KEY';
  console.log(`[backup] Wrote ${file} (${archive.length} bytes); ${sealing}.`);
}

/**
 * Checks an archive and puts its data in the database.
 *
 * @param store - The database and a write queue.
 * @param file - The archive.
 * @param label - Where the data is, for the log.
 */
async function restoreFrom(store: DocumentStore, file: string, label: string): Promise<void> {
  const keys = secretKeys();
  const box = keys === null ? null : createSecretBox(keys);
  const summary = await restoreArchive(createDataSet(store), readFileSync(file), box);
  const audit = openAuditLog(store);
  audit.record({
    type: AuditType.DataRestored,
    actor: null,
    ip: null,
    detail: restoredDetail(summary, RestoreVia.Cli),
  });
  await audit.settled();
  console.log(
    `[backup] Restored ${summary.files} files from the backup made ${summary.createdAt} into ${label}. Start the server to use them.`,
  );
}

const [command, file, ...flags] = process.argv.slice(2);
const isKnownFlag = flags.every((flag) => flag === SESSIONS_FLAG);
const isUsable = file !== undefined && isKnownFlag;
const isExport = command === Command.Export && isUsable;
const isRestore = command === Command.Restore && isUsable && flags.length === 0;
if (file === undefined || (isExport || isRestore) === false) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  let database: OpenDatabase | null = null;
  try {
    database = await openData();
    const store = { db: database.db, queue: createWriteQueue() };
    if (isExport) {
      await exportTo(store, file, flags.includes(SESSIONS_FLAG));
    } else {
      await restoreFrom(store, file, database.label);
    }
  } catch (error) {
    console.error(`[backup] ${openFailure(error)}`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
