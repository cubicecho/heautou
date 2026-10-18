import Provider, { type Account, type AdapterFactory, interactionPolicy } from 'oidc-provider';
import { BACKCHANNEL_LOGOUT_DEFAULTS, TOKEN_LIFETIME_DEFAULTS } from '../core/defaults.ts';
import { DEFAULT_GROUPS_CLAIM } from '../store/claims.ts';
import { ClientAuthMethod, type ClientStore, type ClientTokenLifetimes, type OidcClient } from '../store/clients.ts';
import type { ProviderKeys } from '../store/keys.ts';
import type { PairingStore } from '../store/pairings.ts';
import type { SettingsStore } from '../store/settings.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { createPageSources } from './pages.ts';
import { createPairingPolicy, PAIRING_POLICY } from './pairing.ts';

/** The scopes clients may ask for. */
export const SCOPES = ['openid', 'offline_access', 'profile', 'email', 'groups'] as const;

/**
 * How a user signed in, in the `acr` claim: a password alone, or with a second factor (or a passkey that checked
 * the user). The `amr` claim lists the methods (RFC 8176).
 */
export const AuthLevel = { Password: 'pwd', MultiFactor: 'mfa' } as const;
export type AuthLevel = (typeof AuthLevel)[keyof typeof AuthLevel];

/** How a user proved who they are, in the `amr` claim (RFC 8176). */
export const AuthMethod = {
  Password: 'pwd',
  /** A one-time code: an authenticator app's, or a recovery code. */
  OneTimeCode: 'otp',
  /** A passkey: a key held in hardware or a password manager. */
  HardwareKey: 'hwk',
  /** The passkey checked the user, with a PIN or a fingerprint. */
  UserVerified: 'user',
  /** More than one factor. */
  MultiFactor: 'mfa',
  /** An upstream provider, such as Google or GitHub, vouched for the user. */
  Federated: 'fed',
} as const;
export type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];

/** Which claims each scope releases, before the operator's own. */
const CLAIMS_BY_SCOPE = {
  // How the user signed in goes in every ID token, so an app can ask for a second factor.
  openid: ['sub', 'acr', 'amr'],
  profile: ['name', 'preferred_username'],
  email: ['email', 'email_verified'],
  groups: [DEFAULT_GROUPS_CLAIM],
};

/**
 * The claim names the operator has added: custom user claims, released with `profile`, and the names clients get
 * groups under, released with `groups`. oidc-provider fixes its claims when it is built, so a change to these
 * means building it again.
 */
export interface ClaimNames {
  custom: string[];
  groups: string[];
}

/**
 * Collects the claim names in use.
 *
 * @param users - The user store.
 * @param clients - The client store.
 * @returns Each name once, sorted.
 */
export function claimNamesIn(users: UserStore, clients: ClientStore): ClaimNames {
  const sorted = (names: string[]): string[] => [...new Set(names)].sort();
  return {
    custom: sorted(users.list().flatMap((user) => Object.keys(user.claims))),
    groups: sorted(clients.list().map((client) => client.groupsClaim)),
  };
}

/**
 * Says whether a user may sign in to a client now.
 *
 * @param user - The user.
 * @param client - The operator's client, or null for one the server is itself, such as the admin UI.
 * @returns False for a disabled user, or one in none of the groups the client is limited to.
 */
export function maySignIn(user: PublicUser, client: OidcClient | null): boolean {
  if (user.disabled) {
    return false;
  }
  const allowed = client?.allowedGroups ?? [];
  return allowed.length === 0 || user.groups.some((group) => allowed.includes(group));
}

/**
 * The provider's prompts, with one more reason to ask for a sign-in: the browser has a session, but `findAccount`
 * turns its user away for this client (disabled, or not in the client's groups). Without it the provider skips the
 * login prompt, since the session names an account, and fails later with no account to grant to.
 *
 * @returns The interaction policy.
 */
function interactionPolicyFor(): interactionPolicy.DefaultPolicy {
  const policy = interactionPolicy.base();
  policy
    .get('login')
    ?.checks.add(
      new interactionPolicy.Check('account_refused', 'This user may not sign in to this client', (ctx) =>
        ctx.oidc.session?.accountId !== undefined && ctx.oidc.account === undefined
          ? interactionPolicy.Check.REQUEST_PROMPT
          : interactionPolicy.Check.NO_NEED_TO_PROMPT,
      ),
      0,
    );
  return policy;
}

