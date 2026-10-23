import { sql } from 'drizzle-orm';
import { DATABASE_DEFAULTS, type DatabaseSettings } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';

/** Error codes that mean "not up yet" rather than "misconfigured". `57P03` is Postgres starting up. */
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P03']);

/** Anything that can run a query. */
export interface Queryable {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * Reads the error code off a caught value.
 *
 * @param value - Anything that was thrown, or an error's `cause`.
 * @returns The code, or an empty string when there is none.
 */
function codeOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return '';
  }
  if ('code' in value && typeof value.code === 'string') {
    return value.code;
  }
  return '';
}

/**
 * Says whether a connection failure is worth retrying.
 *
 * @param error - The caught value. Drizzle wraps the driver's error as `cause`.
 * @returns True when the error or its cause carries a `RETRYABLE` code.
 */
function isRetryable(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return RETRYABLE.has(codeOf(error)) || RETRYABLE.has(codeOf(cause));
}

/**
 * Waits until Postgres answers `select 1`. Postgres is often still starting when the server boots: after a host
 * reboot, or in a compose stack.
 *
 * @param db - The database.
 * @param [overrides] - Settings that differ from `DATABASE_DEFAULTS`; boot passes `DB_CONNECT_TIMEOUT_MS`.
 * @param [log] - Called before each retry.
 * @returns Once connected.
 * @throws A non-retryable error (a wrong password, a missing database) at once, or the last error once the time is up.
 */
export async function waitForDatabase(
  db: Queryable,
  overrides: Partial<DatabaseSettings> = {},
  log: (message: string) => void = console.warn,
): Promise<void> {
  const settings = { ...DATABASE_DEFAULTS, ...overrides };
  const deadline = Date.now() + settings.connectTimeoutMs;
  const nextDelay = (delay: number): number => Math.min(delay * settings.retryBackoffFactor, settings.maxRetryDelayMs);
  for (let delay = settings.firstRetryDelayMs; ; delay = nextDelay(delay)) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      const isOutOfTime = Date.now() + delay > deadline;
      const shouldGiveUp = isRetryable(error) === false || isOutOfTime;
      if (shouldGiveUp) {
        throw error;
      }
      log(`[db] Postgres is not reachable yet, retrying in ${delay / MS_PER_SECOND}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
