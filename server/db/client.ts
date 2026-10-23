// The database: PGlite (Postgres compiled to WebAssembly, in this process) under DATA_DIR by default, or a Postgres
// server when DATABASE_URL names one. Both run the same SQL and the same migrations.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { type DatabaseSettings as ConnectSettings, DATABASE_DEFAULTS } from '../core/defaults.ts';
import { DIR_MODE, FILE_MODE } from '../core/wire.ts';
import { type DatabaseLockError, holdPostgresLock, type LockAttempt, takeLock } from './lock.ts';
import { relations } from './relations.ts';
import { requiresSsl } from './ssl.ts';
import { waitForDatabase } from './wait.ts';

/** The Drizzle client, whichever driver is under it. */
export type Database = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;

/** A transaction on it, as `Database.transaction` hands one to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The generated migrations, committed at the repository root. */
export const MIGRATIONS_FOLDER = path.join(import.meta.dirname, '..', '..', 'drizzle');
/** PGlite's directory under DATA_DIR. */
export const PGLITE_DIRECTORY = 'pg';
/** The file that says which process has PGlite's directory open. */
const LOCK_SUFFIX = '.lock';
/** What heautou's connections call themselves in `pg_stat_activity`, so an operator can find them. */
const APPLICATION_NAME = 'heautou';
/** A PGlite store that lives only in memory, for tests. */
export const IN_MEMORY = 'memory://';

/** Which engine holds the data. */
export const DatabaseKind = { Pglite: 'pglite', Postgres: 'postgres' } as const;
export type DatabaseKind = (typeof DatabaseKind)[keyof typeof DatabaseKind];

/** An open database, locked to this process (except an in-memory one, which no other process can reach). */
export interface OpenDatabase {
  db: Database;
  kind: DatabaseKind;
  /** Where the data is, for the boot log: PGlite's directory, or the Postgres host. Never the password. */
  label: string;
  /** Applies the committed migrations that have not run yet. */
  migrate: () => Promise<void>;
  /** Closes it and lets the lock go. PGlite flushes its directory first. */
  close: () => Promise<void>;
}

/**
 * Says whether a process is running.
 *
 * @param pid - Its id.
 * @returns True when it is, and is not this one.
 */
