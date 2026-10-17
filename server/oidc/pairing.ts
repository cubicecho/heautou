import Provider, { type ClientMetadata, errors, type KoaContextWithOIDC } from 'oidc-provider';
import { PAIRING_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import {
  CLIENT_SOURCE_PAIRED,
  ClientAuthMethod,
  type ClientFields,
  type ClientStore,
  type OidcClient,
} from '../store/clients.ts';
import type { Pairing, PairingInput, PairingStore } from '../store/pairings.ts';
import { redirectProblem } from '../store/redirect-uris.ts';
import type { SettingsStore } from '../store/settings.ts';

/** The registration policy every setup URL's initial access token carries. */
export const PAIRING_POLICY = 'heautou-pairing';
/** The fragment key the setup URL carries the initial access token under. */
export const SETUP_URL_TOKEN = 'setup';
/** The fragment key the setup URL carries the provider's name under, for the app's sign-in button. */
export const SETUP_URL_NAME = 'name';

/** The grant types a paired client may register. */
const PAIRED_GRANT_TYPES: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token', 'client_credentials']);
const CLIENT_CREDENTIALS = 'client_credentials';
/** What a client registers when it names no grant types, as RFC 7591 says. */
const DEFAULT_GRANT_TYPES = ['authorization_code'];
/** The one response type the provider serves. */
const CODE = 'code';
/** What a paired app is called when it gives no `client_name`. */
const UNNAMED_APP = 'Paired app';

/** A setup URL just made. */
export interface StartedPairing extends Pairing {
  /** What the operator pastes into the app. */
  setupUrl: string;
}

/**
 * Builds the URL an app pairs with: the issuer, with the initial access token and the provider's name in the
 * fragment, so neither reaches a server log.
 *
 * @param issuer - The provider's issuer.
 * @param token - The initial access token.
 * @param name - The provider's branded name.
 * @returns The setup URL.
 */
export function setupUrlFor(issuer: string, token: string, name: string): string {
  const fragment = new URLSearchParams({ [SETUP_URL_TOKEN]: token, [SETUP_URL_NAME]: name });
  return `${issuer}#${fragment.toString()}`;
}

/**
 * Hands out a setup URL: an initial access token that registers one client, and the pairing that says what that
 * client gets.
 *
 * @param provider - The provider as it is now.
 * @param pairings - The pairing store.
 * @param input - The groups and groups claim the paired client gets.
 * @param brandName - The provider's branded name, for the app's sign-in button.
 * @returns The pairing and its setup URL.
 */
export async function startPairing(
  provider: Provider,
  pairings: PairingStore,
  input: PairingInput,
  brandName: string,
): Promise<StartedPairing> {
  const token = await new provider.InitialAccessToken({
    expiresIn: PAIRING_DEFAULTS.linkSeconds,
    policies: [PAIRING_POLICY],
  }).save();
  const pairing = pairings.start(token, input);
  return { ...pairing, setupUrl: setupUrlFor(provider.issuer, token, brandName) };
}

/**
 * Reads the host of a URI.
 *
 * @param uri - Any URI.
 * @returns Its host, or null when it has none.
 */
function hostOf(uri: string | undefined): string | null {
  const host = uri !== undefined && URL.canParse(uri) ? new URL(uri).host : '';
  return host === '' ? null : host;
}

/**
 * Says whether a registered auth method is one the client store holds.
 *
 * @param value - The `token_endpoint_auth_method`.
 * @returns True for the secret in a header or the body, or none.
 */
function isClientAuthMethod(value: string): value is ClientAuthMethod {
  return Object.values<string>(ClientAuthMethod).includes(value);
}

/**
 * Refuses grant and response types the provider does not serve.
 *
 * @param metadata - What the app registered.
 * @throws InvalidClientMetadata naming what is not supported.
 */
function checkFlows(metadata: ClientMetadata): void {
  const grantType = (metadata.grant_types ?? DEFAULT_GRANT_TYPES).find(
    (type) => PAIRED_GRANT_TYPES.has(type) === false,
  );
  if (grantType !== undefined) {
    throw new errors.InvalidClientMetadata(`grant type "${grantType}" is not supported`);
  }
  const responseType = (metadata.response_types ?? [CODE]).find((type) => type !== CODE);
  if (responseType !== undefined) {
    throw new errors.InvalidClientMetadata(`response type "${responseType}" is not supported`);
  }
}

/**
 * Reads the client store's fields from registered metadata.
 *
 * @param metadata - What the app registered.
 * @returns The fields. The groups are the pairing's, so they are left out.
 * @throws InvalidClientMetadata for an auth method, grant type or response type the provider does not serve.
 */
export function clientFieldsFrom(metadata: ClientMetadata): ClientFields {
  checkFlows(metadata);
  const authMethod = metadata.token_endpoint_auth_method ?? ClientAuthMethod.SecretBasic;
  if (isClientAuthMethod(authMethod) === false) {
    throw new errors.InvalidClientMetadata(`token_endpoint_auth_method "${authMethod}" is not supported`);
  }
  const redirectUris = [...(metadata.redirect_uris ?? [])];
  const grantTypes = metadata.grant_types ?? DEFAULT_GRANT_TYPES;
  return {
    name: metadata.client_name ?? hostOf(redirectUris[0]) ?? UNNAMED_APP,
    authMethod,
    redirectUris,
    postLogoutRedirectUris: [...(metadata.post_logout_redirect_uris ?? [])],
    allowClientCredentials: grantTypes.includes(CLIENT_CREDENTIALS),
    logoUri: metadata.logo_uri ?? null,
  };
}

/**
 * Writes a client through the store, turning the store's refusal into the registration error RFC 7591 names.
 *
 * @param write - Creates or updates the client.
 * @returns The client as stored.
 * @throws InvalidClientMetadata with the store's reason.
 */
function stored(write: () => OidcClient): OidcClient {
  try {
    return write();
  } catch (error) {
    throw new errors.InvalidClientMetadata(errorMessage(error));
  }
}

/** What the pairing policy reads and writes. */
export interface PairingPolicyDeps {
  clients: ClientStore;
  pairings: PairingStore;
  settings: SettingsStore;
}

/**
 * Builds the registration policy for setup URLs. On a registration it finds the pairing the initial access token
 * belongs to, writes the client to the store with the pairing's groups, marks the pairing done and spends the
 * token. On an RFC 7592 update it writes the new metadata over the client. Either way the secret in the response is
 * the store's.
 *
 * @param deps - The client, pairing and settings stores.
 * @returns The policy, for `features.registration.policies`.
 */
export function createPairingPolicy(
  deps: PairingPolicyDeps,
): (ctx: KoaContextWithOIDC, metadata: ClientMetadata) => Promise<void> {
  return async (ctx, metadata) => {
    const fields = clientFieldsFrom(metadata);
    // The client store checks this too, but RFC 7591 names its own error for a redirect URI.
    const redirect = redirectProblem(fields, {
      allowsHttp: deps.settings.httpRedirects().isAllowed,
      isPublic: fields.authMethod === ClientAuthMethod.None,
    });
    if (redirect !== null) {
      const refused = new errors.InvalidRedirectUri();
      // Its own description is about authorization requests, so say what is wrong with the registration instead.
      refused.error_description = redirect.message;
      throw refused;
    }
    // The provider checks the metadata again once the policy returns, but by then the token would be spent.
    await ctx.oidc.provider.Client.validate(metadata);
    const initialToken = ctx.oidc.entities.InitialAccessToken;
    let client: OidcClient;
    if (initialToken === undefined) {
      client = stored(() => deps.clients.update(metadata.client_id, fields));
    } else {
      const pairing = deps.pairings.waitingFor(initialToken.jti);
      if (pairing === null) {
        throw new errors.InvalidToken('the setup URL has expired, been used or been cancelled');
      }
      const { allowedGroups, groupsClaim } = pairing;
      client = stored(() =>
        deps.clients.create({
          ...fields,
          clientId: metadata.client_id,
          allowedGroups,
          groupsClaim,
          source: CLIENT_SOURCE_PAIRED,
        }),
      );
      deps.pairings.complete(pairing.id, client.clientId);
      await initialToken.destroy();
    }
    if (client.clientSecret === null) {
      delete metadata.client_secret;
    } else {
      metadata.client_secret = client.clientSecret;
    }
  };
}
