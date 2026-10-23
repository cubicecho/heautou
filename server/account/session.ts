// The web session as the routes see it: its cookies, who a request's cookie belongs to, and the middleware that keeps
// that user for the handlers. Any enabled user has one; `requireAdmin` in `server/admin/routes.ts` adds the admin check.
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { adminUrls } from '../admin/admin-client.ts';
import { HttpStatus } from '../core/wire.ts';
import { readCookie } from '../http/cookies.ts';
import { sendRefusal } from '../http/guards.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import type { WebSessionStore } from '../store/web-sessions.ts';

/** The web app's cookies. */
export const COOKIE = {
  /** The session: an opaque token, looked up in the session store. */
  session: 'heautou_admin',
  /** A sign-in under way: its state, PKCE verifier and return path, signed. */
  login: 'heautou_admin_login',
} as const;

/** What finding a request's signed-in user reads. */
export interface SessionDeps {
  users: UserStore;
  webSessions: WebSessionStore;
}

/**
 * Looks up who a request's session cookie belongs to. The user is read again on every request, so disabling
 * someone signs them out, and taking them out of the admin group takes the admin UI away.
 *
 * @param deps - The stores.
 * @param req - The request.
 * @returns The user, or null when there is no session or they are disabled.
 */
export function signedInUser(deps: SessionDeps, req: Request): PublicUser | null {
  const cookie = readCookie(req, COOKIE.session);
  const userId = cookie === null ? null : deps.webSessions.find(cookie);
  const user = userId === null ? null : deps.users.find(userId);
  return user !== null && user.disabled === false ? user : null;
}

/**
 * Keeps the signed-in user a request is for, for the handlers after the middleware that found them.
 *
 * @param res - The response.
 * @param user - The signed-in user.
 */
export function setViewer(res: Response, user: PublicUser): void {
  res.locals.viewer = user;
}

/**
 * Reads the signed-in user a request is for, which `requireSignedIn` or `requireAdmin` found.
 *
 * @param res - The response.
 * @returns The user.
 * @throws If neither middleware ran before the handler, which is a mistake in the route.
 */
export function viewerOf(res: Response): PublicUser {
  // Express types `res.locals` as `any`; only setViewer writes this key.
  const viewer: PublicUser | undefined = res.locals.viewer;
  if (viewer === undefined) {
    throw new Error('No signed-in user on this request. Put requireSignedIn or requireAdmin before the handler.');
  }
  return viewer;
}

/**
 * Refuses requests without a session with 401, and keeps the signed-in user for `viewerOf`. Any enabled user passes.
 *
 * @param deps - The stores.
 * @returns The middleware.
 */
export function requireSignedIn(deps: SessionDeps): RequestHandler {
  return (req, res, next) => {
    const viewer = signedInUser(deps, req);
    if (viewer === null) {
      sendRefusal(res, HttpStatus.Unauthorized, 'Sign in first.');
      return;
    }
    setViewer(res, viewer);
    next();
  };
}

/**
 * The session cookie's options: sent to every path of this origin, never cross-site.
 *
 * @param issuer - The issuer, which says whether the cookie is `Secure`.
 * @returns The options.
 */
export function sessionCookieOptions(issuer: string): CookieOptions {
  return { httpOnly: true, secure: adminUrls(issuer).isHttps, path: '/', sameSite: 'strict' };
}
