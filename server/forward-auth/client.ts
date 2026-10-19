import type { AdapterPayload } from 'oidc-provider';
import { adminUrls, PROXY_CLIENT_NAME } from '../admin/admin-client.ts';
import { FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import { type AuditTarget, AuditTargetKind } from '../store/audit.ts';
import type { ProtectedSite } from '../store/protected-sites.ts';

/** The forward auth routes. Every one is outside the web app's catch-all. */
export const FORWARD_AUTH_PATH = {
  /** What the reverse proxy asks about each request. */
  verify: '/auth/verify',
  /** Starts a sign-in; `?rd=` is where to go after. */
  signIn: '/auth/sign-in',
  /** Where the provider sends the browser back to. */
  callback: '/auth/callback',
  /** Ends the proxy session, then signs out at the provider. */
  signOut: '/auth/sign-out',
} as const;

/** The query parameters of the forward auth routes. */
export const FORWARD_AUTH_PARAM = {
  /** The address to return to after signing in, as Authelia and most proxies' docs call it. */
  returnTo: 'rd',
  /** On the verify endpoint: answer a browser's GET with a redirect to sign in rather than a 401. */
  redirect: 'redirect',
  /** On the sign-in route: ask for the password again, so a second factor is given. */
  stepUp: 'mfa',
} as const;

/** The value a flag parameter is set to. */
export const FLAG_ON = '1';

/** The forward auth cookies. */
export const PROXY_COOKIE = {
  /** The session: an opaque token, looked up in the proxy session store. On the cookie domain. */
  session: 'heautou_proxy',
  /** A sign-in under way: its state, PKCE verifier and return address, signed. On Heautou's host. */
  login: 'heautou_proxy_login',
} as const;

/** Where forward auth lives, worked out from the issuer. */
export interface ForwardAuthUrls {
  /** The absolute callback URL registered for the proxy client. */
  callback: string;
  /** The absolute sign-in URL, without its query. */
  signIn: string;
  /** The issuer's host, which the cookie domain must cover. */
  host: string;
}

/**
 * Works the forward auth URLs out from the issuer.
 *
 * @param issuer - The provider's public URL, ending in `/oidc`.
 * @returns The URLs.
 */
export function forwardAuthUrls(issuer: string): ForwardAuthUrls {
  const { base } = adminUrls(issuer);
  return {
    callback: `${base}${FORWARD_AUTH_PATH.callback}`,
    signIn: `${base}${FORWARD_AUTH_PATH.signIn}`,
    host: new URL(issuer).hostname,
  };
}

/**
 * The protected sites as a client of this provider: public, so it signs in with PKCE, with one redirect URI.
 *
 * @param issuer - The provider's public URL.
 * @returns Its client metadata.
 */
export function proxyClientMetadata(issuer: string): AdapterPayload {
  return {
    client_id: FORWARD_AUTH_DEFAULTS.clientId,
    client_name: PROXY_CLIENT_NAME,
    token_endpoint_auth_method: 'none',
    redirect_uris: [forwardAuthUrls(issuer).callback],
    post_logout_redirect_uris: [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

/**
 * Names a site as an audit entry's target.
 *
 * @param site - The site.
 * @returns The target.
 */
export function siteTarget(site: Pick<ProtectedSite, 'id' | 'name'>): AuditTarget {
  return { kind: AuditTargetKind.ProtectedSite, id: site.id, name: site.name };
}
