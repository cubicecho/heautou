import type { AdapterPayload } from 'oidc-provider';
import { OIDC_MOUNT_PATH } from '../core/config.ts';
import { ADMIN_DEFAULTS, FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import type { Branding } from '../store/branding.ts';
import type { ClientStore } from '../store/clients.ts';

/** What the sign-in page calls the admin UI. */
export const ADMIN_CLIENT_NAME = 'Heautou admin';
/** What the sign-in page and the session lists call the sites behind the reverse proxy (forward auth). */
export const PROXY_CLIENT_NAME = 'Protected sites';

/** The clients the server itself is, by client ID, and what they are called. */
const BUILT_IN_CLIENT_NAMES: ReadonlyMap<string, string> = new Map([
  [ADMIN_DEFAULTS.clientId, ADMIN_CLIENT_NAME],
  [FORWARD_AUTH_DEFAULTS.clientId, PROXY_CLIENT_NAME],
]);

/**
 * Names a client the server itself is.
 *
 * @param clientId - Any client ID.
 * @returns Its name, or null for a client the operator added or an app paired.
 */
export function builtInClientName(clientId: string): string | null {
  return BUILT_IN_CLIENT_NAMES.get(clientId) ?? null;
}

/**
 * Names a client as people see it: a built-in client by its own name, else by the name the client store holds.
 *
 * @param clients - The client store.
 * @param clientId - Any client ID.
 * @param [fallback] - The name to use for a client the store no longer has, such as the one a request gave.
 * @returns The name, or the client ID when nothing names it.
 */
export function clientDisplayName(clients: ClientStore, clientId: string, fallback?: string): string {
  return builtInClientName(clientId) ?? clients.find(clientId)?.name ?? fallback ?? clientId;
}

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
  /** Who is signed in, for the account page. */
  account: '/admin/account',
  /** Changes the signed-in user's password (POST). */
  accountPassword: '/admin/account/password',
  /** Ends every session of the signed-in user (POST). */
  accountSignOut: '/admin/account/sign-out-everywhere',
  /** The signed-in user's recent sign-ins, from the audit log. */
  accountActivity: '/admin/account/activity',
  /** Says whose a password link is (POST), and sets the password with it (POST to `/set`). */
  passwordLink: '/admin/password-link',
  passwordLinkSet: '/admin/password-link/set',
  /** The provider's name and whether it has a logo, for every page. */
  branding: '/admin/branding',
  /** The logo image. */
  logo: '/admin/branding/logo',
  /** The lowest password strength the rules take, for the strength meters. */
  passwordRules: '/admin/password-rules',
} as const;

/** The web app's pages the server links to. */
export const WEB_APP_PAGE = {
  /** A signed-in user's own page: their details, password and sessions. */
  account: '/account',
  /** Sets a password with a link's token, which is in the fragment: `#token=`. */
  setPassword: '/set-password',
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

/** The branding as the web app reads it. */
export interface BrandingView {
  name: string;
  /** Where the logo is served, versioned so a new one is fetched. Null when there is none. */
  logoUrl: string | null;
}

/**
 * Describes the branding for the web app.
 *
 * @param branding - The stored branding.
 * @returns The name and the logo's URL.
 */
export function brandingView(branding: Branding): BrandingView {
  const { name, logo } = branding;
  return { name, logoUrl: logo === null ? null : `${ADMIN_PATH.logo}?v=${encodeURIComponent(logo.updatedAt)}` };
}

/**
 * Names the client a session signed in to, as a user's session list shows it. The admin UI is also the account
 * page every user signs in to, so it goes by the provider's own name rather than "Heautou admin".
 *
 * @param clientId - The client.
 * @param clients - The client store.
 * @param branding - The stored branding.
 * @returns The client's name, or its ID when it was removed.
 */
export function sessionClientName(clientId: string, clients: ClientStore, branding: Branding): string {
  if (clientId === ADMIN_DEFAULTS.clientId) {
    return branding.name;
  }
  return clientDisplayName(clients, clientId);
}
