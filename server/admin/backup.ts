import express, { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { BACKUP_DEFAULTS, HTTP_DEFAULTS } from '../core/defaults.ts';
import type { DataBackup } from '../core/services.ts';
import { HttpStatus } from '../core/wire.ts';
import { type PostBody, sameOriginJson, sameOriginPost, sendRefusal } from '../http/guards.ts';
import type { AdminSessionStore } from '../store/admin-sessions.ts';
import { type AuditLog, AuditType, actorOf } from '../store/audit.ts';
import { BackupError } from '../store/backup.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { ADMIN_PATH, adminUrls } from './admin-client.ts';
import { COOKIE, requireAdmin, sessionCookieOptions } from './routes.ts';

/** The backup routes. */
export const BACKUP_PATH = {
  /** GET: whether secrets are sealed. POST: downloads an archive. */
  backup: '/admin/backup',
  /** POST: replaces the data with an uploaded archive. */
  restore: '/admin/restore',
} as const;

/** The archive's media type: a cross-site form can't send it, so the restore is guarded like a JSON POST. */
const ARCHIVE_BODY: PostBody = { type: 'application/gzip', name: 'a backup archive' };
/** What body-parser calls a body over its limit. */
const TOO_LARGE = 'entity.too.large';

const downloadSchema = z.object({ includeSessions: z.boolean() });

/** What the backup routes use. */
export interface BackupDeps {
  backup: DataBackup;
  users: UserStore;
  adminSessions: AdminSessionStore;
  audit: AuditLog;
  issuer: string;
}

/**
 * Names a downloaded archive by when it was made.
 *
 * @param at - When, as epoch milliseconds.
 * @returns Such as `heautou-backup-2026-10-18T12-03-00Z.json.gz`.
 */
function archiveName(at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
  return `heautou-backup-${stamp}.json.gz`;
}

const parseArchive = express.raw({ type: ARCHIVE_BODY.type, limit: BACKUP_DEFAULTS.maxArchiveBytes });

/**
 * Reads the archive into `req.body` as bytes, answering one over `BACKUP_DEFAULTS.maxArchiveBytes` in JSON, as every
 * other refusal is.
 *
 * @param req - The request.
 * @param res - The response.
 * @param next - Called once the body is read, or with any other error.
 */
const readArchive: RequestHandler = (req, res, next) => {
  parseArchive(req, res, (error?: unknown) => {
    const isTooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === TOO_LARGE;
    if (isTooLarge) {
      sendRefusal(
        res,
        HttpStatus.PayloadTooLarge,
        `The archive is larger than a restore takes (${BACKUP_DEFAULTS.maxArchiveBytes} bytes).`,
      );
      return;
    }
    next(error);
  });
};

/**
 * Builds the admin's backup routes: whether secrets are sealed, downloading an archive of the data, and restoring
 * one. Every route needs an admin; the POSTs are same-origin only.
 *
 * @param deps - The backup, the stores it signs out of, the audit log and the issuer.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `POST /admin/restore` takes the archive as an `application/gzip` body. The session is checked before the body is
 * read. A restore replaces the web app's sessions, so it clears the caller's cookie and answers where to sign in.
 */
export function createBackupRouter(deps: BackupDeps): Router {
  const { backup, audit, issuer } = deps;
  const { origin } = adminUrls(issuer);
  const admin = requireAdmin(deps);
  const router = Router();

  router.get(BACKUP_PATH.backup, admin, (_req, res) => {
    res.json({ isSealed: backup.isSealed });
  });

  router.post(
    BACKUP_PATH.backup,
    sameOriginJson(origin),
    admin,
    express.json({ limit: HTTP_DEFAULTS.bodyLimit }),
    async (req, res) => {
      const parsed = downloadSchema.safeParse(req.body);
      if (parsed.success === false) {
        sendRefusal(res, HttpStatus.BadRequest, 'Say whether to include the sessions: {"includeSessions": true}.');
        return;
      }
      const { includeSessions } = parsed.data;
      try {
        const archive = await backup.create({ includeSessions });
        const viewer: PublicUser = res.locals.viewer;
        audit.record({
          type: AuditType.BackupDownloaded,
          actor: actorOf(viewer),
          ip: req.ip ?? null,
          detail: { sessions: includeSessions ? 'included' : 'left out' },
        });
        res.set({
          'Content-Type': ARCHIVE_BODY.type,
          'Content-Disposition': `attachment; filename="${archiveName(Date.now())}"`,
          'Cache-Control': 'no-store',
        });
        res.send(archive);
      } catch (error) {
        const message = error instanceof BackupError ? error.message : 'The backup could not be made.';
        console.error('[backup]', error);
        sendRefusal(res, HttpStatus.Conflict, message);
      }
    },
  );

  router.post(BACKUP_PATH.restore, sameOriginPost(origin, ARCHIVE_BODY), admin, readArchive, async (req, res) => {
    const archive: unknown = req.body;
    if (Buffer.isBuffer(archive) === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the archive as the body.');
      return;
    }
    const viewer: PublicUser = res.locals.viewer;
    try {
      const restored = await backup.restore(archive);
      audit.record({
        type: AuditType.DataRestored,
        actor: actorOf(viewer),
        ip: req.ip ?? null,
        detail: {
          madeAt: restored.createdAt,
          files: String(restored.files),
          sessions: restored.includesSessions ? 'included' : 'left out',
          via: 'web',
        },
      });
      res.clearCookie(COOKIE.session, sessionCookieOptions(issuer));
      res.json({ redirectTo: ADMIN_PATH.login, restored });
    } catch (error) {
      if (error instanceof BackupError) {
        sendRefusal(res, HttpStatus.BadRequest, error.message);
        return;
      }
      throw error;
    }
  });

  return router;
}
