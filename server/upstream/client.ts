import * as oidc from 'openid-client';
import { z } from 'zod';
import { UPSTREAM_DEFAULTS } from '../core/defaults.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import { UpstreamKind, type UpstreamProvider } from '../store/upstreams.ts';

/** GitHub's OAuth 2.0 endpoints and API. It has no discovery document, so they are written here. */
const GITHUB = {
  /** Not an OpenID Connect issuer: the name links to GitHub identities are kept under. */
  issuer: 'https://github.com',
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
  emails: 'https://api.github.com/user/emails',
  /** The API version the replies below are read as. */
  apiVersion: '2022-11-28',
} as const;

/** What GitHub's API asks every caller to send. */
const USER_AGENT = 'heautou';

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
});
const githubEmailsSchema = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

/** Who signed in upstream, as the sign-in learned it. */
export interface UpstreamIdentity {
  providerId: string;
  /** The issuer that vouched for it: the ID token's `iss`, or GitHub's own. */
  issuer: string;
  /** The identity there: the ID token's `sub`, or GitHub's numeric user id. */
  subject: string;
  /** The address, only when the provider says it is verified. */
  verifiedEmail: string | null;
  /** Their username there, when it has one. */
  username: string | null;
  /** Their name there, when it gives one. */
  name: string | null;
  /** The values of the provider's groups claim. Empty when it has none or none is named. */
  groups: string[];
  /** What the user is shown it as: an address or a username. */
  label: string;
}

/** What has to come back with the code for the sign-in to be the one this server started. */
export interface FlowChecks {
  state: string;
  /** Null for GitHub, which issues no ID token. */
  nonce: string | null;
  /** The PKCE code verifier. */
  verifier: string;
}

/** Talks to the upstream providers: where to send a browser, and who came back. */
export interface UpstreamClient {
  /**
   * Builds the authorization request for a sign-in, with PKCE, a state and (for OpenID Connect) a nonce.
   *
   * @param provider - The provider.
   * @param redirectUri - Where it sends the browser back.
   * @returns The URL to send the browser to, and what to check when it comes back.
   */
  authorize: (provider: UpstreamProvider, redirectUri: string) => Promise<{ url: URL; checks: FlowChecks }>;
  /**
   * Swaps the code the browser came back with for the identity it stands for.
   *
   * @param provider - The provider.
   * @param callback - The URL the browser came back to, with its query.
   * @param checks - What `authorize` said to check.
   * @returns The identity.
   * @throws When the state, the code, the ID token or the API's answer is wrong.
   */
  identify: (provider: UpstreamProvider, callback: URL, checks: FlowChecks) => Promise<UpstreamIdentity>;
}

/** What the client is built with. */
export interface UpstreamClientDeps {
  /** Makes every request to the providers, so a test can stand in for GitHub. */
  fetch: typeof globalThis.fetch;
  /** The clock, in epoch milliseconds, for how long a discovery document is kept. */
  now?: () => number;
}

/**
 * Reads a claim that is a string.
 *
 * @param claims - The claims.
 * @param name - The claim.
 * @returns Its value, or null when it is missing, empty or not a string.
 */
function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Reads a groups claim: a list of strings, or one string.
 *
 * @param claims - The claims.
 * @param name - The claim, or null for none.
 * @returns The groups.
 */
function groupsClaim(claims: Record<string, unknown>, name: string | null): string[] {
  const value = name === null ? undefined : claims[name];
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value) ? value.filter((group): group is string => typeof group === 'string') : [];
}

/**
 * Says whether the claims vouch for the address. Some providers send `email_verified` as a string.
 *
 * @param claims - The claims.
 * @returns Whether `email_verified` is true.
 */
function isEmailVerified(claims: Record<string, unknown>): boolean {
  const verified = claims.email_verified;
  return verified === true || verified === 'true';
}

/**
 * Picks how this server proves itself at a provider's token endpoint: the secret in a Basic header, which the spec
 * makes the default, unless the provider says it takes only the form body. A public client sends none.
 *
 * @param secret - The client secret, or null.
 * @param methods - What the discovery document lists, when it does.
 * @returns The client authentication.
 */
function clientAuthFor(secret: string | null, methods: readonly string[] | undefined): oidc.ClientAuth {
  if (secret === null) {
    return oidc.None();
  }
  const isPostOnly = methods !== undefined && methods.includes('client_secret_basic') === false;
  return isPostOnly ? oidc.ClientSecretPost(secret) : oidc.ClientSecretBasic(secret);
}

/**
 * Builds the client the sign-ins talk to providers through. OpenID Connect providers go through openid-client:
 * discovery, PKCE, state, nonce and the ID token's signature, issuer, audience and expiry. GitHub goes through the
 * same code exchange, and its API says who signed in.
 *
 * @param deps - The fetch to use and the clock.
 * @returns The client.
 */
