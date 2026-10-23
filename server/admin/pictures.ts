import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express, { type Request, type RequestHandler, type Response, Router } from 'express';
import { requireSignedIn, viewerOf } from '../account/session.ts';
import { HTTP_DEFAULTS, PROFILE_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { ObjectStorageError } from '../core/object-storage.ts';
import { PICTURE_ROUTE, PICTURE_TOO_LARGE, type ProfilePictures, STORED_PICTURE_TYPE } from '../core/pictures.ts';
import { HttpStatus } from '../core/wire.ts';
import { type PostBody, sameOriginJson, sameOriginPost, sendRefusal } from '../http/guards.ts';
import { type AuditActor, type AuditLog, AuditType, actorOf, userTarget } from '../store/audit.ts';
import type { UserStore } from '../store/users.ts';
import type { WebSessionStore } from '../store/web-sessions.ts';
import { adminUrls } from './admin-client.ts';
import { requireAdmin } from './routes.ts';

/** The picture routes. */
export const PICTURE_PATH = {
  /** GET: whether pictures are on, and the signed-in user's. POST: sets theirs from an image body. */
  account: '/admin/account/picture',
  /** POST: removes the signed-in user's picture. */
  accountRemove: '/admin/account/picture/remove',
  /** POST, admins only: sets a user's picture from an image body. */
  user: '/admin/users/:id/picture',
  /** POST, admins only: removes a user's picture. */
  userRemove: '/admin/users/:id/picture/remove',
  /** GET, public: the picture itself, which the `picture` claim points at. */
  picture: PICTURE_ROUTE,
} as const;

/** An upload's body: the image's own type. A cross-site form can't send one, so it is guarded like a JSON POST. */
const IMAGE_BODY: PostBody = { type: 'image/*', name: 'a PNG, JPEG or WebP image' };
/** What body-parser calls a body over its limit. */
const TOO_LARGE = 'entity.too.large';
/** The picture's own policy: opened on its own, it runs nothing and loads nothing. */
const PICTURE_CSP = "default-src 'none'; sandbox";

const parseImage = express.raw({ type: IMAGE_BODY.type, limit: PROFILE_DEFAULTS.maxPictureBytes });

/**
 * Reads the image into `req.body` as bytes, answering one over `PROFILE_DEFAULTS.maxPictureBytes` in JSON, as every
 * other refusal is.
 *
 * @param req - The request.
 * @param res - The response.
 * @param next - Called once the body is read, or with any other error.
 */
const readImage: RequestHandler = (req, res, next) => {
  parseImage(req, res, (error?: unknown) => {
    const isTooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === TOO_LARGE;
    if (isTooLarge) {
      sendRefusal(res, HttpStatus.PayloadTooLarge, PICTURE_TOO_LARGE);
      return;
    }
    next(error);
  });
};

/** What the picture routes use. */
export interface PictureDeps {
  pictures: ProfilePictures;
  users: UserStore;
  webSessions: WebSessionStore;
  audit: AuditLog;
  issuer: string;
}

/**
 * Answers a picture change that failed: the bucket's failure as a 502, anything else as a 400 with its message.
 *
 * @param res - The response.
 * @param error - What was thrown.
 */
function sendFailure(res: Response, error: unknown): void {
  if (error instanceof ObjectStorageError) {
    console.error(`[pictures] ${error.message}`);
    sendRefusal(res, HttpStatus.BadGateway, 'The picture store could not be reached. Try again later.');
    return;
  }
  sendRefusal(res, HttpStatus.BadRequest, errorMessage(error));
}

/**
 * Says whether a request already holds the picture: its `If-None-Match` names the current ETag.
 *
 * @param req - The request.
 * @param etag - The picture's ETag.
 * @returns True when a 304 will do.
 */
function isFresh(req: Request, etag: string): boolean {
  const sent = req.get('if-none-match') ?? '';
  return sent === '*' || sent.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/**
 * Builds the routes that set, remove and serve profile pictures.
 *
 * @param deps - The pictures, the stores, the audit log and the issuer.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /users/:id/picture` is public, as apps show it to people who are not signed in here. It streams from the
 * bucket, which stays private. Its ETag is the picture's version, and a URL whose `?v=` is the current version may
 * be kept for `PROFILE_DEFAULTS.versionedCacheSeconds`. Uploads are the image itself as the body, with its own
 * `Content-Type`; the type is checked again by its bytes.
 */
export function createPictureRouter(deps: PictureDeps): Router {
  const { pictures, users, audit, issuer } = deps;
  const { origin } = adminUrls(issuer);
  const admin = requireAdmin(deps);
  const router = Router();

  const signedIn = requireSignedIn(deps);

  /**
   * Sets a picture from the request's body and records who did it.
   *
   * @param req - The request, with the image as its body.
   * @param res - The response: the picture's URL.
   * @param userId - Whose picture.
   * @param actor - Who set it.
   */
  const setFrom = async (req: Request, res: Response, userId: string, actor: AuditActor): Promise<void> => {
    const body: unknown = req.body;
    if (Buffer.isBuffer(body) === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the image as the body.');
      return;
    }
    try {
      const user = await pictures.set(userId, body, req.get('content-type') ?? '');
      audit.record({ type: AuditType.PictureSet, actor, ip: req.ip ?? null, target: userTarget(user) });
      res.json({ url: pictures.urlOf(user) });
    } catch (error) {
      sendFailure(res, error);
    }
  };

  /**
   * Removes a picture and records who did it.
   *
   * @param req - The request.
   * @param res - The response.
   * @param userId - Whose picture.
   * @param actor - Who removed it.
   */
  const removeFor = async (req: Request, res: Response, userId: string, actor: AuditActor): Promise<void> => {
    try {
      const had = users.find(userId)?.pictureVersion ?? null;
      const user = await pictures.remove(userId);
      if (had !== null) {
        audit.record({ type: AuditType.PictureRemoved, actor, ip: req.ip ?? null, target: userTarget(user) });
      }
      res.json({ url: null });
    } catch (error) {
      sendFailure(res, error);
    }
  };

  const json = [sameOriginJson(origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];

  router.get(PICTURE_PATH.account, signedIn, (_req, res) => {
    const viewer = viewerOf(res);
    res.json({
      isEnabled: pictures.isEnabled,
      maxBytes: PROFILE_DEFAULTS.maxPictureBytes,
      url: pictures.urlOf(viewer),
    });
  });

  router.post(PICTURE_PATH.account, sameOriginPost(origin, IMAGE_BODY), signedIn, readImage, async (req, res) => {
    const viewer = viewerOf(res);
    await setFrom(req, res, viewer.id, actorOf(viewer));
  });

  router.post(PICTURE_PATH.accountRemove, ...json, signedIn, async (req, res) => {
    const viewer = viewerOf(res);
    await removeFor(req, res, viewer.id, actorOf(viewer));
  });

  router.post(PICTURE_PATH.user, sameOriginPost(origin, IMAGE_BODY), admin, readImage, async (req, res) => {
    const viewer = viewerOf(res);
    await setFrom(req, res, String(req.params.id), actorOf(viewer));
  });

  router.post(PICTURE_PATH.userRemove, ...json, admin, async (req, res) => {
    const viewer = viewerOf(res);
    await removeFor(req, res, String(req.params.id), actorOf(viewer));
  });

  router.get(PICTURE_PATH.picture, async (req, res) => {
    const user = users.find(String(req.params.id));
    const version = user?.pictureVersion ?? null;
    if (user === null || version === null || pictures.isEnabled === false) {
      sendRefusal(res, HttpStatus.NotFound, 'This user has no picture.');
      return;
    }
    const { versionedCacheSeconds, unversionedCacheSeconds } = PROFILE_DEFAULTS;
    const isCurrentUrl = req.query.v === version;
    const etag = `"${version}"`;
    res.set({
      ETag: etag,
      'Cache-Control': isCurrentUrl
        ? `public, max-age=${versionedCacheSeconds}, immutable`
        : `public, max-age=${unversionedCacheSeconds}`,
      // Apps on other origins show it in an `<img>`.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (isFresh(req, etag)) {
      res.status(HttpStatus.NotModified).end();
      return;
    }
    try {
      const picture = await pictures.open(user);
      if (picture === null) {
        sendRefusal(res, HttpStatus.NotFound, 'This user has no picture.');
        return;
      }
      res.set({ 'Content-Type': STORED_PICTURE_TYPE, 'Content-Security-Policy': PICTURE_CSP });
      if (picture.contentLength !== null) {
        res.set('Content-Length', String(picture.contentLength));
      }
      // fetch's body is Node's own web stream; the DOM typings the server also loads only name it differently.
      const stream = Readable.fromWeb(picture.body as NodeReadableStream<Uint8Array>);
      stream.on('error', (error) => {
        console.error(`[pictures] Streaming the picture of ${user.id} failed: ${errorMessage(error)}`);
        res.destroy();
      });
      stream.pipe(res);
    } catch (error) {
      if (error instanceof ObjectStorageError) {
        console.error(`[pictures] ${error.message}`);
        res.set('Cache-Control', 'no-store');
        sendRefusal(res, HttpStatus.BadGateway, 'The picture store could not be reached.');
        return;
      }
      throw error;
    }
  });

  return router;
}
