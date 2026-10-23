import express, { type Response, Router } from 'express';
import { z } from 'zod';
import { ADMIN_PATH, adminUrls, brandingView, sessionClientName, WEB_APP_PAGE } from '../admin/admin-client.ts';
import { ADMIN_DEFAULTS, AUDIT_DEFAULTS, BRANDING_DEFAULTS, HTTP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { PasswordPolicy } from '../core/password-policy.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { type LoginThrottle, sendTooMany } from '../http/rate-limit.ts';
import type { SessionTools } from '../oidc/sessions.ts';
import { type AuditLog, type AuditTarget, AuditType, actorOf, SIGN_IN_TYPES } from '../store/audit.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { ClientStore } from '../store/clients.ts';
import type { PasswordLinkStore } from '../store/password-links.ts';
import type { SettingsStore } from '../store/settings.ts';
import { isAdmin, type UserStore } from '../store/users.ts';
import type { WebSessionStore } from '../store/web-sessions.ts';
import { PUBLIC_PATH } from './paths.ts';
import { ACCOUNT_API, clearSessionCookies, requireSignedIn, signedInUser, viewerOf } from './session.ts';

/** The routes of the signed-in user's own account. */
export const ACCOUNT_PATH = {
  /** Who is signed in, for the account page. */
  account: ACCOUNT_API,
  /** Changes the signed-in user's password (POST). */
  password: `${ACCOUNT_API}/password`,
  /** Ends every session of the signed-in user (POST). */
  signOut: `${ACCOUNT_API}/sign-out-everywhere`,
  /** The signed-in user's recent sign-ins, from the audit log. */
  activity: `${ACCOUNT_API}/activity`,
} as const;

/** What the account, password link and branding routes use. */
export interface AccountDeps {
  users: UserStore;
  clients: ClientStore;
  webSessions: WebSessionStore;
  passwordLinks: PasswordLinkStore;
  sessions: SessionTools;
  branding: BrandingStore;
  issuer: string;
  throttle: LoginThrottle;
  audit: AuditLog;
  /** Holds the password rules, which the strength meters read. */
  settings: SettingsStore;
  passwordPolicy: PasswordPolicy;
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
 * `GET /api/account` says who is signed in, with their sessions, or 401. `POST /api/account/password` changes
 * their password given the current one, and `POST /api/account/sign-out-everywhere` ends every session and token.
 * `GET /api/account/activity` lists their last `AUDIT_DEFAULTS.accountEntries` sign-ins.
 * `POST /api/password-link` names a link's user and `POST /api/password-link/set` sets the password with it;
 * the token travels in the body, never in a URL. `GET /api/branding`, `/api/branding/logo` and
 * `/api/password-rules` are public: the sign-in and set-password pages show them.
 */
export function createAccountRouter(deps: AccountDeps): Router {
  const { users, clients, webSessions, passwordLinks, sessions, branding, issuer, throttle, audit } = deps;
  const { settings, passwordPolicy } = deps;
  const urls = adminUrls(issuer);
  const json = [sameOriginJson(urls.origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];
  const clientName = (clientId: string): string => sessionClientName(clientId, clients, branding.read());
  /**
   * Names the client a sign-in was for: as it is called now, or as it was called when it has since been removed.
   *
   * @param target - The entry's target.
   * @returns The name.
   */
  const targetName = (target: AuditTarget): string =>
    target.id === ADMIN_DEFAULTS.clientId || clients.find(target.id) !== null ? clientName(target.id) : target.name;
  const signedIn = requireSignedIn(deps);
  const router = Router();

  router.get(ACCOUNT_PATH.account, signedIn, (_req, res) => {
    const user = viewerOf(res);
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

  router.get(ACCOUNT_PATH.activity, signedIn, async (_req, res) => {
    const user = viewerOf(res);
    const { entries } = await audit.list({
      first: AUDIT_DEFAULTS.accountEntries,
      types: SIGN_IN_TYPES,
      userId: user.id,
    });
    res.json({
      entries: entries.map(({ id, at, type, ip, target }) => ({
        id,
        at,
        type,
        ip,
        clientName: target === undefined ? null : targetName(target),
      })),
    });
  });

  router.post(ACCOUNT_PATH.password, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
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
      audit.record({ type: AuditType.AccountPasswordFailed, actor: actorOf(user), ip: req.ip ?? null });
      sendRefusal(res, HttpStatus.Forbidden, 'That is not your current password.');
      return;
    }
    try {
      await passwordPolicy.check(parsed.data.newPassword, user);
      await users.setPassword(user.id, parsed.data.newPassword);
      await passwordLinks.cancelFor(user.id);
      throttle.succeed(user.username);
      audit.record({ type: AuditType.AccountPasswordChanged, actor: actorOf(user), ip: req.ip ?? null });
      res.json({ ok: true });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  router.post(ACCOUNT_PATH.signOut, ...json, async (req, res) => {
    const user = signedInUser(deps, req);
    if (user !== null) {
      await webSessions.removeUser(user.id);
      await sessions.revokeAccount(user.id, req.ip ?? null);
      audit.record({ type: AuditType.AccountSignedOutEverywhere, actor: actorOf(user), ip: req.ip ?? null });
    }
    clearSessionCookies(res, issuer);
    res.json({ redirectTo: `${ADMIN_PATH.login}?return=${encodeURIComponent(WEB_APP_PAGE.account)}` });
  });

  router.post(PUBLIC_PATH.passwordLink, ...json, (req, res) => {
    const parsed = linkSchema.safeParse(req.body);
    const userId = parsed.success ? passwordLinks.find(parsed.data.token) : null;
    const user = userId === null ? null : users.find(userId);
    if (user === null) {
      sendDeadLink(res);
      return;
    }
    res.json({ username: user.username, isInvite: user.hasPassword === false });
  });

  router.post(PUBLIC_PATH.passwordLinkSet, ...json, async (req, res) => {
    const parsed = setWithLinkSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the link’s token and a password.');
      return;
    }
    const { token, password } = parsed.data;
    const userId = passwordLinks.find(token);
    const user = userId === null ? null : users.find(userId);
    if (user === null) {
      sendDeadLink(res);
      return;
    }
    try {
      // Checked before the link is used up, so a password the rules refuse can be fixed and sent again.
      await passwordPolicy.check(password, user);
      await users.setPassword(user.id, password);
      await passwordLinks.consume(token);
      audit.record({
        type: AuditType.PasswordLinkUsed,
        actor: actorOf(user),
        ip: req.ip ?? null,
        detail: { link: user.hasPassword ? 'reset' : 'invite' },
      });
      res.json({ redirectTo: `${ADMIN_PATH.login}?return=${encodeURIComponent(WEB_APP_PAGE.account)}` });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  router.get(PUBLIC_PATH.passwordRules, (_req, res) => {
    res.json({ minScore: settings.passwordRules().minScore });
  });

  router.get(PUBLIC_PATH.branding, (_req, res) => {
    res.json(brandingView(branding.read()));
  });

  router.get(PUBLIC_PATH.logo, (_req, res) => {
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
