import type { AdapterPayload } from 'oidc-provider';
import { OIDC_MOUNT_PATH } from '../core/config.ts';
import { ADMIN_DEFAULTS } from '../core/defaults.ts';

/** What the sign-in page calls the admin UI. */
export const ADMIN_CLIENT_NAME = 'Heautou admin';

/** The admin UI's server routes. */
export const ADMIN_PATH = {
  /** Starts a sign-in; `?return=` is where to go after. */
  login: '/admin/login',
  /** Where the provider sends the browser back to. */
  callback: '/admin/callback',
  /** Ends the admin session (POST). */
  logout: '/admin/logout',
  /** Whether an admin is still to be made, and makes one (POST). */
  setup: '/admin/setup',
} as const;

/** Where the admin UI lives, worked out from the issuer. */
export interface AdminUrls {
  /** The issuer without `/oidc`: the web app's root. */
  base: string;
  /** The issuer's origin, which every admin request must come from. */
  origin: string;
  /** The absolute callback URL registered for the admin client. */
  callback: string;
  /** Whether cookies get `Secure`. */
  isHttps: boolean;
}

/**
 * Works the admin URLs out from the issuer.
 *
 * @param issuer - The provider's public URL, ending in `/oidc`.
 * @returns The URLs.
 */
export function adminUrls(issuer: string): AdminUrls {
  const base = issuer.slice(0, -OIDC_MOUNT_PATH.length);
  const url = new URL(issuer);
  return { base, origin: url.origin, callback: `${base}${ADMIN_PATH.callback}`, isHttps: url.protocol === 'https:' };
}

/**
 * The admin UI as a client of its own provider: public, so it signs in with PKCE, and with one redirect URI.
 *
 * @param issuer - The provider's public URL.
 * @returns Its client metadata.
 */
export function adminClientMetadata(issuer: string): AdapterPayload {
  return {
    client_id: ADMIN_DEFAULTS.clientId,
    client_name: ADMIN_CLIENT_NAME,
    token_endpoint_auth_method: 'none',
    redirect_uris: [adminUrls(issuer).callback],
    post_logout_redirect_uris: [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}
