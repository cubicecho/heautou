import type { RequestHandler } from 'express';
import { version } from '../core/config.ts';

/**
 * Builds the `/healthz` handler.
 *
 * @returns The handler: 200 with `{ ok, version }` while the process serves requests.
 */
export function healthHandler(): RequestHandler {
  return (_req, res) => {
    res.json({ ok: true, version: version() });
  };
}
