import express, { type Response, Router } from 'express';
import { z } from 'zod';
import { ADMIN_DEFAULTS, BRANDING_DEFAULTS, HTTP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { type LoginThrottle, sendTooMany } from '../http/rate-limit.ts';
import type { SessionTools } from '../oidc/sessions.ts';
import type { AdminSessionStore } from '../store/admin-sessions.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { ClientStore } from '../store/clients.ts';
import type { PasswordLinkStore } from '../store/password-links.ts';
import { isAdmin, type UserStore } from '../store/users.ts';
import { ADMIN_CLIENT_NAME, ADMIN_PATH, adminUrls, brandingView, WEB_APP_PAGE } from './admin-client.ts';
import { COOKIE, sessionCookieOptions, signedInUser } from './routes.ts';

/** What the account, password link and branding routes use. */
export interface AccountDeps {
  users: UserStore;
  clients: ClientStore;
  adminSessions: AdminSessionStore;
  passwordLinks: PasswordLinkStore;
  sessions: SessionTools;
  branding: BrandingStore;
  issuer: string;
  throttle: LoginThrottle;
}

const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string() });
const linkSchema = z.object({ token: z.string().min(1) });
const setWithLinkSchema = linkSchema.extend({ password: z.string() });

/**
 * The logo's own policy: an SVG opened on its own runs no script and loads nothing.
 */
const LOGO_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Answers a refused link the same way whatever the reason, so a guess learns nothing.
 *
 * @param res - The response.
 */
function sendDeadLink(res: Response): void {
  sendRefusal(res, HttpStatus.NotFound, 'This link has expired or was already used. Ask an admin for a new one.');
}

/**
 * Builds the routes of a user's own account, of password links and of the branding every page shows.
 *
 * @param deps - The stores.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /admin/account` says who is signed in, with their sessions, or 401. `POST /admin/account/password` changes
 * their password given the current one, and `POST /admin/account/sign-out-everywhere` ends every session and token.
 * `POST /admin/password-link` names a link's user and `POST /admin/password-link/set` sets the password with it;
 * the token travels in the body, never in a URL. `GET /admin/branding` and `/admin/branding/logo` are public: the
 * sign-in page shows them.
 */
export function createAccountRouter(deps: AccountDeps): Router {
  const { users, clients, adminSessions, passwordLinks, sessions, branding, issuer, throttle } = deps;
  const urls = adminUrls(issuer);
  const json = [sameOriginJson(urls.origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];
  const clientName = (clientId: string): string =>
    clientId === ADMIN_DEFAULTS.clientId ? ADMIN_CLIENT_NAME : (clients.find(clientId)?.name ?? clientId);
  const router = Router();

  router.get(ADMIN_PATH.account, (req, res) => {
    const user = signedInUser(deps, req);
    if (user === null) {
      sendRefusal(res, HttpStatus.Unauthorized, 'Sign in first.');
      return;
    }
    const { id, username, name, email, groups } = user;
    res.json({
      id,
      username,
      name,
      email,
      groups,
      isAdmin: isAdmin(user),
      sessions: sessions.sessionsOf(id).map(({ clientIds, ...session }) => ({
        ...session,
        clientNames: clientIds.map(clientName),
      })),
    });
  });

  router.post(ADMIN_PATH.accountPassword, ...json, async (req, res) => {
    const user = signedInUser(deps, req);
    if (user === null) {
      sendRefusal(res, HttpStatus.Unauthorized, 'Sign in first.');
      return;
    }
    const parsed = changePasswordSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the current password and the new one.');
      return;
    }
    const ip = req.ip ?? '';
    const wait = throttle.wait(ip, user.username);
    if (wait > 0) {
      sendTooMany(res, wait);
      return;
    }
    const checked = await users.authenticate(user.username, parsed.data.currentPassword);
    if (checked === null) {
      throttle.fail(ip, user.username);
      sendRefusal(res, HttpStatus.Forbidden, 'That is not your current password.');
      return;
    }
    try {
      users.setPassword(user.id, parsed.data.newPassword);
      passwordLinks.cancelFor(user.id);
      throttle.succeed(user.username);
      res.json({ ok: true });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  router.post(ADMIN_PATH.accountSignOut, ...json, (req, res) => {
    const user = signedInUser(deps, req);
    if (user !== null) {
      sessions.revokeAccount(user.id);
      adminSessions.removeUser(user.id);
    }
    res.clearCookie(COOKIE.session, sessionCookieOptions(issuer));
    res.json({ redirectTo: `${ADMIN_PATH.login}?return=${encodeURIComponent(WEB_APP_PAGE.account)}` });
  });

  router.post(ADMIN_PATH.passwordLink, ...json, (req, res) => {
    const parsed = linkSchema.safeParse(req.body);
    const userId = parsed.success ? passwordLinks.find(parsed.data.token) : null;
    const user = userId === null ? null : users.find(userId);
    if (user === null) {
      sendDeadLink(res);
      return;
    }
    res.json({ username: user.username, isInvite: user.hasPassword === false });
  });

  router.post(ADMIN_PATH.passwordLinkSet, ...json, (req, res) => {
    const parsed = setWithLinkSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the link’s token and a password.');
      return;
    }
    const { token, password } = parsed.data;
    const userId = passwordLinks.find(token);
    if (userId === null || users.find(userId) === null) {
      sendDeadLink(res);
      return;
    }
    try {
      // Checked before the link is used up, so a password that is too short can be fixed and sent again.
      users.setPassword(userId, password);
      passwordLinks.consume(token);
      res.json({ redirectTo: `${ADMIN_PATH.login}?return=${encodeURIComponent(WEB_APP_PAGE.account)}` });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  router.get(ADMIN_PATH.branding, (_req, res) => {
    res.json(brandingView(branding.read()));
  });

  router.get(ADMIN_PATH.logo, (_req, res) => {
    const { logo } = branding.read();
    if (logo === null) {
      sendRefusal(res, HttpStatus.NotFound, 'There is no logo.');
      return;
    }
    res.set({
      'Content-Type': logo.type,
      'Content-Security-Policy': LOGO_CSP,
      'Cache-Control': `public, max-age=${BRANDING_DEFAULTS.logoCacheSeconds}`,
    });
    res.send(Buffer.from(logo.data, 'base64'));
  });

  return router;
}
