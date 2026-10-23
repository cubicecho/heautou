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
import { DIR_MODE, FILE_MODE } from '../core/wire.ts';
import { relations } from './relations.ts';
import { requiresSsl } from './ssl.ts';

/** The Drizzle client, whichever driver is under it. */
export type Database = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;

/** A transaction on it, as `Database.transaction` hands one to its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The generated migrations, committed at the repository root. */
export const MIGRATIONS_FOLDER = path.join(import.meta.dirname, '..', '..', 'drizzle');
/** PGlite's directory under DATA_DIR. */
export const PGLITE_DIRECTORY = 'pg';
/** The file that says a process has PGlite's directory open. */
const LOCK_SUFFIX = '.lock';
/** A PGlite store that lives only in memory, for tests. */
export const IN_MEMORY = 'memory://';

/** Which engine holds the data. */
export const DatabaseKind = { Pglite: 'pglite', Postgres: 'postgres' } as const;
export type DatabaseKind = (typeof DatabaseKind)[keyof typeof DatabaseKind];

/** An open database. */
export interface OpenDatabase {
  db: Database;
  kind: DatabaseKind;
  /** Where the data is, for the boot log: PGlite's directory, or the Postgres host. Never the password. */
  label: string;
  /** Applies the committed migrations that have not run yet. */
  migrate: () => Promise<void>;
  /** Closes it. PGlite flushes its directory and lets the next process open it. */
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
 * Claims PGlite's directory for this process. PGlite has no server of its own, so two processes on one directory
 * would each write it and corrupt it.
 *
 * @param directory - PGlite's directory.
 * @returns Lets the directory go.
 * @throws When another running process holds it, such as the server while `npm run backup` runs.
 */
function lockDirectory(directory: string): () => void {
  const lock = `${directory}${LOCK_SUFFIX}`;
  const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8').trim()) : Number.NaN;
  if (isOtherProcessRunning(holder)) {
    throw new Error(`${directory} is open in process ${holder}. Stop it first: PGlite's data can't be shared.`);
  }
  writeFileSync(lock, String(process.pid), { mode: FILE_MODE });
  return () => rmSync(lock, { force: true });
}

/**
 * Opens a Postgres server with node-postgres. Nothing connects until the first query.
 *
 * @param url - A postgres:// URL.
 * @param isProduction - Whether TLS is required for a host off the local network.
 * @returns The database.
 */
function openPostgres(url: string, isProduction: boolean): OpenDatabase {
  const mustForceSsl = isProduction && requiresSsl(url);
  const pool = new pg.Pool({ connectionString: url, ...(mustForceSsl ? { ssl: true } : {}) });
  const db = drizzleNode({ client: pool, relations });
  const { host, port, pathname } = new URL(url);
  return {
    db,
    kind: DatabaseKind.Postgres,
    label: `postgres://${host}${port === '' ? '' : `:${port}`}${pathname}`,
    migrate: async () => {
      await migrateNode(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    close: () => pool.end(),
  };
}

/**
 * Opens PGlite in this process.
 *
 * @param store - Its directory, or `memory://`.
 * @returns The database.
 */
async function openPglite(store: string): Promise<OpenDatabase> {
  const isDirectory = store !== IN_MEMORY;
  let unlock = (): void => {};
  if (isDirectory) {
    mkdirSync(store, { recursive: true, mode: DIR_MODE });
    unlock = lockDirectory(store);
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
export function fromPglite(client: PGlite, label = 'memory', onClose: () => void = () => {}): OpenDatabase {
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
      onClose();
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
 * Opens the database the settings name. Postgres is not reached until the first query; `waitForDatabase` waits for
 * it.
 *
 * @param settings - The URL and the data directory.
 * @returns The database, not yet migrated.
 * @throws When PGlite's directory is open in another process.
 */
export async function openDatabase(settings: DatabaseSettings): Promise<OpenDatabase> {
  if (settings.url !== '') {
    return openPostgres(settings.url, settings.isProduction);
  }
  return openPglite(path.join(settings.dataDir, PGLITE_DIRECTORY));
}
