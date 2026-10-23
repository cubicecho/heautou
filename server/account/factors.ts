import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import express, { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { adminUrls } from '../admin/admin-client.ts';
import { HTTP_DEFAULTS, TWO_FACTOR_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import { matchTotp, newTotpSecret, totpUri } from '../core/totp.ts';
import { registrationOptions, relyingPartyOf, verifyRegistration } from '../core/webauthn.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { type LoginThrottle, sendTooMany } from '../http/rate-limit.ts';
import { type AuditLog, AuditType, actorOf } from '../store/audit.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { FactorStore } from '../store/factors.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import type { WebSessionStore } from '../store/web-sessions.ts';
import { ACCOUNT_API, requireSignedIn, viewerOf } from './session.ts';

/** The account page's second-factor routes. Every one acts on the signed-in user. */
export const FACTOR_PATH = {
  /** What the user has set up, and whether passkeys work here. */
  factors: `${ACCOUNT_API}/factors`,
  /** Makes an authenticator app secret to scan (POST). */
  totpStart: `${ACCOUNT_API}/totp/start`,
  /** Turns the app on, given a code from it (POST). */
  totpConfirm: `${ACCOUNT_API}/totp/confirm`,
  /** Turns the app off, given the password (POST). */
  totpRemove: `${ACCOUNT_API}/totp/remove`,
  /** Makes new recovery codes, given the password (POST). */
  recoveryCodes: `${ACCOUNT_API}/recovery-codes`,
  /** Asks the browser to make a passkey (POST). */
  passkeyOptions: `${ACCOUNT_API}/passkeys/options`,
  /** Registers the passkey the browser made (POST). */
  passkeyAdd: `${ACCOUNT_API}/passkeys`,
  /** Removes a passkey, given the password (POST). */
  passkeyRemove: `${ACCOUNT_API}/passkeys/remove`,
} as const;

/** What the factor routes use. */
export interface FactorRouteDeps {
  users: UserStore;
  webSessions: WebSessionStore;
  factors: FactorStore;
  branding: BrandingStore;
  issuer: string;
  throttle: LoginThrottle;
  audit: AuditLog;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

const codeSchema = z.object({ code: z.string().trim().min(1) });
const passwordSchema = z.object({ password: z.string() });
const removePasskeySchema = passwordSchema.extend({ id: z.string().min(1) });
const addPasskeySchema = z.object({
  name: z.string().trim().min(1).max(TWO_FACTOR_DEFAULTS.maxPasskeyNameLength),
  // Its shape is checked by the WebAuthn library.
  response: z.looseObject({ id: z.string().min(1) }),
});

/**
 * Builds the routes a user sets up their second factors with on their account page.
 *
 * @param deps - The stores.
 * @returns A router to mount at the root.
 *
 * @remarks
 * Adding a factor needs only the session. Removing one, or making new recovery codes, also needs the password, so a
 * browser left signed in can't take a user's second factor away. The first factor a user adds comes with recovery
 * codes, shown once in the reply.
 */
export function createFactorRouter(deps: FactorRouteDeps): Router {
  const { users, factors, branding, throttle, audit, now = Date.now } = deps;
  const rp = relyingPartyOf(deps.issuer);
  const json = [sameOriginJson(adminUrls(deps.issuer).origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];
  const setupSeconds = TWO_FACTOR_DEFAULTS.pendingSeconds;
  const totpSetups = createExpiringMap<string>(setupSeconds, now);
  const challenges = createExpiringMap<string>(TWO_FACTOR_DEFAULTS.passkeyTimeoutSeconds, now);
  const router = Router();

  const signedIn = requireSignedIn(deps);

  /**
   * Records a change to the user's own factors.
   *
   * @param req - The request.
   * @param user - The user.
   * @param type - What changed.
   * @param [detail] - What else to keep.
   */
  const record = (req: Request, user: PublicUser, type: AuditType, detail?: Record<string, string>): void => {
    audit.record({ type, actor: actorOf(user), ip: req.ip ?? null, detail });
  };

  /**
   * Checks the user's password before a factor is taken away, throttled as a sign-in is.
   *
   * @param req - The request.
   * @param res - Its response, which gets the refusal.
   * @param user - The user.
   * @param password - What they typed.
   * @returns True when it matched.
   */
  const confirmPassword = async (req: Request, res: Response, user: PublicUser, password: string): Promise<boolean> => {
    const ip = req.ip ?? '';
    const wait = throttle.wait(ip, user.username);
    if (wait > 0) {
      sendTooMany(res, wait);
      return false;
    }
    const checked = await users.authenticate(user.username, password);
    if (checked === null) {
      throttle.fail(ip, user.username);
      record(req, user, AuditType.AccountPasswordFailed);
      sendRefusal(res, HttpStatus.Forbidden, 'That is not your password.');
      return false;
    }
    return true;
  };

  /**
   * Makes recovery codes for a user's first factor.
   *
   * @param req - The request.
   * @param user - The user.
   * @returns Once saved: the codes, or null when they already have some.
   */
  const firstRecoveryCodes = async (req: Request, user: PublicUser): Promise<string[] | null> => {
    if (factors.summary(user.id).recoveryCodesLeft > 0) {
      return null;
    }
    const codes = factors.newRecoveryCodes(user.id);
    record(req, user, AuditType.RecoveryCodesMade);
    return codes;
  };

  router.get(FACTOR_PATH.factors, signedIn, (_req, res) => {
    const user = viewerOf(res);
    res.json({ ...factors.summary(user.id), passkeysAvailable: rp.isAvailable });
  });

  router.post(FACTOR_PATH.totpStart, ...json, signedIn, (_req, res) => {
    const user = viewerOf(res);
    const secret = newTotpSecret();
    totpSetups.set(user.id, secret);
    res.json({ secret, uri: totpUri(secret, branding.read().name, user.username) });
  });

  router.post(FACTOR_PATH.totpConfirm, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
    const parsed = codeSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the code the app shows.');
      return;
    }
    const secret = totpSetups.get(user.id);
    if (secret === null) {
      sendRefusal(res, HttpStatus.BadRequest, 'This setup waited too long. Start again.');
      return;
    }
    const step = matchTotp(secret, parsed.data.code, now(), -1);
    if (step === null) {
      sendRefusal(res, HttpStatus.BadRequest, 'That code is not right. Check the phone’s clock, and try the next one.');
      return;
    }
    totpSetups.delete(user.id);
    const saving = factors.setTotp(user.id, secret, step);
    const recoveryCodes = firstRecoveryCodes(req, user);
    await saving;
    record(req, user, AuditType.TotpAdded);
    res.json({ recoveryCodes: await recoveryCodes });
  });

  router.post(FACTOR_PATH.totpRemove, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
    const parsed = passwordSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send your password.');
      return;
    }
    const isConfirmed = await confirmPassword(req, res, user, parsed.data.password);
    if (isConfirmed) {
      await factors.removeTotp(user.id);
      record(req, user, AuditType.TotpRemoved);
      res.json(factors.summary(user.id));
    }
  });

  router.post(FACTOR_PATH.recoveryCodes, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
    const parsed = passwordSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send your password.');
      return;
    }
    if (factors.hasSecondFactor(user.id) === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Set up an authenticator app or a passkey first.');
      return;
    }
    const isConfirmed = await confirmPassword(req, res, user, parsed.data.password);
    if (isConfirmed) {
      const recoveryCodes = await factors.newRecoveryCodes(user.id);
      record(req, user, AuditType.RecoveryCodesMade);
      res.json({ recoveryCodes });
    }
  });

  router.post(FACTOR_PATH.passkeyOptions, ...json, signedIn, async (_req, res) => {
    const user = viewerOf(res);
    if (rp.isAvailable === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Passkeys need this site to be served over https.');
      return;
    }
    const options = await registrationOptions(rp, branding.read().name, user, factors.passkeysOf(user.id));
    challenges.set(user.id, options.challenge);
    res.json({ options });
  });

  router.post(FACTOR_PATH.passkeyAdd, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
    const parsed = addPasskeySchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send a name for the passkey and the browser’s answer.');
      return;
    }
    const challenge = challenges.take(user.id);
    const response = parsed.data.response as unknown as RegistrationResponseJSON;
    const made = challenge === null ? null : await verifyRegistration(rp, response, challenge).catch(() => null);
    if (made === null) {
      sendRefusal(res, HttpStatus.BadRequest, 'The passkey could not be checked. Try again.');
      return;
    }
    try {
      const { name } = parsed.data;
      const passkey = await factors.addPasskey(user.id, { ...made, name });
      record(req, user, AuditType.PasskeyAdded, { name });
      res.json({ passkey, recoveryCodes: await firstRecoveryCodes(req, user) });
    } catch (caught) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(caught));
    }
  });

  router.post(FACTOR_PATH.passkeyRemove, ...json, signedIn, async (req, res) => {
    const user = viewerOf(res);
    const parsed = removePasskeySchema.safeParse(req.body);
    if (parsed.success === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'Send the passkey and your password.');
      return;
    }
    const isConfirmed = await confirmPassword(req, res, user, parsed.data.password);
    if (isConfirmed === false) {
      return;
    }
    try {
      const removed = await factors.removePasskey(user.id, parsed.data.id);
      record(req, user, AuditType.PasskeyRemoved, { name: removed.name });
      res.json(factors.summary(user.id));
    } catch (caught) {
      sendRefusal(res, HttpStatus.NotFound, errorMessage(caught));
    }
  });

  return router;
}
