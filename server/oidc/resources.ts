import { type Client, errors, type KoaContextWithOIDC, type ResourceServer } from 'oidc-provider';
import type { ApiStore } from '../store/apis.ts';

/** The grant a machine client gets a token for itself with. */
const CLIENT_CREDENTIALS_GRANT = 'client_credentials';

/** What a token's `ttl` function sees of the API it is for. */
export interface TokenAudience {
  resourceServer?: { accessTokenTTL?: number | undefined } | undefined;
}

/**
 * Reads the access token lifetime an API set, for the token's `ttl` function.
 *
 * @param token - The token being made.
 * @returns The API's lifetime in seconds, or undefined for a token with no API or an API that set none.
 */
export function apiLifetimeOf(token: TokenAudience | undefined): number | undefined {
  return token?.resourceServer?.accessTokenTTL;
}

/**
 * Builds oidc-provider's `features.resourceIndicators` (RFC 8707) on the API store, which is read on every
 * request, so a change applies to the next token without rebuilding the provider.
 *
 * @param apis - The API store.
 * @returns The feature's configuration.
 *
 * @remarks
 * An app names the API with `resource`; a client the API doesn't list gets `invalid_target`. At the token endpoint a
 * request that leaves `resource` out gets the one granted at sign-in. A client credentials request that leaves it out
 * gets the client's only API, when it is allowed exactly one.
 */
export function resourceIndicatorsFor(apis: ApiStore) {
  return {
    enabled: true,
    getResourceServerInfo: (_ctx: KoaContextWithOIDC, identifier: string, client: Client): ResourceServer => {
      const api = apis.find(identifier);
      if (api === null) {
        throw new errors.InvalidTarget('no API has this identifier');
      }
      const isAllowed = api.allowedClientIds.includes(client.clientId);
      if (isAllowed === false) {
        throw new errors.InvalidTarget('this client may not ask for tokens to this API');
      }
      return {
        scope: api.scopes.join(' '),
        audience: api.identifier,
        accessTokenFormat: api.tokenFormat,
        accessTokenTTL: api.accessTokenSeconds ?? undefined,
      };
    },
    defaultResource: (
      ctx: KoaContextWithOIDC,
      client: Client,
      oneOf?: readonly string[],
    ): string | readonly string[] | undefined => {
      if (oneOf !== undefined) {
        return oneOf;
      }
      if (ctx.oidc.params?.grant_type !== CLIENT_CREDENTIALS_GRANT) {
        return undefined;
      }
      const allowed = apis.list().filter((api) => api.allowedClientIds.includes(client.clientId));
      return allowed.length === 1 ? allowed[0]?.identifier : undefined;
    },
    useGrantedResource: (): boolean => true,
  };
}
