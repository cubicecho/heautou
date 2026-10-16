import Provider, { type Account, type AdapterFactory } from 'oidc-provider';
import { TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import type { ClientStore } from '../store/clients.ts';
import type { ProviderKeys } from '../store/keys.ts';
import type { PublicUser, UserStore } from '../store/users.ts';

/** The scopes clients may ask for. */
export const SCOPES = ['openid', 'offline_access', 'profile', 'email', 'groups'] as const;

/** Which claims each scope releases. */
const CLAIMS_BY_SCOPE = {
  openid: ['sub'],
  profile: ['name', 'preferred_username'],
  email: ['email', 'email_verified'],
  groups: ['groups'],
};

/** Where the provider sends a browser to sign in or consent. Served by `interactions.ts`. */
export const INTERACTION_PATH = '/interaction';

/** What the provider is built from. */
export interface ProviderDeps {
  /** The public URL of the provider, ending in `/oidc`. */
  issuer: string;
  clients: ClientStore;
  users: UserStore;
  keys: ProviderKeys;
  /** Persists the provider's sessions, codes and tokens. */
  adapter: AdapterFactory;
  /** Whether X-Forwarded-Proto and -Host are believed, as they are behind a TLS-terminating proxy. */
  isProxied: boolean;
}

/**
 * Lists every claim a user has. The provider releases only those the granted scopes cover.
 *
 * @param user - The user.
 * @returns Their claims.
 */
export function claimsOf(user: PublicUser): Record<string, unknown> {
  const hasEmail = user.email !== '';
  return {
    sub: user.id,
    preferred_username: user.username,
    name: user.name === '' ? undefined : user.name,
    // The operator typed the address in, so it is as verified as this provider can make it.
    email: hasEmail ? user.email : undefined,
    email_verified: hasEmail ? true : undefined,
    groups: user.groups,
  };
}

/**
 * Reads the origin of a URI.
 *
 * @param uri - Any URI.
 * @returns Its origin, or null when it has none (a custom scheme).
 */
function originOf(uri: string): string | null {
  return URL.canParse(uri) ? new URL(uri).origin : null;
}

/**
 * Builds the OpenID provider. It is a Koa app; `app.ts` mounts its callback under `/oidc`.
 *
 * @param deps - What the provider is built from.
 * @returns The provider.
 */
export function createProvider(deps: ProviderDeps): Provider {
  const { accessTokenSeconds, idTokenSeconds, refreshTokenSeconds, interactionSeconds, sessionSeconds, grantSeconds } =
    TOKEN_LIFETIME_DEFAULTS;

  const provider = new Provider(deps.issuer, {
    adapter: deps.adapter,
    clients: [],
    jwks: { keys: deps.keys.jwks },
    cookies: { keys: deps.keys.cookieKeys },
    scopes: [...SCOPES],
    claims: CLAIMS_BY_SCOPE,
    // Many self-hosted apps read the profile from the ID token and never call userinfo.
    conformIdTokenClaims: false,
    findAccount: async (_ctx, sub): Promise<Account | undefined> => {
      const user = deps.users.find(sub);
      if (user === null) {
        return undefined;
      }
      return { accountId: user.id, claims: async () => ({ ...claimsOf(user), sub: user.id }) };
    },
    interactions: { url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
    },
    // A browser app may call the token endpoint from the origins it was registered to return to.
    clientBasedCORS: (_ctx, origin, client) => (client.redirectUris ?? []).some((uri) => originOf(uri) === origin),
    ttl: {
      AccessToken: accessTokenSeconds,
      IdToken: idTokenSeconds,
      RefreshToken: refreshTokenSeconds,
      Interaction: interactionSeconds,
      Session: sessionSeconds,
      Grant: grantSeconds,
    },
  });
  provider.proxy = deps.isProxied;
  return provider;
}
