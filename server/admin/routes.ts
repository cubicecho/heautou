import { createHash, randomBytes } from 'node:crypto';
import express, { type CookieOptions, type RequestHandler, type Response, Router } from 'express';
import type Provider from 'oidc-provider';
import { z } from 'zod';
import { ADMIN_DEFAULTS, HTTP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import { readCookie, signValue, verifyValue } from '../http/cookies.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { type LoginThrottle, sendTooMany } from '../http/rate-limit.ts';
import { PAGE_PARAM, pageUrl, WEB_PAGE } from '../oidc/pages.ts';
import type { AdminSessionStore } from '../store/admin-sessions.ts';
import type { ProviderKeys } from '../store/keys.ts';
import { isAdmin, type PublicUser, type UserStore } from '../store/users.ts';
import { ADMIN_PATH, adminUrls } from './admin-client.ts';
import type { SetupGate } from './setup.ts';

/** The admin UI's cookies. */
const COOKIE = {
  /** The session: an opaque token, looked up in the session store. */
  session: 'heautou_admin',
  /** A sign-in under way: its state, PKCE verifier and return path, signed. */
  login: 'heautou_admin_login',
} as const;

/** The web page that makes the first admin. */
const SETUP_PAGE = '/setup';
/** Where a sign-in may return to: a path on this origin, not `//host` or `/\host`. */
const RETURN_PATTERN = /^\/(?![/\\])/;
const DEFAULT_RETURN = '/';

/** The error codes the web app's error page explains. */
const AdminError = { required: 'admin_required', signInFailed: 'admin_sign_in_failed' } as const;

const loginStateSchema = z.object({
  state: z.string(),
  verifier: z.string(),
  returnTo: z.string().regex(RETURN_PATTERN),
  expiresAt: z.number(),
});
type LoginState = z.infer<typeof loginStateSchema>;

const callbackQuerySchema = z.object({
  state: z.string(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const setupSchema = z.object({
  /** Left out or blank while the tokenless window is open. */
  token: z.string().trim().optional(),
  username: z.string().trim(),
  password: z.string(),
});

/** What the admin routes use. */
export interface AdminDeps {
  provider: Provider;
  users: UserStore;
  adminSessions: AdminSessionStore;
  setup: SetupGate;
  keys: ProviderKeys;
  issuer: string;
  throttle: LoginThrottle;
}

/**
 * Makes a random base64url string.
 *
 * @returns 32 random bytes, encoded.
 */
function randomToken(): string {
  return randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
}

/**
 * Looks up who an admin session cookie belongs to. Their groups are read again on every request, so taking
 * someone out of the admin group signs them out.
 *
 * @param deps - The stores.
 * @param cookie - The session cookie's value, if sent.
 * @returns The admin, or null.
 */
function adminFor(deps: Pick<AdminDeps, 'users' | 'adminSessions'>, cookie: string | null): PublicUser | null {
  const userId = cookie === null ? null : deps.adminSessions.find(cookie);
  const user = userId === null ? null : deps.users.find(userId);
  return user !== null && isAdmin(user) ? user : null;
}

/**
 * Refuses requests without an admin session with 401, and puts the admin in `res.locals.viewer`.
 *
 * @param deps - The stores.
 * @returns The middleware.
 */
export function requireAdmin(deps: Pick<AdminDeps, 'users' | 'adminSessions'>): RequestHandler {
  return (req, res, next) => {
    const viewer = adminFor(deps, readCookie(req, COOKIE.session));
    if (viewer === null) {
      sendRefusal(res, HttpStatus.Unauthorized, 'Sign in to the admin UI first.');
      return;
    }
    res.locals.viewer = viewer;
    next();
  };
}

/**
 * Sends the browser to the web app's error page for a failed admin sign-in.
 *
 * @param res - The response.
 * @param error - The error code.
 * @param description - What went wrong, for a person.
 */
function showError(res: Response, error: string, description: string): void {
  res.redirect(
    HttpStatus.SeeOther,
    pageUrl(WEB_PAGE.error, { [PAGE_PARAM.error]: error, [PAGE_PARAM.description]: description }),
  );
}

/**
 * Builds the admin UI's sign-in routes. The admin UI is a client of this provider like any other, except that
 * it is built in and that it swaps its code in-process, which works even when the issuer's public URL is not
 * reachable from inside the server.
 *
 * @param deps - The provider, the stores, the keys and the issuer.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /admin/login` starts a code flow with PKCE and `prompt=login`, so someone already signed in as a non-admin
 * can switch user. `GET /admin/callback` checks the code, the user's groups, and sets the session cookie.
 * `POST /admin/logout` ends it and points at the provider's logout. `GET`/`POST /admin/setup` makes the
 * first admin: a new user without a token for a while after boot, otherwise with the token from the server log.
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const { provider, users, adminSessions, setup, keys, issuer, throttle } = deps;
  const urls = adminUrls(issuer);
  const guard = sameOriginJson(urls.origin);
  const cookieBase: CookieOptions = { httpOnly: true, secure: urls.isHttps };
  const loginCookie: CookieOptions = { ...cookieBase, path: '/admin', sameSite: 'lax' };
  const sessionCookie: CookieOptions = { ...cookieBase, path: '/', sameSite: 'strict' };
  const router = Router();

  router.get(ADMIN_PATH.login, (req, res) => {
    if (setup.isNeeded()) {
      res.redirect(HttpStatus.SeeOther, SETUP_PAGE);
      return;
    }
    const asked = typeof req.query.return === 'string' ? req.query.return : DEFAULT_RETURN;
    const returnTo = RETURN_PATTERN.test(asked) ? asked : DEFAULT_RETURN;
    if (adminFor(deps, readCookie(req, COOKIE.session)) !== null) {
      res.redirect(HttpStatus.SeeOther, returnTo);
      return;
    }
    const login: LoginState = {
      state: randomToken(),
      verifier: randomToken(),
      returnTo,
      expiresAt: Date.now() + ADMIN_DEFAULTS.loginSeconds * MS_PER_SECOND,
    };
    const [signingKey = ''] = keys.cookieKeys;
    res.cookie(COOKIE.login, signValue(login, signingKey), {
      ...loginCookie,
      maxAge: ADMIN_DEFAULTS.loginSeconds * MS_PER_SECOND,
    });
    const authorize = new URL(`${issuer}/auth`);
    authorize.search = new URLSearchParams({
      client_id: ADMIN_DEFAULTS.clientId,
      redirect_uri: urls.callback,
      response_type: 'code',
      scope: 'openid',
      state: login.state,
      code_challenge: createHash('sha256').update(login.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'login',
    }).toString();
    res.redirect(HttpStatus.SeeOther, authorize.toString());
  });

  router.get(ADMIN_PATH.callback, async (req, res) => {
    const cookie = readCookie(req, COOKIE.login);
    res.clearCookie(COOKIE.login, loginCookie);
    const login = loginStateSchema.safeParse(cookie === null ? null : verifyValue(cookie, keys.cookieKeys));
    const query = callbackQuerySchema.safeParse(req.query);
    const isOurs =
      login.success && query.success && login.data.expiresAt > Date.now() && login.data.state === query.data.state;
    if (isOurs === false) {
      showError(res, AdminError.signInFailed, 'The sign-in expired or began in another browser. Try again.');
      return;
    }
    const { code: codeValue, error, error_description: description } = query.data;
    if (codeValue === undefined) {
      showError(res, AdminError.signInFailed, description ?? error ?? 'The provider sent no code.');
      return;
    }
    try {
      const code = await provider.AuthorizationCode.find(codeValue);
      const challenge = createHash('sha256').update(login.data.verifier).digest('base64url');
      const isValid =
        code?.isValid === true &&
        code.clientId === ADMIN_DEFAULTS.clientId &&
        code.redirectUri === urls.callback &&
        code.codeChallengeMethod === 'S256' &&
        code.codeChallenge === challenge;
      if (isValid === false) {
        showError(res, AdminError.signInFailed, 'The provider sent a code that is not for this sign-in.');
        return;
      }
      await code.consume();
      const user = users.find(code.accountId ?? '');
      if (user === null || isAdmin(user) === false) {
        const who = user === null ? 'That user' : `"${user.username}"`;
        showError(res, AdminError.required, `${who} is not in the "${ADMIN_DEFAULTS.group}" group.`);
        return;
      }
      res.cookie(COOKIE.session, adminSessions.create(user.id), {
        ...sessionCookie,
        maxAge: ADMIN_DEFAULTS.sessionSeconds * MS_PER_SECOND,
      });
      res.redirect(HttpStatus.SeeOther, login.data.returnTo);
    } catch (caught) {
      showError(res, AdminError.signInFailed, errorMessage(caught));
    }
  });

  router.post(ADMIN_PATH.logout, guard, (req, res) => {
    const cookie = readCookie(req, COOKIE.session);
    if (cookie !== null) {
      adminSessions.remove(cookie);
    }
    res.clearCookie(COOKIE.session, sessionCookie);
    const end = new URLSearchParams({ client_id: ADMIN_DEFAULTS.clientId });
    res.json({ redirectTo: `${issuer}/session/end?${end}` });
  });

  router.get(ADMIN_PATH.setup, (_req, res) => {
    res.json({ needed: setup.isNeeded(), tokenRequired: setup.isOpen() === false });
  });

  router.post(ADMIN_PATH.setup, guard, express.json({ limit: HTTP_DEFAULTS.bodyLimit }), async (req, res) => {
    const parsed = setupSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send a username and a password.');
      return;
    }
    const { token, username, password } = parsed.data;
    const ip = req.ip ?? '';
    const wait = throttle.wait(ip, username);
    if (wait > 0) {
      sendTooMany(res, wait);
      return;
    }
    if (setup.isNeeded() === false) {
      sendRefusal(res, HttpStatus.Conflict, 'There is an admin already. Sign in instead.');
      return;
    }
    const hasToken = token !== undefined && token !== '';
    if (hasToken && setup.matches(token) === false) {
      throttle.fail(ip, username);
      sendRefusal(res, HttpStatus.Forbidden, 'That setup token is not this boot’s. Copy the one in the server log.');
      return;
    }
    const existing = users.list().find((user) => user.username === username) ?? null;
    if (hasToken === false && existing !== null) {
      sendRefusal(
        res,
        HttpStatus.Forbidden,
        `"${username}" already exists. Making an existing user the admin needs the setup token from the server log.`,
      );
      return;
    }
    if (hasToken === false && setup.isOpen() === false) {
      sendRefusal(
        res,
        HttpStatus.Forbidden,
        'Setup without a token has closed. Use the setup token from the server log.',
      );
      return;
    }
    try {
      if (existing === null) {
        users.create({ username, password, email: '', name: '', groups: [ADMIN_DEFAULTS.group] });
      } else {
        const user = await users.authenticate(username, password);
        if (user === null) {
          throttle.fail(ip, username);
          sendRefusal(res, HttpStatus.Unauthorized, `"${username}" exists. Type their password to make them an admin.`);
          return;
        }
        const { email, name, groups } = user;
        users.update(user.id, { username, email, name, groups: [...groups, ADMIN_DEFAULTS.group] });
      }
      res.json({ redirectTo: ADMIN_PATH.login });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  return router;
}
