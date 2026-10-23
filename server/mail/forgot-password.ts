import express, { Router } from 'express';
import { z } from 'zod';
import { HTTP_DEFAULTS, MAIL_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { createRateLimiter, sendTooMany } from '../http/rate-limit.ts';
import type { ProviderHost } from '../oidc/host.ts';
import { INTERACTION_PATH } from '../oidc/provider.ts';
import { type AuditLog, AuditType, actorOf, userTarget } from '../store/audit.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { PasswordLinkStore } from '../store/password-links.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { type Mailer, passwordLinkUrl } from './mailer.ts';
import { MailKind, passwordLinkContent } from './messages.ts';

/** The route under an interaction: GET says whether it is on, POST asks for a link. */
const FORGOT_PATH = 'forgot-password';
/** Where a failure after the answer is reported. */
const LOG_TAG = '[mail]';

const requestSchema = z.object({ identifier: z.string().trim().min(1).max(MAIL_DEFAULTS.maxIdentifierLength) });

/** What the forgot-password routes use. */
export interface ForgotPasswordDeps {
  host: ProviderHost;
  users: UserStore;
  passwordLinks: PasswordLinkStore;
  branding: BrandingStore;
  mailer: Mailer;
  audit: AuditLog;
  issuer: string;
  /** The issuer's origin; the POST must come from a page on it. */
  origin: string;
  /** The clock, in epoch milliseconds, for the rate limits. */
  now?: () => number;
}

/**
 * Finds the users a forgot-password request names: by username or by email address, ignoring case.
 *
 * @param users - Every user.
 * @param identifier - What was typed.
 * @returns The users it names: one by username, else every one with that address.
 */
function usersNamed(users: PublicUser[], identifier: string): PublicUser[] {
  const wanted = identifier.toLowerCase();
  const byUsername = users.filter((user) => user.username.toLowerCase() === wanted);
  return byUsername.length > 0
    ? byUsername
    : users.filter((user) => user.email !== '' && user.email.toLowerCase() === wanted);
}

/**
 * Builds the "Forgot password?" routes of the sign-in page.
 *
 * @param deps - The provider, the stores and the mailer.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /interaction/:uid/forgot-password` says whether the link is shown: email is set up and the operator turned it
 * on. `POST` takes `{ identifier }`, a username or an email address, and always answers `{ ok: true }` once the
 * sign-in is known and the rate limits pass, whoever it names. The users are looked up and the email sent after the
 * answer, so neither the reply nor its timing says whether anyone matched. A disabled user, or one with no address,
 * gets nothing. The link's fragment carries the interaction's uid, so the set-password page can go back to it.
 */
export function createForgotPasswordRouter(deps: ForgotPasswordDeps): Router {
  const { host, users, passwordLinks, branding, mailer, audit, issuer, now = Date.now } = deps;
  const windowSeconds = MAIL_DEFAULTS.forgotWindowSeconds;
  const byIp = createRateLimiter({ limit: MAIL_DEFAULTS.forgotPerIp, windowSeconds, now });
  const byIdentifier = createRateLimiter({ limit: MAIL_DEFAULTS.forgotPerIdentifier, windowSeconds, now });
  const router = Router();
  const path = `${INTERACTION_PATH}/:uid/${FORGOT_PATH}`;

  /**
   * Looks the request up and sends the links. Runs after the answer has gone.
   *
   * @param identifier - What was typed.
   * @param uid - The sign-in it was asked from.
   * @param ip - Who asked.
   * @returns Once the links are saved and their emails handed to the mailer.
   */
  const sendLinks = async (identifier: string, uid: string, ip: string | null): Promise<void> => {
    const named = usersNamed(users.list(), identifier);
    if (named.length === 0) {
      audit.record({ type: AuditType.PasswordResetRequested, actor: null, ip, detail: { identifier } });
      return;
    }
    const brandName = branding.read().name;
    for (const user of named) {
      const isRefused = user.disabled || user.email === '';
      audit.record({
        type: AuditType.PasswordResetRequested,
        actor: actorOf(user),
        ip,
        target: userTarget(user),
        detail: isRefused ? { refused: user.disabled ? 'disabled' : 'no_email' } : undefined,
      });
      if (isRefused) {
        continue;
      }
      const { token, expiresAt } = await passwordLinks.issue(user.id);
      const url = passwordLinkUrl(issuer, token, uid);
      const content = passwordLinkContent(MailKind.ForgotPassword, user, brandName, url, new Date(expiresAt));
      mailer.sendInBackground(MailKind.ForgotPassword, user.email, content, {
        actor: actorOf(user),
        ip,
        target: userTarget(user),
      });
    }
  };

  router.get(path, (_req, res) => {
    res.json({ isAvailable: mailer.isOn('forgotPassword') });
  });

  router.post(path, sameOriginJson(deps.origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit }), async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Type your username or email address.');
      return;
    }
    if (mailer.isOn('forgotPassword') === false) {
      sendRefusal(res, HttpStatus.NotFound, 'Resetting a password by email is off. Ask an admin for a link.');
      return;
    }
    let uid: string;
    try {
      ({ uid } = await host.current().interactionDetails(req, res));
    } catch (error) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(error));
      return;
    }
    const { identifier } = parsed.data;
    const ip = req.ip ?? '';
    const identifierKey = identifier.toLowerCase();
    // Counted whether or not anyone matches, so the limit says nothing about who exists.
    const wait = Math.max(
      byIp.isBlocked(ip) ? byIp.retryAfter(ip) : 0,
      byIdentifier.isBlocked(identifierKey) ? byIdentifier.retryAfter(identifierKey) : 0,
    );
    if (wait > 0) {
      sendTooMany(res, wait);
      return;
    }
    byIp.add(ip);
    byIdentifier.add(identifierKey);
    res.json({ ok: true });
    setImmediate(() => {
      sendLinks(identifier, uid, req.ip ?? null).catch((error: unknown) => {
        console.error(LOG_TAG, 'could not send a reset link:', errorMessage(error));
      });
    });
  });

  return router;
}
