import type { Client, ErrorOut, KoaContextWithOIDC, Provider } from 'oidc-provider';
import { z } from 'zod';
import { DEVICE_FLOW_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { ClientStore } from '../store/clients.ts';
import { DEVICE_CODE_GRANT } from './adapter.ts';
import { clientNameIn, PAGE_PARAM, pageUrl, sendTo, WEB_PAGE } from './pages.ts';

/**
 * The steps of the web app's device page (`/device`), in its `step` parameter. With none it asks for the code.
 */
export const DeviceStep = {
  /** "Sign in to <client>?", with the code to check against the device's. */
  Confirm: 'confirm',
  /** "You're signed in", once the device has been approved. */
  Done: 'done',
} as const;
export type DeviceStep = (typeof DeviceStep)[keyof typeof DeviceStep];

/**
 * Why the device page asks for the code again, in its `error` parameter. Any other value is an OAuth error code,
 * such as `invalid_request` for a form that came from another page.
 */
export const DeviceError = {
  /** Nothing was typed. */
  NoCode: 'no_code',
  /** No device is waiting with that code. */
  NotFound: 'not_found',
  /** The code ran out before it was confirmed. */
  Expired: 'expired',
  /** The code was confirmed or cancelled already. */
  Used: 'used',
  /** The user cancelled; the device has been told. */
  Aborted: 'aborted',
} as const;
export type DeviceError = (typeof DeviceError)[keyof typeof DeviceError];

/** oidc-provider's names for the errors it shows the code page again for, and what the page calls them. */
const DEVICE_ERRORS_BY_NAME: Readonly<Record<string, DeviceError>> = {
  NoCodeError: DeviceError.NoCode,
  NotFoundError: DeviceError.NotFound,
  ExpiredError: DeviceError.Expired,
  AlreadyUsedError: DeviceError.Used,
  AbortedError: DeviceError.Aborted,
};

/** What the error of a user code the provider refused carries. */
const userCodeErrorSchema = z.object({ userCode: z.string() });

/** The part of the session state the device forms need: the anti-CSRF secret they carry. */
const formStateSchema = z.object({ secret: z.string() });

/** What the token endpoint is asked for when a device polls. */
const pollParamsSchema = z.object({ grant_type: z.literal(DEVICE_CODE_GRANT), device_code: z.string() });

/** What the token endpoint answers a device polling before its user has approved. */
const pendingBodySchema = z.object({ error: z.literal('authorization_pending') });

/** The part of the device authorization response this server changes. */
const deviceAuthorizationBodySchema = z.object({ user_code: z.string() }).loose();

/** Middleware run around every provider request, as `provider.use` takes it. */
type ProviderMiddleware = Parameters<Provider['use']>[0];

/** The provider's routes this module changes the answers of. */
const Route = { DeviceAuthorization: 'device_authorization', Token: 'token' } as const;

/**
 * Reads the secret the provider put in the session for the device forms.
 *
 * @param ctx - The provider's request, with a session.
 * @returns The secret, or undefined when the session has none.
 */
function formSecretOf(ctx: KoaContextWithOIDC): string | undefined {
  return formStateSchema.safeParse(ctx.oidc.session?.state).data?.secret;
}

/**
 * Builds oidc-provider's `features.deviceFlow` (RFC 8628). Its pages are the web app's `/device`, which posts plain
 * forms back to the provider's `/device`, as the logout page does to `/session/end/confirm`.
 *
 * @param clients - The client store, which names the client on the page.
 * @returns The feature's configuration.
 *
 * @remarks
 * Signing in on the way is the usual interaction (`interactions.ts`), so a password, a second factor, a passkey or an
 * upstream provider all work, and the same users are refused.
 */
export function deviceFlowFor(clients: ClientStore) {
  const { charset, mask } = DEVICE_FLOW_DEFAULTS;
  return {
    enabled: true,
    charset,
    mask,
    /**
     * Asks for the code a device shows, or for it again after a mistake.
     *
     * @param ctx - The provider's request. Its session holds the secret the form carries.
     * @param _form - The provider's own HTML form, unused.
     * @param [out] - The error, when the code was refused.
     * @param [err] - The error the provider threw.
     */
    userCodeInputSource(ctx: KoaContextWithOIDC, _form: string, out?: ErrorOut, err?: Error): void {
      const error = err === undefined ? undefined : (DEVICE_ERRORS_BY_NAME[err.name] ?? out?.error);
      sendTo(
        ctx,
        pageUrl(WEB_PAGE.device, {
          [PAGE_PARAM.xsrf]: formSecretOf(ctx),
          [PAGE_PARAM.error]: error,
          [PAGE_PARAM.userCode]: userCodeErrorSchema.safeParse(err).data?.userCode,
        }),
      );
    },
    /**
     * Asks the user to check the code against the device's and confirm, before they sign in.
     *
     * @param ctx - The provider's request.
     * @param _form - The provider's own HTML form, unused.
     * @param client - The device's client.
     * @param _deviceInfo - What the provider noted of the device, unused.
     * @param userCode - The code, as the device shows it.
     */
    userCodeConfirmSource(
      ctx: KoaContextWithOIDC,
      _form: string,
      client: Client,
      _deviceInfo: unknown,
      userCode: string,
    ): void {
      sendTo(
        ctx,
        pageUrl(WEB_PAGE.device, {
          [PAGE_PARAM.step]: DeviceStep.Confirm,
          [PAGE_PARAM.xsrf]: formSecretOf(ctx),
          [PAGE_PARAM.userCode]: userCode,
          [PAGE_PARAM.client]: clientNameIn(clients, ctx) ?? client.clientName ?? client.clientId,
        }),
      );
    },
    /**
     * Says the device has been approved and the page can be closed.
     *
     * @param ctx - The provider's request.
     */
    successSource(ctx: KoaContextWithOIDC): void {
      sendTo(
        ctx,
        pageUrl(WEB_PAGE.device, {
          [PAGE_PARAM.step]: DeviceStep.Done,
          [PAGE_PARAM.client]: clientNameIn(clients, ctx),
        }),
      );
    },
  };
}

/**
 * Builds the provider middleware that finishes the device flow's answers where oidc-provider leaves them short.
 *
 * @param webBase - Where the web app is: the issuer without `/oidc`.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The middleware, for `provider.use`.
 *
 * @remarks
 * The device authorization response names the web app's `/device` as `verification_uri`, which a person can type,
 * rather than the provider's, and says how often to poll (`interval`), which oidc-provider leaves out. A device that
 * polls sooner than that while its user has not approved yet is told `slow_down` rather than
 * `authorization_pending`; a poll changes nothing until then, so telling it after the provider answered is the same
 * as refusing it before. Polls are remembered in memory, per device code, for as long as a code can be polled.
 */
export function deviceFlowMiddleware(webBase: string, now: () => number = Date.now): ProviderMiddleware {
  const { pollSeconds, expiredKeptSeconds } = DEVICE_FLOW_DEFAULTS;
  const lastPolls = createExpiringMap<number>(TOKEN_LIFETIME_DEFAULTS.deviceCodeSeconds + expiredKeptSeconds, now);
  const verificationUri = `${webBase}${WEB_PAGE.device}`;

  return async (koaCtx, next) => {
    await next();
    const ctx = koaCtx as KoaContextWithOIDC;
    const route: string | undefined = ctx.oidc?.route;
    if (route === Route.DeviceAuthorization) {
      const body = deviceAuthorizationBodySchema.safeParse(ctx.body);
      if (body.success) {
        const complete = pageUrl(verificationUri, { [PAGE_PARAM.userCode]: body.data.user_code });
        ctx.body = {
          ...body.data,
          verification_uri: verificationUri,
          verification_uri_complete: complete,
          interval: pollSeconds,
        };
      }
      return;
    }
    if (route !== Route.Token) {
      return;
    }
    const poll = pollParamsSchema.safeParse(ctx.oidc.params);
    if (poll.success === false || pendingBodySchema.safeParse(ctx.body).success === false) {
      return;
    }
    const at = now();
    const last = lastPolls.get(poll.data.device_code);
    lastPolls.set(poll.data.device_code, at);
    const isTooSoon = last !== null && at - last < pollSeconds * MS_PER_SECOND;
    if (isTooSoon) {
      ctx.body = { error: 'slow_down', error_description: `poll at most every ${pollSeconds} seconds` };
    }
  };
}
