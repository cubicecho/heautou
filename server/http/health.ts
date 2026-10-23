import { sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { version } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import type { Database } from '../db/client.ts';

/** Where the health check's own failures are reported. */
const LOG_TAG = '[health]';

/**
 * Builds the `/healthz` handler.
 *
 * @param db - The database, which must answer for the server to be healthy.
 * @returns The handler: 200 with `{ ok, version }` while the database answers, 503 with `ok: false` when it does not.
 */
export function healthHandler(db: Database): RequestHandler {
  return async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ ok: true, version: version() });
    } catch (error) {
      console.error(LOG_TAG, 'the database does not answer:', errorMessage(error));
      res.status(HttpStatus.ServiceUnavailable).json({ ok: false, version: version() });
    }
  };
}
