import type { ErrorOut, KoaContextWithOIDC } from 'oidc-provider';
import { z } from 'zod';
import { HttpStatus } from '../core/wire.ts';
import type { ClientStore } from '../store/clients.ts';

/**
 * The web app's pages the provider sends a browser to, in place of the plain HTML oidc-provider
 * draws by default. Each reads what it shows from its query string.
 */
export const WEB_PAGE = {
  /** Sign in: `/login/:uid`. It posts back to `/interaction/:uid/login`. */
  login: '/login',
  /** "Sign out of Heautou?". It posts a form to the provider's `/session/end/confirm`. */
  logout: '/logout',
  /** "You're signed out", when the client gave nowhere to go back to. */
  loggedOut: '/logged-out',
  /** Any error the provider would otherwise draw itself. */
  error: '/error',
} as const;

/** The query parameters the web pages read. */
export const PAGE_PARAM = {
  /** The logout form's anti-CSRF secret. */
  xsrf: 'xsrf',
  /** The name of the client involved, when there is one. */
  client: 'client',
  /** The OAuth error code, such as `invalid_redirect_uri`. */
  error: 'error',
  /** What the provider said about the error. */
  description: 'description',
  /** The redirect URI the client sent, so a mismatch can be fixed. */
  redirectUri: 'redirect_uri',
} as const;

/** The part of the session state the logout form needs. */
const logoutStateSchema = z.object({ secret: z.string() });

/** The request parameter an unregistered redirect URI arrives in. */
const redirectParamsSchema = z.object({ redirect_uri: z.string() });

/**
 * Builds a web page's URL with its query string, leaving out empty values.
 *
 * @param page - The page's path.
 * @param params - Its query parameters.
 * @returns A root-relative URL.
 */
export function pageUrl(page: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(key, value);
    }
  }
  const search = query.toString();
  return search === '' ? page : `${page}?${search}`;
}

/**
 * Sends the browser to a web page. A 303, so a POST that ends here becomes a GET.
 *
 * @param ctx - The provider's request.
 * @param url - Where to go.
 */
function sendTo(ctx: KoaContextWithOIDC, url: string): void {
  ctx.status = HttpStatus.SeeOther;
  ctx.redirect(url);
}

/**
 * Builds the provider's page hooks over the client store, which names the client on each page.
 *
 * @param clients - The client store.
 * @returns The `logoutSource`, `postLogoutSuccessSource` and `renderError` hooks.
 */
export function createPageSources(clients: ClientStore) {
  const clientName = (ctx: KoaContextWithOIDC): string | undefined => {
    const clientId = ctx.oidc.client?.clientId;
    return clientId === undefined ? undefined : (clients.find(clientId)?.name ?? clientId);
  };

  return {
    /**
     * Asks whether to sign out. The web page posts the secret back to the provider's confirm endpoint.
     *
     * @param ctx - The end-session request. Its session holds the secret the form carries.
     */
    logoutSource(ctx: KoaContextWithOIDC): void {
      const { secret } = logoutStateSchema.parse(ctx.oidc.session?.state);
      sendTo(ctx, pageUrl(WEB_PAGE.logout, { [PAGE_PARAM.xsrf]: secret, [PAGE_PARAM.client]: clientName(ctx) }));
    },

    /**
     * Says the user is signed out, when the client gave no post-logout redirect URI.
     *
     * @param ctx - The end-session success request.
     */
    postLogoutSuccessSource(ctx: KoaContextWithOIDC): void {
      sendTo(ctx, pageUrl(WEB_PAGE.loggedOut, { [PAGE_PARAM.client]: clientName(ctx) }));
    },

    /**
     * Shows an error the provider cannot send back to the client, such as an unregistered redirect URI.
     *
     * @param ctx - The failed request.
     * @param out - The error code and description.
     */
    renderError(ctx: KoaContextWithOIDC, out: ErrorOut): void {
      sendTo(
        ctx,
        pageUrl(WEB_PAGE.error, {
          [PAGE_PARAM.error]: out.error,
          [PAGE_PARAM.description]: out.error_description,
          [PAGE_PARAM.client]: clientName(ctx),
          [PAGE_PARAM.redirectUri]: redirectParamsSchema.safeParse(ctx.oidc?.params).data?.redirect_uri,
        }),
      );
    },
  };
}