/** Where the provider sends a browser to sign in or consent. Served by `interactions.ts`. */
export const INTERACTION_PATH = '/interaction';

/** What the provider is built from. */
export interface ProviderDeps {
  /** The public URL of the provider, ending in `/oidc`. */
  issuer: string;
  clients: ClientStore;
  users: UserStore;
  /** The setup URLs apps register with. */
  pairings: PairingStore;
  /** The operator's settings, for whether a paired app may register plain http redirect URIs. */
  settings: SettingsStore;
  keys: ProviderKeys;
  /** Persists the provider's sessions, codes and tokens. */
  adapter: AdapterFactory;
  /** Whether X-Forwarded-Proto and -Host are believed, as they are behind a TLS-terminating proxy. */
  isProxied: boolean;
  /** The claim names the operator added. */
  claimNames: ClaimNames;
  /** Makes the provider's outgoing requests: the logout tokens it posts to apps. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Lists every claim a user has. The provider releases only those the granted scopes cover.
 *
 * @param user - The user.
 * @param [groupsClaim] - The claim the client reads groups from.
 * @returns Their claims.
 */
export function claimsOf(user: PublicUser, groupsClaim: string = DEFAULT_GROUPS_CLAIM): Record<string, unknown> {
  const hasEmail = user.email !== '';
  return {
    ...user.claims,
    sub: user.id,
    preferred_username: user.username,
    name: user.name === '' ? undefined : user.name,
    // The operator typed the address in, so it is as verified as this provider can make it.
    email: hasEmail ? user.email : undefined,
    email_verified: hasEmail ? true : undefined,
    [groupsClaim]: user.groups,
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

/** What the provider's `ttl` functions are handed for the client a token is for. */
interface TokenOwner {
  clientId?: string;
}

/**
 * Builds the provider's token lifetimes: each client's own where the operator set one, the server's default
 * otherwise.
 *
 * @param clients - The client store, read when each token is made so a change applies to the next one.
 * @returns The `ttl` configuration.
 */
export function tokenLifetimesFor(clients: ClientStore) {
  const {
    accessTokenSeconds,
    idTokenSeconds,
    refreshTokenSeconds,
    interactionSeconds,
    sessionSeconds,
    grantSeconds,
    clientCredentialsSeconds,
  } = TOKEN_LIFETIME_DEFAULTS;

  const lifetimeOf = (owner: TokenOwner | undefined, pick: keyof ClientTokenLifetimes, fallback: number): number => {
    const client = owner?.clientId === undefined ? null : clients.find(owner.clientId);
    return client?.tokenLifetimes[pick] ?? fallback;
  };

  return {
    AccessToken: (_ctx: unknown, _token: unknown, client?: TokenOwner) =>
      lifetimeOf(client, 'accessTokenSeconds', accessTokenSeconds),
    ClientCredentials: (_ctx: unknown, _token: unknown, client?: TokenOwner) =>
      lifetimeOf(client, 'accessTokenSeconds', clientCredentialsSeconds),
    IdToken: (_ctx: unknown, _token: unknown, client?: TokenOwner) =>
      lifetimeOf(client, 'idTokenSeconds', idTokenSeconds),
    RefreshToken: (_ctx: unknown, _token: unknown, client?: TokenOwner) =>
      lifetimeOf(client, 'refreshTokenSeconds', refreshTokenSeconds),
    // A refresh token is useless once its grant is gone, so a client with longer refresh tokens keeps its grant
    // as long.
    Grant: (_ctx: unknown, grant: TokenOwner) =>
      Math.max(grantSeconds, lifetimeOf(grant, 'refreshTokenSeconds', grantSeconds)),
    Interaction: interactionSeconds,
    Session: sessionSeconds,
  };
}

/**
 * Wraps the fetch the provider's outgoing requests go through, which are the logout tokens it posts to apps.
 *
 * @param send - The fetch to make them with.
 * @returns The provider's `fetch` option.
 *
 * @remarks
 * oidc-provider refuses private and loopback addresses, to keep an app it doesn't trust from aiming it at the local
 * network. Here every URI it calls was saved by the operator or by an app paired with the operator's setup URL, and
 * the apps are on the local network, so that dispatcher is dropped.
 */
function outgoingFetch(send: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init = {}) => {
    const { dispatcher: _ssrfGuard, ...rest }: RequestInit & { dispatcher?: unknown } = init;
    return send(input, { ...rest, signal: AbortSignal.timeout(BACKCHANNEL_LOGOUT_DEFAULTS.timeoutMs) });
  };
}

/**
 * Builds the OpenID provider. It is a Koa app; `app.ts` mounts its callback under `/oidc`.
 *
 * @param deps - What the provider is built from.
 * @returns The provider.
 */
export function createProvider(deps: ProviderDeps): Provider {
  const { logoutSource, postLogoutSuccessSource, renderError } = createPageSources(deps.clients);

  const provider = new Provider(deps.issuer, {
    adapter: deps.adapter,
    clients: [],
    jwks: { keys: deps.keys.jwks },
    cookies: { keys: deps.keys.cookieKeys },
    scopes: [...SCOPES],
    acrValues: Object.values(AuthLevel),
    claims: {
      amr: null,
      ...CLAIMS_BY_SCOPE,
      profile: [...CLAIMS_BY_SCOPE.profile, ...deps.claimNames.custom],
      groups: [...new Set([...CLAIMS_BY_SCOPE.groups, ...deps.claimNames.groups])],
    },
    renderError,
    // Many self-hosted apps read the profile from the ID token and never call userinfo.
    conformIdTokenClaims: false,
    // Every sign-in, token refresh and userinfo call looks the user up here, so a disabled user or one outside a
    // client's groups is turned away at each of them.
    findAccount: async (ctx, sub): Promise<Account | undefined> => {
      const user = deps.users.find(sub);
      const clientId = ctx.oidc?.client?.clientId;
      const client = clientId === undefined ? null : deps.clients.find(clientId);
      if (user === null || maySignIn(user, client) === false) {
        return undefined;
      }
      const groupsClaim = client?.groupsClaim ?? DEFAULT_GROUPS_CLAIM;
      return { accountId: user.id, claims: async () => ({ ...claimsOf(user, groupsClaim), sub: user.id }) };
    },
    interactions: {
      policy: interactionPolicyFor(),
      url: (_ctx, interaction) => `${INTERACTION_PATH}/${interaction.uid}`,
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: {
        enabled: true,
        // A confidential client, such as an API checking the tokens it is sent, may ask about any token. A public
        // client has no secret to prove who it is, so it may only ask about its own.
        allowedPolicy: async (ctx, client, token) =>
          client.clientAuthMethod !== ClientAuthMethod.None || token.clientId === ctx.oidc.client?.clientId,
      },
      // Only clients the operator allowed list the grant; see `clientMetadata`.
      clientCredentials: { enabled: true },
      // The web app draws these pages; the provider's own are plain HTML.
      rpInitiatedLogout: { enabled: true, logoutSource, postLogoutSuccessSource },
      // An app pairs itself with a setup URL, whose token registers one client (RFC 7591). Every token is made by
      // `startPairing` and carries the pairing policy, which stores the client.
      registration: {
        enabled: true,
        initialAccessToken: true,
        issueRegistrationAccessToken: true,
        policies: { [PAIRING_POLICY]: createPairingPolicy(deps) },
      },
      // The app can update or remove itself later with the registration access token it was given (RFC 7592).
      registrationManagement: { enabled: true, rotateRegistrationAccessToken: true },
      // A sign-out at the provider posts a logout token to each app the session signed in to that has a
      // `backchannel_logout_uri`. Sessions an admin ends are told by `backchannel.ts`.
      backchannelLogout: { enabled: true },
    },
    fetch: outgoingFetch(deps.fetch ?? globalThis.fetch),
    // A browser app may call the token endpoint from the origins it was registered to return to.
    clientBasedCORS: (_ctx, origin, client) => (client.redirectUris ?? []).some((uri) => originOf(uri) === origin),
    ttl: tokenLifetimesFor(deps.clients),
  });
  provider.proxy = deps.isProxied;
  // The browser only sees "server_error"; this is the one trace of what went wrong.
  provider.on('server_error', (_ctx, error) => console.error('[oidc]', error));
  return provider;
}