function isOtherProcessRunning(pid: number): boolean {
  if (Number.isInteger(pid) === false || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tries to claim PGlite's directory for this process. PGlite has no server of its own, so two processes on one
 * directory would each write it and corrupt it.
 *
 * @param directory - PGlite's directory.
 * @returns Taken, with what lets it go, or the process that has it.
 */
async function tryLockDirectory(directory: string): Promise<LockAttempt> {
  const lock = `${directory}${LOCK_SUFFIX}`;
  const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8').trim()) : Number.NaN;
  if (isOtherProcessRunning(holder)) {
    return { isTaken: false, holder: `process ${holder} on this machine has it open` };
  }
  writeFileSync(lock, String(process.pid), { mode: FILE_MODE });
  return { isTaken: true, release: async () => rmSync(lock, { force: true }) };
}

/**
 * Stops the process when Postgres's lock is lost. Going on would mean writing while another process may take the
 * lock and its own copy of the data; exiting non-zero lets a container restart and take the lock again, and writes
 * still queued are lost the same way as in a crash.
 *
 * @param error - The `DATABASE_LOCK_LOST` error.
 */
function exitOnLockLost(error: DatabaseLockError): never {
  console.error(`[db] ${error.code}: ${error.message}`);
  process.exit(1);
}

/**
 * Opens a Postgres server with node-postgres: waits for it to answer, then takes the lock on a connection of its own.
 *
 * @param url - A postgres:// URL.
 * @param isProduction - Whether TLS is required for a host off the local network.
 * @param overrides - Connect and lock settings that differ from `DATABASE_DEFAULTS`.
 * @param onLockLost - Called if the lock's connection drops.
 * @returns The database.
 */
async function openPostgres(
  url: string,
  isProduction: boolean,
  overrides: Partial<ConnectSettings>,
  onLockLost: (error: DatabaseLockError) => void,
): Promise<OpenDatabase> {
  const mustForceSsl = isProduction && requiresSsl(url);
  const connection = {
    connectionString: url,
    application_name: APPLICATION_NAME,
    ...(mustForceSsl ? { ssl: true } : {}),
  };
  const pool = new pg.Pool(connection);
  const db = drizzleNode({ client: pool, relations });
  const { host, port, pathname } = new URL(url);
  const label = `postgres://${host}${port === '' ? '' : `:${port}`}${pathname}`;
  const { lockKeepAliveDelayMs } = { ...DATABASE_DEFAULTS, ...overrides };
  const session = new pg.Client({ ...connection, keepAlive: true, keepAliveInitialDelayMillis: lockKeepAliveDelayMs });
  let unlock: () => Promise<void>;
  try {
    await waitForDatabase(db, overrides);
    unlock = await holdPostgresLock(session, label, onLockLost, overrides);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    db,
    kind: DatabaseKind.Postgres,
    label,
    migrate: async () => {
      await migrateNode(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    close: async () => {
      await pool.end();
      await unlock();
    },
  };
}

/**
 * Opens PGlite in this process, once its directory is this process's.
 *
 * @param store - Its directory, or `memory://`.
 * @param overrides - Lock settings that differ from `DATABASE_DEFAULTS`.
 * @returns The database.
 */
async function openPglite(store: string, overrides: Partial<ConnectSettings>): Promise<OpenDatabase> {
  const isDirectory = store !== IN_MEMORY;
  let unlock = async (): Promise<void> => {};
  if (isDirectory) {
    mkdirSync(store, { recursive: true, mode: DIR_MODE });
    unlock = await takeLock(store, () => tryLockDirectory(store), overrides);
  }
  const client = new PGlite(store);
  await client.waitReady;
  return fromPglite(client, isDirectory ? store : 'memory', unlock);
}

/**
 * Wraps a PGlite client that is already open, such as a test's copy of a migrated template.
 *
 * @param client - The client.
 * @param [label] - What the boot log calls it.
 * @param [onClose] - Runs after it closes.
 * @returns The database.
 */
export function fromPglite(
  client: PGlite,
  label = 'memory',
  onClose: () => Promise<void> = async () => {},
): OpenDatabase {
  const db = drizzlePglite({ client, relations });
  return {
    db,
    kind: DatabaseKind.Pglite,
    label,
    migrate: async () => {
      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    close: async () => {
      await client.close();
      await onClose();
    },
  };
}

/** Where the data is kept. */
export interface DatabaseSettings {
  /** A postgres:// URL, or empty for PGlite. */
  url: string;
  /** DATA_DIR, which PGlite's directory is under. */
  dataDir: string;
  /** Whether this is a production run, which requires TLS to a Postgres host off the local network. */
  isProduction: boolean;
}

/**
 * Opens the database the settings name and takes its lock, so no other heautou uses it while this process runs. Waits
 * for Postgres to answer first, and for another process to let go for up to `lockWaitMs`. Writes nothing.
 *
 * @param settings - The URL and the data directory.
 * @param [overrides] - Connect and lock settings that differ from `DATABASE_DEFAULTS`; boot passes
 * `DB_CONNECT_TIMEOUT_MS`.
 * @param [onLockLost] - Called if Postgres's lock is lost while the database is open. By default the process exits 1.
 * @returns The database, not yet migrated.
 * @throws DatabaseLockError `DATABASE_IN_USE` when another process keeps the database, or what `waitForDatabase`
 * throws.
 */
export async function openDatabase(
  settings: DatabaseSettings,
  overrides: Partial<ConnectSettings> = {},
  onLockLost: (error: DatabaseLockError) => void = exitOnLockLost,
): Promise<OpenDatabase> {
  if (settings.url !== '') {
    return openPostgres(settings.url, settings.isProduction, overrides, onLockLost);
  }
  return openPglite(path.join(settings.dataDir, PGLITE_DIRECTORY), overrides);
}