export function createUpstreamClient(deps: UpstreamClientDeps): UpstreamClient {
  const { fetch: send, now = Date.now } = deps;
  // openid-client hands fetch a plain body (a string or bytes); its type is wider than RequestInit names.
  const customFetch: oidc.CustomFetch = (url, options) => send(url, options as RequestInit);
  const discovered = createExpiringMap<Promise<oidc.Configuration>>(UPSTREAM_DEFAULTS.discoverySeconds, now);

  /**
   * Builds the openid-client configuration for a provider, discovering an OpenID Connect one. A discovery is
   * kept for `UPSTREAM_DEFAULTS.discoverySeconds`, and forgotten when it fails or the provider changes.
   *
   * @param provider - The provider.
   * @returns The configuration.
   */
  const configurationOf = (provider: UpstreamProvider): Promise<oidc.Configuration> => {
    const { id, kind, issuer, clientId, clientSecret } = provider;
    if (kind === UpstreamKind.GitHub || issuer === null) {
      const config = new oidc.Configuration(
        {
          issuer: GITHUB.issuer,
          authorization_endpoint: GITHUB.authorizationEndpoint,
          token_endpoint: GITHUB.tokenEndpoint,
        },
        clientId,
        clientSecret ?? undefined,
        clientAuthFor(clientSecret, ['client_secret_post']),
      );
      config[oidc.customFetch] = customFetch;
      config.timeout = UPSTREAM_DEFAULTS.requestTimeoutSeconds;
      return Promise.resolve(config);
    }
    const key = JSON.stringify([id, issuer, clientId, clientSecret]);
    const cached = discovered.get(key);
    if (cached !== null) {
      return cached;
    }
    const isPlainHttp = new URL(issuer).protocol === 'http:';
    const found = oidc
      .discovery(new URL(issuer), clientId, clientSecret ?? undefined, undefined, {
        [oidc.customFetch]: customFetch,
        timeout: UPSTREAM_DEFAULTS.requestTimeoutSeconds,
        // The store only saves a plain http issuer on loopback or when the operator allows plain http.
        execute: isPlainHttp ? [oidc.allowInsecureRequests] : [],
      })
      .then((config) => {
        const methods = config.serverMetadata().token_endpoint_auth_methods_supported;
        const authed = new oidc.Configuration(
          config.serverMetadata(),
          clientId,
          clientSecret ?? undefined,
          clientAuthFor(clientSecret, methods),
        );
        authed[oidc.customFetch] = customFetch;
        authed.timeout = UPSTREAM_DEFAULTS.requestTimeoutSeconds;
        if (isPlainHttp) {
          oidc.allowInsecureRequests(authed);
        }
        return authed;
      });
    found.catch(() => discovered.delete(key));
    discovered.set(key, found);
    return found;
  };

  /**
   * Reads a GitHub API resource with the user's access token.
   *
   * @param url - The resource.
   * @param accessToken - The token.
   * @returns The parsed JSON.
   * @throws When GitHub answers with an error.
   */
  const githubGet = async (url: string, accessToken: string): Promise<unknown> => {
    const response = await send(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': GITHUB.apiVersion,
      },
      signal: AbortSignal.timeout(UPSTREAM_DEFAULTS.requestTimeoutSeconds * MS_PER_SECOND),
    });
    const isRefused = response.ok === false;
    if (isRefused) {
      throw new Error(`GitHub answered ${response.status} for ${new URL(url).pathname}.`);
    }
    return response.json();
  };

  /**
   * Reads who signed in to GitHub: the user, and their primary address when it is verified.
   *
   * @param provider - The provider.
   * @param accessToken - The user's access token.
   * @returns The identity.
   */
  const githubIdentity = async (provider: UpstreamProvider, accessToken: string): Promise<UpstreamIdentity> => {
    const user = githubUserSchema.parse(await githubGet(GITHUB.user, accessToken));
    const emails = githubEmailsSchema.parse(await githubGet(GITHUB.emails, accessToken));
    const primary = emails.find((each) => each.primary && each.verified) ?? null;
    return {
      providerId: provider.id,
      issuer: GITHUB.issuer,
      subject: String(user.id),
      verifiedEmail: primary?.email ?? null,
      username: user.login,
      name: user.name ?? null,
      groups: [],
      label: user.login,
    };
  };

  return {
    authorize: async (provider, redirectUri) => {
      const config = await configurationOf(provider);
      const isOidc = provider.kind === UpstreamKind.Oidc;
      const checks: FlowChecks = {
        state: oidc.randomState(),
        nonce: isOidc ? oidc.randomNonce() : null,
        verifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: provider.scopes.join(' '),
        state: checks.state,
        code_challenge: await oidc.calculatePKCECodeChallenge(checks.verifier),
        code_challenge_method: 'S256',
        ...(checks.nonce === null ? {} : { nonce: checks.nonce }),
      });
      return { url, checks };
    },
    identify: async (provider, callback, checks) => {
      const config = await configurationOf(provider);
      const tokens = await oidc.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        ...(checks.nonce === null ? {} : { expectedNonce: checks.nonce, idTokenExpected: true }),
      });
      if (provider.kind === UpstreamKind.GitHub) {
        return githubIdentity(provider, tokens.access_token);
      }
      const idToken = tokens.claims();
      if (idToken === undefined) {
        throw new Error(`${provider.name} sent no ID token.`);
      }
      const hasUserInfo = config.serverMetadata().userinfo_endpoint !== undefined;
      // The ID token is what was signed for this sign-in, so it wins; the userinfo endpoint fills in the rest.
      const userInfo = hasUserInfo ? await oidc.fetchUserInfo(config, tokens.access_token, idToken.sub) : {};
      const claims: Record<string, unknown> = { ...userInfo, ...idToken };
      const email = stringClaim(claims, 'email');
      const username = stringClaim(claims, 'preferred_username') ?? stringClaim(claims, 'nickname');
      return {
        providerId: provider.id,
        issuer: idToken.iss,
        subject: idToken.sub,
        verifiedEmail: email !== null && isEmailVerified(claims) ? email : null,
        username,
        name: stringClaim(claims, 'name'),
        groups: groupsClaim(claims, provider.groupsClaim),
        label: email ?? username ?? idToken.sub,
      };
    },
  };
}
