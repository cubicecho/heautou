// The database lock: one process uses a database at a time. Each store keeps its document in memory and writes it
// through, so a second process on the same tables would overwrite the first's rows from stale memory. PGlite's lock is
// a file beside its directory that its holder keeps fresh; Postgres's is a session-level advisory lock held on a
// connection of its own.
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { z } from 'zod';
import { DATABASE_DEFAULTS, type DatabaseSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { DATABASE_LOCK_KEY, FILE_MODE, MS_PER_SECOND } from '../core/wire.ts';

/** Why a process can't use the database. */
export const DatabaseLockErrorCode = {
  /** Another process holds the lock. */
  InUse: 'DATABASE_IN_USE',
  /** The connection holding Postgres's lock dropped, so the lock is gone. */
  Lost: 'DATABASE_LOCK_LOST',
} as const;
export type DatabaseLockErrorCode = (typeof DatabaseLockErrorCode)[keyof typeof DatabaseLockErrorCode];

/** A database lock refused or lost, reported with a sentence the operator can act on. */
export class DatabaseLockError extends Error {
  readonly code: DatabaseLockErrorCode;

  /**
   * Makes the error.
   *
   * @param code - What went wrong.
   * @param message - What to do about it.
   */
  constructor(code: DatabaseLockErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseLockError';
    this.code = code;
  }
}

/**
 * Reads why the database could not be opened, for the log line a command stops with.
 *
 * @param error - The caught value.
 * @returns The message, after the code when it is a lock error.
 */
export function openFailure(error: unknown): string {
  return error instanceof DatabaseLockError ? `${error.code}: ${error.message}` : errorMessage(error);
}

/** Lets the lock go. */
export type ReleaseLock = () => Promise<void>;

/** One try for the lock: taken, or held by someone the operator can look for. */
export type LockAttempt = { isTaken: true; release: ReleaseLock } | { isTaken: false; holder: string };

/**
 * Builds the refusal for a database another process holds.
 *
 * @param label - The database, as the boot log names it.
 * @param holder - Who holds it, as far as can be told.
 * @returns The error.
 */
function inUse(label: string, holder: string): DatabaseLockError {
  return new DatabaseLockError(
    DatabaseLockErrorCode.InUse,
    `Another heautou is using ${label} (${holder}). Only one process may use a database: each keeps the data in memory, so a second would overwrite the first's changes. Stop the other one first: look for another container (\`docker ps\`, or a compose service scaled past 1) or a server started by hand on the same DATA_DIR or DATABASE_URL. \`npm run backup\` and \`npm run db:migrate\` need the server stopped too; to back up a running server, use Download backup under Settings.`,
  );
}

/**
 * Builds the error for a lock this process held and no longer does.
 *
 * @param label - The database, as the boot log names it.
 * @param reason - What happened to the lock.
 * @returns The error.
 */
function lockLost(label: string, reason: string): DatabaseLockError {
  return new DatabaseLockError(
    DatabaseLockErrorCode.Lost,
    `The lock on ${label} was lost (${reason}), so another process could now use it. Stopping rather than go on writing unguarded; starting again takes the lock again.`,
  );
}

/**
 * Takes the database lock, trying again while another process holds it: a restarted container can start before the
 * old one has finished shutting down.
 *
 * @param label - The database, for the messages.
 * @param tryLock - One try for the lock.
 * @param [overrides] - Settings that differ from `DATABASE_DEFAULTS`.
 * @param [log] - Called once, when the first try finds the lock held.
 * @returns What lets the lock go.
 * @throws DatabaseLockError `DATABASE_IN_USE` once `lockWaitMs` has passed with the lock still held.
 */
export async function takeLock(
  label: string,
  tryLock: () => Promise<LockAttempt>,
  overrides: Partial<DatabaseSettings> = {},
  log: (message: string) => void = console.warn,
): Promise<ReleaseLock> {
  const { lockWaitMs, lockRetryDelayMs } = { ...DATABASE_DEFAULTS, ...overrides };
  const deadline = Date.now() + lockWaitMs;
  for (let tries = 1; ; tries += 1) {
    const attempt = await tryLock();
    if (attempt.isTaken) {
      return attempt.release;
    }
    const isOutOfTime = Date.now() + lockRetryDelayMs > deadline;
    if (isOutOfTime) {
      throw inUse(label, attempt.holder);
    }
    if (tries === 1) {
      log(`[db] ${label} is in use (${attempt.holder}); waiting up to ${lockWaitMs / MS_PER_SECOND}s for it to stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, lockRetryDelayMs));
  }
}

/** A row as node-postgres returns one. */
type Row = Record<string, unknown>;

/** The connection that holds Postgres's lock: a `pg.Client` of its own, never one from the pool. */
export interface LockSession {
  connect: () => Promise<unknown>;
  query: (text: string, values: unknown[]) => Promise<{ rows: Row[] }>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  end: () => Promise<void>;
}

/** Takes the advisory lock if nobody holds it. Session-level, so it lasts as long as the connection. */
const TRY_LOCK = 'select pg_try_advisory_lock($1::bigint) as "isTaken"';
/**
 * Finds the session holding the lock. Postgres files a bigint advisory key as its high 32 bits in `classid`, its low
 * 32 bits in `objid` and 1 in `objsubid`.
 */
const FIND_HOLDER = `select l.pid, host(a.client_addr) as address
  from pg_locks l left join pg_stat_activity a on a.pid = l.pid
  where l.locktype = 'advisory' and l.granted and l.objsubid = 1
    and l.classid = ($1::bigint >> 32)::oid and l.objid = ($1::bigint & 4294967295)::oid`;

/**
 * Says who holds the lock, for the refusal. Best effort: the holder may let go in between, and a role without
 * `pg_read_all_stats` sees no other role's address.
 *
 * @param session - The lock connection.
 * @returns The holder's Postgres process and the address it connects from.
 */
async function describeHolder(session: LockSession): Promise<string> {
  try {
    const { rows } = await session.query(FIND_HOLDER, [DATABASE_LOCK_KEY]);
    const [row] = rows;
    if (row === undefined) {
      return 'it has just let go';
    }
    const from = typeof row.address === 'string' ? `from ${row.address}` : 'on a local socket';
    return `Postgres process ${String(row.pid)}, connected ${from}`;
  } catch (error) {
    return `its holder could not be read: ${errorMessage(error)}`;
  }
}

/**
 * Takes Postgres's lock on a connection of its own and holds it for the process's life. Nothing else runs on that
 * connection, so the pool's connections can come and go without letting the lock go.
 *
 * @param session - A connection not yet open.
 * @param label - The database, for the messages.
 * @param onLost - Called once if the connection drops while the lock is held: from then on another process may take it.
 * @param [overrides] - Settings that differ from `DATABASE_DEFAULTS`.
 * @param [log] - Called once, when the first try finds the lock held.
 * @returns What ends the connection, letting the lock go.
 * @throws DatabaseLockError `DATABASE_IN_USE` when another process keeps it, or the connection's error. The
 * connection is closed either way.
 */
export async function holdPostgresLock(
  session: LockSession,
  label: string,
  onLost: (error: DatabaseLockError) => void,
  overrides: Partial<DatabaseSettings> = {},
  log: (message: string) => void = console.warn,
): Promise<ReleaseLock> {
  let isHeld = false;
  let isReleasing = false;
  const lose = (reason: string): void => {
    const isUnexpected = isHeld && isReleasing === false;
    if (isUnexpected) {
      isHeld = false;
      onLost(lockLost(label, `its connection dropped: ${reason}`));
    }
  };
  // Before the lock is held, a failing query rejects on its own; this listener also stops an unhandled 'error'.
  session.on('error', (error) => lose(errorMessage(error)));
  session.on('end', () => lose('the connection ended'));
  const release: ReleaseLock = async () => {
    isReleasing = true;
    await session.end();
  };
  try {
    await session.connect();
    await takeLock(
      label,
      async () => {
        const { rows } = await session.query(TRY_LOCK, [DATABASE_LOCK_KEY]);
        if (rows[0]?.isTaken === true) {
          return { isTaken: true, release };
        }
        return { isTaken: false, holder: await describeHolder(session) };
      },
      overrides,
      log,
    );
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
  isHeld = true;
  return release;
}

/** The file beside PGlite's directory that says who has it open. */
const LOCK_SUFFIX = '.lock';

/** What a lock file says about its holder. */
const directoryHolderSchema = z.object({
  /** Made by each open, so it tells two processes apart even when both are pid 1 in containers of their own. */
  token: z.string(),
  pid: z.number(),
  host: z.string(),
});
type DirectoryHolder = z.infer<typeof directoryHolderSchema>;

/**
 * Reads a lock file's holder.
 *
 * @param lock - The lock file.
 * @returns The holder, or null when the file is gone or is not one this version wrote (an older one held a bare pid).
 */
function readHolder(lock: string): DirectoryHolder | null {
  try {
    return directoryHolderSchema.safeParse(JSON.parse(readFileSync(lock, 'utf8'))).data ?? null;
  } catch {
    return null;
  }
}

/**
 * Says how long ago a lock file was last refreshed.
 *
 * @param lock - The lock file.
 * @returns Its age in milliseconds, or null when there is none.
 */
function lockAgeMs(lock: string): number | null {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Says whether a caught value is the error for a file that already exists.
 *
 * @param error - The caught value.
 * @returns True for `EEXIST`.
 */
function isAlreadyThere(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Claims PGlite's directory with a lock file beside it, and refreshes the file while the directory is open. PGlite has
 * no server of its own, so two processes on one directory would each write it and corrupt it. A process id alone
 * can't say who holds it: two containers on one volume can both be pid 1, and neither sees the other's processes. So
 * the file names its holder by a token of its own, and a holder counts as gone once the file goes `lockStaleMs`
 * without a refresh.
 *
 * @param directory - PGlite's directory.
 * @param onLost - Called once if another process takes the lock file over while it is held.
 * @param [overrides] - Settings that differ from `DATABASE_DEFAULTS`.
 * @param [log] - Called once, when the first try finds the lock held.
 * @returns What stops the refreshes and removes the file.
 * @throws DatabaseLockError `DATABASE_IN_USE` when another process keeps the directory.
 */
export async function holdDirectoryLock(
  directory: string,
  onLost: (error: DatabaseLockError) => void,
  overrides: Partial<DatabaseSettings> = {},
  log: (message: string) => void = console.warn,
): Promise<ReleaseLock> {
  const { lockHeartbeatMs, lockStaleMs } = { ...DATABASE_DEFAULTS, ...overrides };
  const lock = `${directory}${LOCK_SUFFIX}`;
  const self: DirectoryHolder = { token: randomUUID(), pid: process.pid, host: hostname() };
  const isOurs = (): boolean => readHolder(lock)?.token === self.token;
  let heartbeat: NodeJS.Timeout | undefined;
  const release: ReleaseLock = async () => {
    clearInterval(heartbeat);
    if (isOurs()) {
      rmSync(lock, { force: true });
    }
  };

  const tryLock = async (): Promise<LockAttempt> => {
    const ageMs = lockAgeMs(lock);
    if (ageMs !== null && ageMs < lockStaleMs) {
      const holder = readHolder(lock);
      const who = holder === null ? 'a process' : `process ${holder.pid} on ${holder.host}`;
      return { isTaken: false, holder: `${who} has it open, last seen ${Math.round(ageMs / MS_PER_SECOND)}s ago` };
    }
    if (ageMs !== null) {
      rmSync(lock, { force: true });
    }
    try {
      writeFileSync(lock, JSON.stringify(self), { mode: FILE_MODE, flag: 'wx' });
    } catch (error) {
      if (isAlreadyThere(error)) {
        return { isTaken: false, holder: 'another process opened it at the same moment' };
      }
      throw error;
    }
    return { isTaken: true, release };
  };

  await takeLock(directory, tryLock, overrides, log);
  heartbeat = setInterval(() => {
    try {
      if (isOurs()) {
        const now = new Date();
        utimesSync(lock, now, now);
        return;
      }
    } catch {
      // The file went between the read and the refresh: as lost as when another process rewrote it.
    }
    clearInterval(heartbeat);
    onLost(lockLost(directory, `another process took over ${lock}`));
  }, lockHeartbeatMs);
  heartbeat.unref();
  return release;
}
