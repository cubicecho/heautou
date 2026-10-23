import { randomBytes } from 'node:crypto';
import { type CookieOptions, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { adminUrls, WEB_APP_PAGE } from '../admin/admin-client.ts';
import { FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import { readCookie, signValue, verifyValue } from '../http/cookies.ts';
import { pkceChallenge, redeemCode } from '../oidc/code-exchange.ts';
import type { ProviderHost } from '../oidc/host.ts';
import { PAGE_PARAM, pageUrl, WEB_PAGE } from '../oidc/pages.ts';
import { AuthLevel } from '../oidc/provider.ts';
import { type AuditLog, AuditType, actorOf } from '../store/audit.ts';
import type { FactorStore } from '../store/factors.ts';
import type { KeyStore } from '../store/keys.ts';
import type { ProtectedSite, ProtectedSiteStore } from '../store/protected-sites.ts';
import type { ProxySession, ProxySessionStore } from '../store/proxy-sessions.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { FLAG_ON, FORWARD_AUTH_PARAM, FORWARD_AUTH_PATH, forwardAuthUrls, PROXY_COOKIE, siteTarget } from './client.ts';
import { originalRequestOf } from './request.ts';
import { allowedReturn } from './returns.ts';
import type { ProxyTrust } from './trust.ts';

/** The headers a protected site is told who the user is in, as Authelia names them. */
export const REMOTE_HEADER = {
  user: 'Remote-User',
  name: 'Remote-Name',
  email: 'Remote-Email',
  groups: 'Remote-Groups',
} as const;

/** What `Remote-Groups` joins the groups with. */
const GROUP_SEPARATOR = ',';
/** The methods a browser navigates with, which the redirect form answers with a 302 rather than a 401. */
const NAVIGATION_METHODS = new Set(['GET', 'HEAD']);
/** The first character code a header value may carry: space. Below it are control characters. */
const FIRST_PRINTABLE_CODE = 0x20;
/** DEL, the one control character above space. */
const DELETE_CODE = 0x7f;
const LOG_TAG = '[forward-auth]';

/** The error codes the web app's error page explains. */
const ProxyError = { signInFailed: 'proxy_sign_in_failed', returnRefused: 'proxy_return_refused' } as const;

/** Why a signed-in user was turned away from a site, in the audit entry's detail. */
const RefusalReason = { groups: 'not_in_allowed_groups', secondFactor: 'no_second_factor' } as const;
type RefusalReason = (typeof RefusalReason)[keyof typeof RefusalReason];

const loginStateSchema = z.object({
  state: z.string(),
  verifier: z.string(),
  /** Where to go after: an allowed return address, or null for the account page. */
  returnTo: z.string().nullable(),
  expiresAt: z.number(),
});
type LoginState = z.infer<typeof loginStateSchema>;

const callbackQuerySchema = z.object({
  state: z.string(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/** Where forward auth's settings come from that are not in a store. */
export interface ForwardAuthConfig {
  /** The domain the proxy session cookie is set on: the environment's, else the admin's, else none. */
  cookieDomain: () => string | null;
  /** `FORWARD_AUTH_COOKIE_DOMAIN`, which wins over the admin's choice. Null when unset. */
  environmentCookieDomain: string | null;
  /** `FORWARD_AUTH_TRUSTED_PROXIES`, or null to fall back to `TRUST_PROXY` and loopback. */
  trustedProxies: readonly string[] | null;
}

/** What the forward auth routes use. */
export interface ForwardAuthDeps {
  host: ProviderHost;
  users: UserStore;
  factors: FactorStore;
  protectedSites: ProtectedSiteStore;
  proxySessions: ProxySessionStore;
  keys: KeyStore;
  issuer: string;
  audit: AuditLog;
  forwardAuth: ForwardAuthConfig;
  /** Whether a caller of the verify endpoint is a proxy whose forwarded headers are believed. */
  trust: ProxyTrust;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

/** What the verify endpoint decided about one request. */
type Decision =
  | { kind: 'allow'; user: PublicUser }
  | { kind: 'sign-in'; signInUrl: string; method: string }
  | { kind: 'refuse'; status: HttpStatus; message: string };

/**
 * Makes a header value safe to send: no control characters, and UTF-8 bytes for a name outside Latin-1, which Node
 * would refuse.
 *
 * @param value - The value.
 * @returns What to pass to `res.set`.
 */
function headerValue(value: string): string {
  const printable = [...value].filter((char) => {
    const code = char.charCodeAt(0);
    return code >= FIRST_PRINTABLE_CODE && code !== DELETE_CODE;
  });
  return Buffer.from(printable.join(''), 'utf8').toString('latin1');
}

/**
 * Says whether a user may reach a site by its groups.
 *
 * @param user - The user.
 * @param site - The site.
 * @returns True when the site lets every user in, or the user is in one of its groups.
 */
function isInSiteGroups(user: PublicUser, site: ProtectedSite): boolean {
  return site.allowedGroups.length === 0 || user.groups.some((group) => site.allowedGroups.includes(group));
}

/**
 * Builds the forward auth routes: the endpoint a reverse proxy asks about each request to a protected site, and
 * the sign-in that makes the proxy session it reads.
 *
 * @param deps - The provider, the stores, the keys, the issuer and the proxy trust.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `/auth/verify` answers 200 with the `Remote-*` headers, 401 (or with `?redirect=1`, a 302 for a GET or HEAD)
 * with the sign-in URL in `Location`, 403 when the user may not reach the site, and 400 when the proxy's headers
 * are unusable. `GET /auth/sign-in?rd=` signs in as the built-in client `heautou-proxy`, so second factors and
 * upstream providers work as for any app; `GET /auth/callback` sets the cookie on the cookie domain.
 */
export function createForwardAuthRouter(deps: ForwardAuthDeps): Router {
  const { host, users, factors, protectedSites, proxySessions, keys, issuer, audit, forwardAuth, trust } = deps;
  const now = deps.now ?? Date.now;
  const urls = forwardAuthUrls(issuer);
  const isHttps = adminUrls(issuer).isHttps;
  const loginCookie: CookieOptions = { httpOnly: true, secure: isHttps, path: '/auth', sameSite: 'lax' };
  const sessionCookie = (): CookieOptions => {
    const domain = forwardAuth.cookieDomain();
    return { httpOnly: true, secure: isHttps, path: '/', sameSite: 'lax', ...(domain === null ? {} : { domain }) };
  };
  const refusalsLogged = createExpiringMap<true>(FORWARD_AUTH_DEFAULTS.refusalLogSeconds, now);
  const untrustedLogged = createExpiringMap<true>(FORWARD_AUTH_DEFAULTS.refusalLogSeconds, now);
  const router = Router();

  /**
   * Builds the sign-in URL a refused browser is sent to.
   *
   * @param returnTo - The original request's URL.
   * @param stepUp - Whether the password is to be asked again, for a second factor.
   * @returns The absolute URL.
   */
  const signInUrlFor = (returnTo: string, stepUp: boolean): string => {
    const query = new URLSearchParams({ [FORWARD_AUTH_PARAM.returnTo]: returnTo });
    if (stepUp) {
      query.set(FORWARD_AUTH_PARAM.stepUp, FLAG_ON);
    }
    return `${urls.signIn}?${query}`;
  };

  /**
   * Records a refusal of a signed-in user, once per user, site and reason every `refusalLogSeconds`.
   *
   * @param req - The verify request, for the address.
   * @param user - The user.
   * @param site - The site.
   * @param reason - Why.
   */
  const recordRefusal = (req: Request, user: PublicUser, site: ProtectedSite, reason: RefusalReason): void => {
    const key = `${user.id} ${site.id} ${reason}`;
    if (refusalsLogged.get(key) !== null) {
      return;
    }
    refusalsLogged.set(key, true);
    audit.record({
      type: AuditType.ProxyRefused,
      actor: actorOf(user),
      ip: req.ip ?? null,
      target: siteTarget(site),
      detail: { reason, host: site.host },
    });
  };

  /**
   * Finds the live session a request's cookie names. A session whose provider grant was revoked (a sign-out at the
   * provider, an admin ending it) or whose user is gone or disabled is ended here.
   *
   * @param req - The request.
   * @returns The session and its user, or null.
   */
  const liveSessionOf = async (req: Request): Promise<{ session: ProxySession; user: PublicUser } | null> => {
    const token = readCookie(req, PROXY_COOKIE.session);
    const session = token === null ? null : await proxySessions.use(token);
    if (token === null || session === null) {
      return null;
    }
    const grant = await host.current().Grant.find(session.grantId);
    const user = users.find(session.userId);
    const isUsable = grant?.accountId === session.userId && user !== null && user.disabled === false;
    if (isUsable === false || user === null) {
      await proxySessions.remove(token);
      return null;
    }
    return { session, user };
  };

  /**
   * Decides one verify request.
   *
   * @param req - The proxy's request.
   * @returns The decision.
   */
  const decide = async (req: Request): Promise<Decision> => {
    const peer = req.socket.remoteAddress;
    if (trust(peer) === false) {
      const key = peer ?? '';
      if (untrustedLogged.get(key) === null) {
        untrustedLogged.set(key, true);
        console.warn(
          `${LOG_TAG} refused a verify call from ${key || 'an unknown address'}: not a trusted proxy. Set FORWARD_AUTH_TRUSTED_PROXIES or TRUST_PROXY to include it.`,
        );
      }
      return { kind: 'refuse', status: HttpStatus.Forbidden, message: 'This address is not a trusted proxy.' };
    }
    const { request, problem } = originalRequestOf((name) => req.get(name));
    if (request === null) {
      return { kind: 'refuse', status: HttpStatus.BadRequest, message: `Unusable forwarded headers: ${problem}.` };
    }
    const site = protectedSites.match(request.url.hostname, request.url.pathname);
    if (site === null) {
      return {
        kind: 'refuse',
        status: HttpStatus.Forbidden,
        message: `No protected site covers ${request.url.hostname}${request.url.pathname}.`,
      };
    }
    const live = await liveSessionOf(req);
    if (live === null) {
      return { kind: 'sign-in', signInUrl: signInUrlFor(request.url.href, false), method: request.method };
    }
    const { session, user } = live;
    if (isInSiteGroups(user, site) === false) {
      recordRefusal(req, user, site, RefusalReason.groups);
      return { kind: 'refuse', status: HttpStatus.Forbidden, message: `${user.username} may not reach ${site.name}.` };
    }
    const lacksSecondFactor = site.requireSecondFactor && session.acr !== AuthLevel.MultiFactor;
    if (lacksSecondFactor && factors.hasSecondFactor(user.id)) {
      return { kind: 'sign-in', signInUrl: signInUrlFor(request.url.href, true), method: request.method };
    }
    if (lacksSecondFactor) {
      recordRefusal(req, user, site, RefusalReason.secondFactor);
      return {
        kind: 'refuse',
        status: HttpStatus.Forbidden,
        message: `${site.name} needs a second factor. Set one up on your account page, then sign in again.`,
      };
    }
    return { kind: 'allow', user };
  };

  router.all(FORWARD_AUTH_PATH.verify, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const decision = await decide(req);
    if (decision.kind === 'allow') {
      const { username, name, email, groups } = decision.user;
      res.set({
        [REMOTE_HEADER.user]: headerValue(username),
        [REMOTE_HEADER.name]: headerValue(name),
        [REMOTE_HEADER.email]: headerValue(email),
        [REMOTE_HEADER.groups]: headerValue(groups.join(GROUP_SEPARATOR)),
      });
      res.status(HttpStatus.Ok).type('text').send('OK');
      return;
    }
    if (decision.kind === 'refuse') {
      res.status(decision.status).type('text').send(decision.message);
      return;
    }
    const isRedirectForm =
      req.query[FORWARD_AUTH_PARAM.redirect] === FLAG_ON && NAVIGATION_METHODS.has(decision.method);
    res.set('Location', decision.signInUrl);
    res
      .status(isRedirectForm ? HttpStatus.Found : HttpStatus.Unauthorized)
      .type('text')
      .send('Sign in first.');
  });

  /**
   * Sends the browser to the web app's error page for a failed proxy sign-in.
   *
   * @param res - The response.
   * @param error - The error code.
   * @param description - What went wrong, for a person.
   */
  const showError = (res: Response, error: string, description: string): void => {
    res.redirect(
      HttpStatus.SeeOther,
      pageUrl(WEB_PAGE.error, { [PAGE_PARAM.error]: error, [PAGE_PARAM.description]: description }),
    );
  };

  /**
   * Checks a return address against the sites and the cookie domain.
   *
   * @param address - The `rd` value.
   * @returns The URL, or null when it is refused.
   */
  const checkedReturn = (address: string): URL | null =>
    allowedReturn(address, { sites: protectedSites.list(), cookieDomain: forwardAuth.cookieDomain() });

  router.get(FORWARD_AUTH_PATH.signIn, (req, res) => {
    const asked = req.query[FORWARD_AUTH_PARAM.returnTo];
    const hasReturn = typeof asked === 'string' && asked !== '';
    const returnTo = hasReturn ? checkedReturn(asked) : null;
    if (hasReturn && returnTo === null) {
      showError(res, ProxyError.returnRefused, `${asked} is not on a protected site or under the cookie domain.`);
      return;
    }
    const login: LoginState = {
      state: randomBytes(FORWARD_AUTH_DEFAULTS.tokenBytes).toString('base64url'),
      verifier: randomBytes(FORWARD_AUTH_DEFAULTS.tokenBytes).toString('base64url'),
      returnTo: returnTo?.href ?? null,
      expiresAt: now() + FORWARD_AUTH_DEFAULTS.loginSeconds * MS_PER_SECOND,
    };
    const [signingKey = ''] = keys.current().cookieKeys;
    res.cookie(PROXY_COOKIE.login, signValue(login, signingKey), {
      ...loginCookie,
      maxAge: FORWARD_AUTH_DEFAULTS.loginSeconds * MS_PER_SECOND,
    });
    const authorize = new URL(`${issuer}/auth`);
    authorize.search = new URLSearchParams({
      client_id: FORWARD_AUTH_DEFAULTS.clientId,
      redirect_uri: urls.callback,
      response_type: 'code',
      scope: 'openid',
      state: login.state,
      code_challenge: pkceChallenge(login.verifier),
      code_challenge_method: 'S256',
      ...(req.query[FORWARD_AUTH_PARAM.stepUp] === FLAG_ON ? { prompt: 'login' } : {}),
    }).toString();
    res.redirect(HttpStatus.SeeOther, authorize.toString());
  });

  router.get(FORWARD_AUTH_PATH.callback, async (req, res) => {
    const cookie = readCookie(req, PROXY_COOKIE.login);
    res.clearCookie(PROXY_COOKIE.login, loginCookie);
    const login = loginStateSchema.safeParse(cookie === null ? null : verifyValue(cookie, keys.current().cookieKeys));
    const query = callbackQuerySchema.safeParse(req.query);
    const isOurs =
      login.success && query.success && login.data.expiresAt > now() && login.data.state === query.data.state;
    if (isOurs === false) {
      showError(res, ProxyError.signInFailed, 'The sign-in expired or began in another browser. Try again.');
      return;
    }
    const { code: codeValue, error, error_description: description } = query.data;
    if (codeValue === undefined) {
      showError(res, ProxyError.signInFailed, description ?? error ?? 'The provider sent no code.');
      return;
    }
    try {
      const code = await redeemCode(host.current(), {
        code: codeValue,
        verifier: login.data.verifier,
        clientId: FORWARD_AUTH_DEFAULTS.clientId,
        redirectUri: urls.callback,
      });
      const user = code === null ? null : users.find(code.accountId ?? '');
      if (code === null || code.grantId === undefined || user === null || user.disabled) {
        showError(res, ProxyError.signInFailed, 'The provider sent a code that is not for this sign-in.');
        return;
      }
      const previous = readCookie(req, PROXY_COOKIE.session);
      if (previous !== null) {
        await proxySessions.remove(previous);
      }
      const acr = code.acr ?? AuthLevel.Password;
      const token = await proxySessions.create({ userId: user.id, grantId: code.grantId, amr: code.amr ?? [], acr });
      // The address was checked when the sign-in began; checking again catches a site removed since.
      const returnTo = login.data.returnTo === null ? null : checkedReturn(login.data.returnTo);
      const site = returnTo === null ? null : protectedSites.match(returnTo.hostname, returnTo.pathname);
      audit.record({
        type: AuditType.ProxySignedIn,
        actor: actorOf(user),
        ip: req.ip ?? null,
        ...(site === null ? {} : { target: siteTarget(site) }),
        detail: { host: returnTo?.hostname ?? urls.host, acr },
      });
      res.cookie(PROXY_COOKIE.session, token, {
        ...sessionCookie(),
        maxAge: FORWARD_AUTH_DEFAULTS.sessionSeconds * MS_PER_SECOND,
      });
      res.redirect(HttpStatus.SeeOther, returnTo?.href ?? `${adminUrls(issuer).base}${WEB_APP_PAGE.account}`);
    } catch (caught) {
      showError(res, ProxyError.signInFailed, errorMessage(caught));
    }
  });

  router.get(FORWARD_AUTH_PATH.signOut, async (req, res) => {
    const live = await liveSessionOf(req);
    const token = readCookie(req, PROXY_COOKIE.session);
    if (token !== null) {
      await proxySessions.remove(token);
    }
    if (live !== null) {
      audit.record({ type: AuditType.ProxySignedOut, actor: actorOf(live.user), ip: req.ip ?? null });
    }
    res.clearCookie(PROXY_COOKIE.session, sessionCookie());
    const end = new URLSearchParams({ client_id: FORWARD_AUTH_DEFAULTS.clientId });
    res.redirect(HttpStatus.SeeOther, `${issuer}/session/end?${end}`);
  });

  return router;
}
