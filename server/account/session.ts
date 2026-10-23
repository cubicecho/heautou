// The web session as the routes see it: its cookies, who a request's cookie belongs to, and the middleware that keeps
// that user for the handlers. Any enabled user has one; `requireAdmin` in `server/admin/routes.ts` adds the admin check.
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { adminUrls } from '../admin/admin-client.ts';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import { readCookie } from '../http/cookies.ts';
import { sendRefusal } from '../http/guards.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import type { WebSessionStore } from '../store/web-sessions.ts';

/** The web app's cookies. */
export const COOKIE = {
  /** The session: an opaque token, looked up in the session store. */
  session: 'heautou_session',
  /** A sign-in under way: its state, PKCE verifier and return path, signed. */
  login: 'heautou_sign_in',
} as const;

/**
 * What the session cookie was called before it was `heautou_session`. A request that still sends it is signed in
 * by it, and `moveFormerSessionCookie` swaps it for the new one on that response, so the upgrade signs nobody out.
 * A session lasts `ADMIN_DEFAULTS.sessionSeconds` (12 hours), so none is left once a build with the new name has run
 * that long: drop this and `moveFormerSessionCookie` in the release after the rename.
 */
export const FORMER_SESSION_COOKIE = 'heautou_admin';

/**
 * Where the routes of a signed-in user's own account are. Under `/api` rather than `/account`, which is the web app's
 * page (and the dev server forwards to the API by prefix); not under `/admin`, since any signed-in user calls them.
 */
export const ACCOUNT_API = '/api/account';

/** What finding a request's signed-in user reads. */
export interface SessionDeps {
  users: UserStore;
  webSessions: WebSessionStore;
}

/**
 * Reads a request's session token: the session cookie, else the cookie's former name.
 *
 * @param req - The request.
 * @returns The token, or null when neither cookie was sent.
 */
export function sessionTokenOf(req: Request): string | null {
  return readCookie(req, COOKIE.session) ?? readCookie(req, FORMER_SESSION_COOKIE);
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
  const cookie = sessionTokenOf(req);
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

/**
 * Sets the session cookie for a new session, and clears the cookie's former name.
 *
 * @param res - The response.
 * @param issuer - The issuer, for the cookie's options.
 * @param token - The session's token.
 */
export function setSessionCookie(res: Response, issuer: string, token: string): void {
  const options = sessionCookieOptions(issuer);
  res.clearCookie(FORMER_SESSION_COOKIE, options);
  res.cookie(COOKIE.session, token, { ...options, maxAge: ADMIN_DEFAULTS.sessionSeconds * MS_PER_SECOND });
}

/**
 * Clears the session cookie under its name and its former name, at sign-out.
 *
 * @param res - The response.
 * @param issuer - The issuer, for the cookie's options.
 */
export function clearSessionCookies(res: Response, issuer: string): void {
  const options = sessionCookieOptions(issuer);
  res.clearCookie(COOKIE.session, options);
  res.clearCookie(FORMER_SESSION_COOKIE, options);
}

/**
 * Swaps a session cookie still under its former name for the new one, on whatever response the browser gets next. A
 * former cookie whose session ended is only cleared. Removed with `FORMER_SESSION_COOKIE`.
 *
 * @param deps - The session store.
 * @param issuer - The issuer, for the cookie's options.
 * @returns The middleware.
 */
export function moveFormerSessionCookie(deps: Pick<SessionDeps, 'webSessions'>, issuer: string): RequestHandler {
  return (req, res, next) => {
    const former = readCookie(req, FORMER_SESSION_COOKIE);
    if (former !== null) {
      const isMoved = readCookie(req, COOKIE.session) !== null;
      if (isMoved === false && deps.webSessions.find(former) !== null) {
        setSessionCookie(res, issuer, former);
      } else {
        res.clearCookie(FORMER_SESSION_COOKIE, sessionCookieOptions(issuer));
      }
    }
    next();
  };
}
