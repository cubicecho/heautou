import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import express, { type Request, type Response, Router } from 'express';
import type Provider from 'oidc-provider';
import { z } from 'zod';
import { builtInClientName } from '../admin/admin-client.ts';
import { HTTP_DEFAULTS, TWO_FACTOR_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import { authenticationOptions, relyingPartyOf, verifyAuthentication } from '../core/webauthn.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson } from '../http/guards.ts';
import { type LoginThrottle, sendTooMany } from '../http/rate-limit.ts';
import { type AuditEvent, type AuditLog, AuditTargetKind, AuditType, actorOf } from '../store/audit.ts';
import type { ClientStore } from '../store/clients.ts';
import type { FactorStore } from '../store/factors.ts';
import type { UpstreamProvider, UpstreamStore } from '../store/upstreams.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { resolveUpstreamUser } from '../upstream/accounts.ts';
import { FlowPurpose, type UpstreamFlows } from '../upstream/flows.ts';
import type { ProviderHost } from './host.ts';
import { PAGE_PARAM, pageUrl, WEB_PAGE } from './pages.ts';
import { AuthLevel, AuthMethod, INTERACTION_PATH, maySignIn } from './provider.ts';

/** The prompts the provider asks this server to resolve. */
const Prompt = { Login: 'login', Consent: 'consent' } as const;

/** What the consent prompt says the client asked for and has not been granted. */
const missingSchema = z.object({
  missingOIDCScope: z.array(z.string()).optional(),
  missingOIDCClaims: z.array(z.string()).optional(),
  missingResourceScopes: z.record(z.string(), z.array(z.string())).optional(),
});

const credentialsSchema = z.object({ username: z.string().trim(), password: z.string() });
const codeSchema = z.object({ code: z.string().trim().min(1) });
/** A browser's passkey answer. Its shape is checked by the WebAuthn library; here only that it names a credential. */
const passkeyAnswerSchema = z.object({ response: z.looseObject({ id: z.string().min(1) }) });

/** How a sign-in proved who the user is, in the `SignInSucceeded` entry's detail. */
export const SignInMethod = {
  Password: 'password',
  PasswordAndTotp: 'password_totp',
  PasswordAndRecoveryCode: 'password_recovery_code',
  PasswordAndPasskey: 'password_passkey',
  Passkey: 'passkey',
  /** An upstream provider alone, for a user with no second factor here. */
  Upstream: 'upstream',
  /** An upstream provider the operator counts as both factors. */
  UpstreamAsBothFactors: 'upstream_both_factors',
  UpstreamAndTotp: 'upstream_totp',
  UpstreamAndRecoveryCode: 'upstream_recovery_code',
  UpstreamAndPasskey: 'upstream_passkey',
} as const;
export type SignInMethod = (typeof SignInMethod)[keyof typeof SignInMethod];

/** What each way of signing in puts in the `amr` claim. */
const AMR_OF: Record<SignInMethod, AuthMethod[]> = {
  [SignInMethod.Password]: [AuthMethod.Password],
  [SignInMethod.PasswordAndTotp]: [AuthMethod.Password, AuthMethod.OneTimeCode, AuthMethod.MultiFactor],
  [SignInMethod.PasswordAndRecoveryCode]: [AuthMethod.Password, AuthMethod.OneTimeCode, AuthMethod.MultiFactor],
  [SignInMethod.PasswordAndPasskey]: [AuthMethod.Password, AuthMethod.HardwareKey, AuthMethod.MultiFactor],
  // The passkey had to check the user (a PIN or a fingerprint): something they have and something they are or know.
  [SignInMethod.Passkey]: [AuthMethod.HardwareKey, AuthMethod.UserVerified, AuthMethod.MultiFactor],
  [SignInMethod.Upstream]: [AuthMethod.Federated],
  [SignInMethod.UpstreamAsBothFactors]: [AuthMethod.Federated, AuthMethod.MultiFactor],
  [SignInMethod.UpstreamAndTotp]: [AuthMethod.Federated, AuthMethod.OneTimeCode, AuthMethod.MultiFactor],
  [SignInMethod.UpstreamAndRecoveryCode]: [AuthMethod.Federated, AuthMethod.OneTimeCode, AuthMethod.MultiFactor],
  [SignInMethod.UpstreamAndPasskey]: [AuthMethod.Federated, AuthMethod.HardwareKey, AuthMethod.MultiFactor],
};

/** How a sign-in waiting for its second factor proved who the user is first. */
const FirstFactor = { Password: 'password', Upstream: 'upstream' } as const;
type FirstFactor = (typeof FirstFactor)[keyof typeof FirstFactor];

/** The second factors a user may finish a sign-in with, as the sign-in page is told. */
export interface SecondFactorChoice {
  totp: boolean;
  passkey: boolean;
  recoveryCode: boolean;
}

/** How the first factor and the second one together are recorded. */
const METHOD_AFTER: Record<FirstFactor, Record<keyof SecondFactorChoice, SignInMethod>> = {
  [FirstFactor.Password]: {
    totp: SignInMethod.PasswordAndTotp,
    recoveryCode: SignInMethod.PasswordAndRecoveryCode,
    passkey: SignInMethod.PasswordAndPasskey,
  },
  [FirstFactor.Upstream]: {
    totp: SignInMethod.UpstreamAndTotp,
    recoveryCode: SignInMethod.UpstreamAndRecoveryCode,
    passkey: SignInMethod.UpstreamAndPasskey,
  },
};

/** Records an audit entry of a type, with an optional detail, for one sign-in. */
type Recorder = (type: AuditType, detail?: AuditEvent['detail']) => void;

/** A sign-in whose first factor was right, waiting for the second. Kept by interaction. */
interface PendingSignIn {
  userId: string;
  /** Wrong second factors so far. */
  failures: number;
  /** The upstream provider the first factor came from, or null for a password. */
  upstream: Pick<UpstreamProvider, 'id' | 'name'> | null;
}

/**
 * Says how a waiting sign-in proved who the user is first, and what its entry keeps about it.
 *
 * @param waiting - The waiting sign-in.
 * @returns The first factor, and the provider's name for an upstream one.
 */
function firstFactorOf(waiting: PendingSignIn): { factor: FirstFactor; detail: Record<string, string> } {
  return waiting.upstream === null
    ? { factor: FirstFactor.Password, detail: {} }
    : { factor: FirstFactor.Upstream, detail: { provider: waiting.upstream.name } };
}

/** What the interaction routes use. */
export interface InteractionDeps {
  host: ProviderHost;
  clients: ClientStore;
  users: UserStore;
  /** The issuer's origin; the login POST must come from a page on it. */
  origin: string;
  throttle: LoginThrottle;
  audit: AuditLog;
  /** Each user's second factors. */
  factors: FactorStore;
  /** The public URL of the provider, which passkeys are registered to. */
  issuer: string;
  /** The upstream providers a user may sign in through, and their links. */
  upstreams: UpstreamStore;
  /** The upstream sign-ins under way. */
  upstreamFlows: UpstreamFlows;
  /** The clock, in epoch milliseconds, for how long a sign-in may wait for its second factor. */
  now?: () => number;
}

/**
 * Says why an interaction could not go on, in JSON the sign-in page shows.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param message - What went wrong, for a person.
 */
function sendError(res: Response, status: HttpStatus, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * Sends a browser that navigated here to the web app's error page.
 *
 * @param res - The response.
 * @param message - What went wrong, for a person.
 */
function showError(res: Response, message: string): void {
  res.redirect(
    HttpStatus.SeeOther,
    pageUrl(WEB_PAGE.error, { [PAGE_PARAM.error]: 'interaction_failed', [PAGE_PARAM.description]: message }),
  );
}

/**
 * Grants a client every scope and claim it asked for. The operator added the client, so the user is
 * not asked: there is no consent screen in this provider.
 *
 * @param provider - The provider.
 * @param req - The interaction request.
 * @param res - Its response.
 * @returns The grant's id.
 */
async function grantEverythingAsked(provider: Provider, req: Request, res: Response): Promise<string> {
  const { prompt, params, session, grantId } = await provider.interactionDetails(req, res);
  const existing = grantId === undefined ? undefined : await provider.Grant.find(grantId);
  const grant = existing ?? new provider.Grant({ accountId: session?.accountId, clientId: String(params.client_id) });
  const { missingOIDCScope, missingOIDCClaims, missingResourceScopes } = missingSchema.parse(prompt.details);
  if (missingOIDCScope !== undefined) {
    grant.addOIDCScope(missingOIDCScope.join(' '));
  }
  if (missingOIDCClaims !== undefined) {
    grant.addOIDCClaims(missingOIDCClaims);
  }
  for (const [indicator, scopes] of Object.entries(missingResourceScopes ?? {})) {
    grant.addResourceScope(indicator, scopes.join(' '));
  }
  return grant.save();
}

/**
 * Reads which client a sign-in is for, without failing the sign-in when the interaction is gone.
 *
 * @param provider - The provider.
 * @param req - The interaction request.
 * @param res - Its response.
 * @returns The client's id, or null when the interaction has expired or is unknown.
 */
async function clientIdOf(provider: Provider, req: Request, res: Response): Promise<string | null> {
  try {
    const { params } = await provider.interactionDetails(req, res);
    return String(params.client_id);
  } catch {
    return null;
  }
}

/**
 * Builds the routes the provider sends a browser to mid-sign-in.
 *
 * @param deps - The provider and the stores.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /interaction/:uid` resolves consent itself and sends a login prompt on to the web app's
 * `/login/:uid` page. That page reads `GET /interaction/:uid/details` and posts the username and
 * password to `POST /interaction/:uid/login`, which answers with where the browser goes next.
 */
export function createInteractionRouter(deps: InteractionDeps): Router {
  const { host, clients, users, throttle, audit, factors, upstreams, upstreamFlows, now = Date.now } = deps;
  const nameOf = (clientId: string): string => builtInClientName(clientId) ?? clients.find(clientId)?.name ?? clientId;
  const rp = relyingPartyOf(deps.issuer);
  const pending = createExpiringMap<PendingSignIn>(TWO_FACTOR_DEFAULTS.pendingSeconds, now);
  const challenges = createExpiringMap<string>(TWO_FACTOR_DEFAULTS.passkeyTimeoutSeconds, now);
  const router = Router();

  /**
   * Builds the audit recorder for a sign-in by a known user.
   *
   * @param req - The request.
   * @param clientId - The client the sign-in is for.
   * @param user - Who is signing in.
   * @returns A function recording an entry of a type, with an optional detail.
   */
  const recorder =
    (req: Request, clientId: string, user: PublicUser): Recorder =>
    (type, detail) => {
      audit.record({
        type,
        actor: actorOf(user),
        ip: req.ip ?? null,
        target: { kind: AuditTargetKind.Client, id: clientId, name: nameOf(clientId) },
        detail,
      });
    };

  /**
   * Says which second factors a user can finish with.
   *
   * @param userId - The user.
   * @returns What the sign-in page offers.
   */
  const choiceFor = (userId: string): SecondFactorChoice => {
    const { hasTotp, recoveryCodesLeft, passkeys } = factors.summary(userId);
    return { totp: hasTotp, passkey: passkeys.length > 0 && rp.isAvailable, recoveryCode: recoveryCodesLeft > 0 };
  };

  /**
   * Says why a user may not sign in to the interaction's client, and records it: disabled, or outside its allowed
   * groups. Every way of signing in asks this, so they all refuse alike.
   *
   * @param provider - The provider.
   * @param req - The interaction request.
   * @param res - Its response.
   * @param user - Who proved who they are.
   * @param record - Records the refusal.
   * @returns What to tell them, or null when they may go on.
   */
  const refusalFor = async (
    provider: Provider,
    req: Request,
    res: Response,
    user: PublicUser,
    record: Recorder,
  ): Promise<string | null> => {
    if (user.disabled) {
      record(AuditType.SignInRefused, { reason: 'disabled' });
      return `"${user.username}" is disabled. Ask an admin to enable it.`;
    }
    const { params } = await provider.interactionDetails(req, res);
    const signInClientId = String(params.client_id);
    const client = clients.find(signInClientId);
    if (maySignIn(user, client) === false) {
      record(AuditType.SignInRefused, { reason: 'not_in_allowed_groups' });
      return `"${user.username}" may not sign in to ${nameOf(signInClientId)}. It is only for ${client?.allowedGroups.join(', ')}.`;
    }
    return null;
  };

  /**
   * Turns a user away who may not sign in to the interaction's client, answering the sign-in page's POST.
   *
   * @param provider - The provider.
   * @param req - The interaction request.
   * @param res - Its response, which gets the refusal.
   * @param user - Who proved who they are.
   * @param record - Records the refusal.
   * @returns True when they may go on.
   */
  const refuseUnlessAllowed = async (
    provider: Provider,
    req: Request,
    res: Response,
    user: PublicUser,
    record: Recorder,
  ): Promise<boolean> => {
    const refusal = await refusalFor(provider, req, res, user, record);
    if (refusal !== null) {
      sendError(res, HttpStatus.Forbidden, refusal);
      return false;
    }
    return true;
  };

  /**
   * Finishes the sign-in with the provider.
   *
   * @param provider - The provider.
   * @param req - The interaction request.
   * @param res - Its response.
   * @param user - Who signed in.
   * @param method - How they proved it.
   * @param [detail] - What else the audit entry keeps.
   * @returns Where the browser goes next.
   */
  const complete = async (
    provider: Provider,
    req: Request,
    res: Response,
    user: PublicUser,
    method: SignInMethod,
    detail: Record<string, string> = {},
  ): Promise<string> => {
    const { uid, params } = await provider.interactionDetails(req, res);
    pending.delete(uid);
    const amr = AMR_OF[method];
    const acr = amr.includes(AuthMethod.MultiFactor) ? AuthLevel.MultiFactor : AuthLevel.Password;
    const redirectTo = await provider.interactionResult(
      req,
      res,
      { login: { accountId: user.id, amr, acr } },
      { mergeWithLastSubmission: false },
    );
    throttle.succeed(user.username);
    recorder(req, String(params.client_id), user)(AuditType.SignInSucceeded, { method, ...detail });
    return redirectTo;
  };

  /**
   * Finishes the sign-in and tells the page where the browser goes next.
   *
   * @param provider - The provider.
   * @param req - The interaction request.
   * @param res - Its response.
   * @param user - Who signed in.
   * @param method - How they proved it.
   * @param [detail] - What else the audit entry keeps.
   */
  const finish = async (
    provider: Provider,
    req: Request,
    res: Response,
    user: PublicUser,
    method: SignInMethod,
    detail: Record<string, string> = {},
  ): Promise<void> => {
    res.json({ redirectTo: await complete(provider, req, res, user, method, detail) });
  };

  /**
   * Counts a wrong second factor. Past `TWO_FACTOR_DEFAULTS.maxAttempts` the sign-in has to start again.
   *
   * @param req - The request.
   * @param res - Its response, which gets the refusal.
   * @param uid - The interaction.
   * @param user - Who is signing in.
   * @param record - Records the failure.
   * @param message - What to tell them.
   */
  const secondFactorFailed = (
    req: Request,
    res: Response,
    uid: string,
    user: PublicUser,
    record: Recorder,
    message: string,
  ): void => {
    throttle.fail(req.ip ?? '', user.username);
    record(AuditType.SecondFactorFailed);
    const failures = (pending.get(uid)?.failures ?? 0) + 1;
    const isUsedUp = failures >= TWO_FACTOR_DEFAULTS.maxAttempts;
    if (isUsedUp) {
      pending.delete(uid);
      res.status(HttpStatus.Unauthorized).json({ error: 'Too many wrong tries. Start again.', restart: true });
      return;
    }
    pending.set(uid, { userId: user.id, failures, upstream: pending.get(uid)?.upstream ?? null });
    sendError(res, HttpStatus.Unauthorized, message);
  };

  /**
   * Finds the sign-in waiting for a second factor in this interaction, or answers why there is none.
   *
   * @param provider - The provider.
   * @param req - The interaction request.
   * @param res - Its response, which gets the refusal when there is none.
   * @returns The user, the interaction and a recorder, or null when the response was sent.
   */
  const waitingSignIn = async (
    provider: Provider,
    req: Request,
    res: Response,
  ): Promise<{ user: PublicUser; uid: string; record: Recorder; waiting: PendingSignIn } | null> => {
    const { uid, params } = await provider.interactionDetails(req, res);
    const waiting = pending.get(uid);
    const user = waiting === null ? null : users.find(waiting.userId);
    if (waiting === null || user === null || user.disabled) {
      pending.delete(uid);
      res.status(HttpStatus.BadRequest).json({ error: 'This sign-in waited too long. Start again.', restart: true });
      return null;
    }
    const wait = throttle.wait(req.ip ?? '', user.username);
    const record = recorder(req, String(params.client_id), user);
    if (wait > 0) {
      record(AuditType.SignInThrottled);
      sendTooMany(res, wait);
      return null;
    }
    return { user, uid, record, waiting };
  };

  /**
   * Sends the browser back to the sign-in page, with what went wrong.
   *
   * @param res - The response.
   * @param uid - The interaction.
   * @param [message] - What to show, if anything.
   */
  const backToLogin = (res: Response, uid: string, message?: string): void => {
    res.redirect(
      HttpStatus.SeeOther,
      pageUrl(`${WEB_PAGE.login}/${encodeURIComponent(uid)}`, { [PAGE_PARAM.error]: message }),
    );
  };

  /**
   * Records an upstream sign-in that let nobody in.
   *
   * @param req - The request.
   * @param clientId - The client it was for.
   * @param type - How it went.
   * @param provider - The upstream provider.
   * @param detail - What else to keep.
   */
  const recordUpstream = (
    req: Request,
    clientId: string,
    type: AuditType,
    provider: Pick<UpstreamProvider, 'id' | 'name'>,
    detail: Record<string, string>,
  ): void => {
    audit.record({
      type,
      actor: null,
      ip: req.ip ?? null,
      target: { kind: AuditTargetKind.Client, id: clientId, name: nameOf(clientId) },
      detail: { method: SignInMethod.Upstream, provider: provider.name, ...detail },
    });
  };

  router.get(`${INTERACTION_PATH}/:uid`, async (req, res) => {
    const provider = host.current();
    try {
      const { prompt, uid } = await provider.interactionDetails(req, res);
      if (prompt.name === Prompt.Login) {
        res.redirect(HttpStatus.SeeOther, `${WEB_PAGE.login}/${uid}`);
        return;
      }
      if (prompt.name === Prompt.Consent) {
        const grantId = await grantEverythingAsked(provider, req, res);
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
        return;
      }
      showError(res, `This provider cannot answer the "${prompt.name}" prompt.`);
    } catch (error) {
      showError(res, errorMessage(error));
    }
  });

  router.get(`${INTERACTION_PATH}/:uid/details`, async (req, res) => {
    try {
      const { uid, params } = await host.current().interactionDetails(req, res);
      const waiting = pending.get(uid);
      res.json({
        clientName: nameOf(String(params.client_id)),
        passkeysAvailable: rp.isAvailable,
        upstreams: upstreams.list().map(({ id, name, kind }) => ({ id, name, kind })),
        // A sign-in that came back from an upstream provider and still needs a second factor.
        secondFactor: waiting?.upstream ? { ...choiceFor(waiting.userId), provider: waiting.upstream.name } : null,
      });
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  const loginBody = [sameOriginJson(deps.origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];
  router.post(`${INTERACTION_PATH}/:uid/login`, ...loginBody, async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendError(res, HttpStatus.BadRequest, 'Send a username and a password.');
      return;
    }
    const { username, password } = parsed.data;
    const ip = req.ip ?? '';
    const provider = host.current();
    const clientId = await clientIdOf(provider, req, res);
    const named = users.list().find((candidate) => candidate.username === username) ?? null;
    /**
     * Records how the sign-in went, against the client it was for.
     *
     * @param type - How it went.
     * @param [detail] - What else to keep.
     */
    const record = (type: AuditType, detail?: AuditEvent['detail']): void => {
      audit.record({
        type,
        actor: named === null ? null : actorOf(named),
        ip: req.ip ?? null,
        target: clientId === null ? undefined : { kind: AuditTargetKind.Client, id: clientId, name: nameOf(clientId) },
        detail: named === null ? { username, ...detail } : detail,
      });
    };
    const wait = throttle.wait(ip, username);
    if (wait > 0) {
      record(AuditType.SignInThrottled);
      sendTooMany(res, wait);
      return;
    }
    try {
      const user = await users.authenticate(username, password);
      if (user === null) {
        throttle.fail(ip, username);
        record(AuditType.SignInFailed);
        sendError(res, HttpStatus.Unauthorized, 'That username and password do not match.');
        return;
      }
      throttle.succeed(username);
      const isAllowed = await refuseUnlessAllowed(provider, req, res, user, record);
      if (isAllowed === false) {
        return;
      }
      if (factors.hasSecondFactor(user.id)) {
        const { uid } = await provider.interactionDetails(req, res);
        pending.set(uid, { userId: user.id, failures: 0, upstream: null });
        res.json({ secondFactor: choiceFor(user.id) });
        return;
      }
      await finish(provider, req, res, user, SignInMethod.Password);
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.post(`${INTERACTION_PATH}/:uid/second-factor`, ...loginBody, async (req, res) => {
    const parsed = codeSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendError(res, HttpStatus.BadRequest, 'Send the code.');
      return;
    }
    const provider = host.current();
    try {
      const waiting = await waitingSignIn(provider, req, res);
      if (waiting === null) {
        return;
      }
      const { user, uid, record } = waiting;
      const { factor, detail } = firstFactorOf(waiting.waiting);
      const { code } = parsed.data;
      if (await factors.checkTotp(user.id, code)) {
        await finish(provider, req, res, user, METHOD_AFTER[factor].totp, detail);
        return;
      }
      if (await factors.useRecoveryCode(user.id, code)) {
        await finish(provider, req, res, user, METHOD_AFTER[factor].recoveryCode, {
          ...detail,
          recoveryCodesLeft: String(factors.summary(user.id).recoveryCodesLeft),
        });
        return;
      }
      secondFactorFailed(req, res, uid, user, record, 'That code is not right, or was already used.');
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.post(`${INTERACTION_PATH}/:uid/passkey/options`, ...loginBody, async (req, res) => {
    const provider = host.current();
    try {
      const { uid } = await provider.interactionDetails(req, res);
      const waiting = pending.get(uid);
      if (rp.isAvailable === false) {
        sendError(res, HttpStatus.BadRequest, 'Passkeys need this site to be served over https.');
        return;
      }
      const options = await authenticationOptions(rp, waiting === null ? null : factors.passkeysOf(waiting.userId));
      challenges.set(uid, options.challenge);
      res.json({ options });
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.post(`${INTERACTION_PATH}/:uid/passkey`, ...loginBody, async (req, res) => {
    const parsed = passkeyAnswerSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendError(res, HttpStatus.BadRequest, 'Send the passkey’s answer.');
      return;
    }
    const provider = host.current();
    const ip = req.ip ?? '';
    // Before the passkey is checked there is no username, so the address alone is counted.
    const anonymousKey = `passkey:${ip}`;
    const ipWait = throttle.wait(ip, anonymousKey);
    if (ipWait > 0) {
      sendTooMany(res, ipWait);
      return;
    }
    try {
      const { uid, params } = await provider.interactionDetails(req, res);
      const signInClientId = String(params.client_id);
      const challenge = challenges.take(uid);
      const response = parsed.data.response as unknown as AuthenticationResponseJSON;
      const found = factors.findPasskey(response.id);
      const waiting = pending.get(uid);
      const owner = found === null ? null : users.find(found.userId);
      const isAfterPassword = waiting !== null;
      const isOtherUser = isAfterPassword && found !== null && found.userId !== waiting.userId;
      const check =
        challenge === null || found === null || owner === null || isOtherUser
          ? null
          : await verifyAuthentication(rp, response, challenge, found.passkey, isAfterPassword === false).catch(
              () => null,
            );
      if (found === null || owner === null || check === null) {
        if (isAfterPassword) {
          const user = users.find(waiting.userId);
          if (user !== null) {
            secondFactorFailed(
              req,
              res,
              uid,
              user,
              recorder(req, signInClientId, user),
              'That passkey did not work. Try again.',
            );
            return;
          }
        }
        throttle.fail(ip, owner?.username ?? anonymousKey);
        audit.record({
          type: AuditType.SignInFailed,
          actor: owner === null ? null : actorOf(owner),
          ip: req.ip ?? null,
          detail: { method: SignInMethod.Passkey },
        });
        sendError(res, HttpStatus.Unauthorized, 'That passkey is not registered here, or did not work. Try again.');
        return;
      }
      await factors.usedPasskey(found.passkey.id, check.counter);
      if (isAfterPassword) {
        const { factor, detail } = firstFactorOf(waiting);
        await finish(provider, req, res, owner, METHOD_AFTER[factor].passkey, detail);
        return;
      }
      const wait = throttle.wait(ip, owner.username);
      if (wait > 0) {
        recorder(req, signInClientId, owner)(AuditType.SignInThrottled);
        sendTooMany(res, wait);
        return;
      }
      const isAllowed = await refuseUnlessAllowed(provider, req, res, owner, recorder(req, signInClientId, owner));
      if (isAllowed) {
        await finish(provider, req, res, owner, SignInMethod.Passkey);
      }
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.get(`${INTERACTION_PATH}/:uid/upstream/:providerId`, async (req, res) => {
    const { uid, providerId } = req.params;
    try {
      const details = await host.current().interactionDetails(req, res);
      if (details.uid !== uid) {
        backToLogin(res, details.uid, 'This sign-in has changed. Try again.');
        return;
      }
      pending.delete(uid);
      res.redirect(HttpStatus.SeeOther, await upstreamFlows.start(providerId, { purpose: FlowPurpose.SignIn, uid }));
    } catch (error) {
      console.error(`[upstream] starting ${providerId}:`, error);
      backToLogin(res, uid, `That provider could not be reached: ${errorMessage(error)}`);
    }
  });

  router.get(`${INTERACTION_PATH}/:uid/upstream-return`, async (req, res) => {
    const provider = host.current();
    try {
      const { uid, params } = await provider.interactionDetails(req, res);
      const clientId = String(params.client_id);
      const outcome = upstreamFlows.takeForInteraction(uid);
      if (outcome === null) {
        backToLogin(res, uid, 'That sign-in took too long, or was already used. Try again.');
        return;
      }
      const upstream = outcome.provider;
      if (outcome.identity === null) {
        recordUpstream(req, clientId, AuditType.SignInFailed, upstream, {});
        backToLogin(res, uid, outcome.error);
        return;
      }
      const resolved = await resolveUpstreamUser(
        { upstreams, users, audit },
        upstream,
        outcome.identity,
        req.ip ?? null,
      );
      if (resolved.user === null) {
        recordUpstream(req, clientId, AuditType.SignInRefused, upstream, {
          reason: resolved.refusal.reason,
          identity: outcome.identity.label,
        });
        backToLogin(res, uid, resolved.refusal.message);
        return;
      }
      const { user } = resolved;
      const record = recorder(req, clientId, user);
      const refusal = await refusalFor(provider, req, res, user, record);
      if (refusal !== null) {
        backToLogin(res, uid, refusal);
        return;
      }
      const detail = { provider: upstream.name };
      if (upstream.countsAsBothFactors) {
        res.redirect(
          HttpStatus.SeeOther,
          await complete(provider, req, res, user, SignInMethod.UpstreamAsBothFactors, detail),
        );
        return;
      }
      if (factors.hasSecondFactor(user.id)) {
        pending.set(uid, { userId: user.id, failures: 0, upstream: { id: upstream.id, name: upstream.name } });
        backToLogin(res, uid);
        return;
      }
      res.redirect(HttpStatus.SeeOther, await complete(provider, req, res, user, SignInMethod.Upstream, detail));
    } catch (error) {
      showError(res, errorMessage(error));
    }
  });

  return router;
}
