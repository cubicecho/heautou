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
import { clientMetadata, DEVICE_CODE_GRANT } from './adapter.ts';

/** The registration policy every setup URL's initial access token carries. */
export const PAIRING_POLICY = 'heautou-pairing';
/** The fragment key the setup URL carries the initial access token under. */
export const SETUP_URL_TOKEN = 'setup';
/** The fragment key the setup URL carries the provider's name under, for the app's sign-in button. */
export const SETUP_URL_NAME = 'name';

const AUTHORIZATION_CODE = 'authorization_code';
const REFRESH_TOKEN = 'refresh_token';
const CLIENT_CREDENTIALS = 'client_credentials';
/** The grant types a paired client may register. The device flow waits for the operator to turn it on. */
const PAIRED_GRANT_TYPES: ReadonlySet<string> = new Set([
  AUTHORIZATION_CODE,
  REFRESH_TOKEN,
  CLIENT_CREDENTIALS,
  DEVICE_CODE_GRANT,
]);
/** The grant types a device client registers: the device flow, and a refresh token to stay signed in with. */
const DEVICE_CLIENT_GRANT_TYPES: ReadonlySet<string> = new Set([DEVICE_CODE_GRANT, REFRESH_TOKEN]);
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
    backchannelLogoutUri: metadata.backchannel_logout_uri ?? null,
    // RFC 7591 metadata leaves it false unless the app asks; the store's own default is for the operator.
    backchannelLogoutSessionRequired: metadata.backchannel_logout_session_required ?? false,
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
 * Says whether a registration asks for the device flow.
 *
 * @param metadata - What the app registered.
 * @returns True when its grant types include the device code grant.
 */
function asksForDeviceFlow(metadata: ClientMetadata): boolean {
  return (metadata.grant_types ?? DEFAULT_GRANT_TYPES).includes(DEVICE_CODE_GRANT);
}

/**
 * Says whether a registration is a device client: public, with no redirect URI, asking for the device flow and
 * nothing besides a refresh token.
 *
 * @param metadata - What the app registered.
 * @param fields - The store's fields read from it.
 * @returns True for a device client.
 */
function isDeviceClient(metadata: ClientMetadata, fields: ClientFields): boolean {
  const grantTypes = metadata.grant_types ?? DEFAULT_GRANT_TYPES;
  return (
    fields.authMethod === ClientAuthMethod.None &&
    fields.redirectUris.length === 0 &&
    asksForDeviceFlow(metadata) &&
    grantTypes.every((type) => DEVICE_CLIENT_GRANT_TYPES.has(type))
  );
}

/**
 * Reads the `client_uri` an app registered with, when it is a web address.
 *
 * @param metadata - What the app registered.
 * @returns The URI, or null.
 */
function clientUriOf(metadata: ClientMetadata): string | null {
  const uri = metadata.client_uri;
  if (typeof uri !== 'string' || URL.canParse(uri) === false) {
    return null;
  }
  const { protocol } = new URL(uri);
  return protocol === 'https:' || protocol === 'http:' ? uri : null;
}

/**
 * Registers a client with a setup URL's token. The first registration is the app's client: it gets the pairing's
 * groups and pairs it, and the token keeps working for one more registration, a device client (public, no redirect
 * URI, the device flow). That one gets the same groups, and the token is spent. Any other registration is refused as
 * a used setup URL. A client that asks for the device flow does not get it until the operator turns it on when they
 * finish the pairing.
 *
 * @param deps - The client and pairing stores.
 * @param initialToken - The token the app sent.
 * @param metadata - What the app registered.
 * @param fields - The store's fields read from it.
 * @returns The client as stored.
 * @throws InvalidToken when the setup URL has no registration left.
 */
async function registerWith(
  deps: PairingPolicyDeps,
  initialToken: { jti: string; destroy: () => Promise<void> },
  metadata: ClientMetadata,
  fields: ClientFields,
): Promise<OidcClient> {
  const first = deps.pairings.waitingFor(initialToken.jti);
  const second =
    first === null && isDeviceClient(metadata, fields) ? deps.pairings.waitingForDevice(initialToken.jti) : null;
  const pairing = first ?? second;
  if (pairing === null) {
    throw new errors.InvalidToken('the setup URL has expired, been used or been cancelled');
  }
  const { allowedGroups, groupsClaim } = pairing;
  const client = stored(() =>
    deps.clients.create({
      ...fields,
      clientId: metadata.client_id,
      allowedGroups,
      groupsClaim,
      allowDeviceFlow: false,
      source: CLIENT_SOURCE_PAIRED,
    }),
  );
  if (first !== null) {
    deps.pairings.complete(pairing.id, client.clientId, clientUriOf(metadata));
  }
  if (asksForDeviceFlow(metadata)) {
    deps.pairings.addDeviceClient(pairing.id, client.clientId);
  }
  if (second !== null) {
    await initialToken.destroy();
  }
  return client;
}

/**
 * Makes the registration response say only what the client was given: of the grant types asked for, those the store
 * grants. A device client waiting for the operator is answered with none, and sees the device flow in an RFC 7592
 * read once it is turned on.
 *
 * @param metadata - What the app registered, which the provider answers with.
 * @param client - The client as stored.
 */
function answerGranted(metadata: ClientMetadata, client: OidcClient): void {
  const granted = new Set(clientMetadata(client).grant_types);
  const grantTypes = (metadata.grant_types ?? DEFAULT_GRANT_TYPES).filter((type) => granted.has(type));
  metadata.grant_types = grantTypes;
  if (grantTypes.includes(AUTHORIZATION_CODE) === false) {
    metadata.response_types = [];
  }
}

/**
 * Builds the registration policy for setup URLs. On a registration it finds the pairing the initial access token
 * belongs to and writes the client to the store with the pairing's groups (`registerWith`). On an RFC 7592 update it
 * writes the new metadata over the client. Either way the response names only the grant types the client has, and
 * the secret in it is the store's.
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
    const client =
      initialToken === undefined
        ? stored(() => deps.clients.update(metadata.client_id, fields))
        : await registerWith(deps, initialToken, metadata, fields);
    answerGranted(metadata, client);
    if (client.clientSecret === null) {
      delete metadata.client_secret;
    } else {
      metadata.client_secret = client.clientSecret;
    }
  };
}
