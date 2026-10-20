import { z } from 'zod';
import { API_DEFAULTS, PAIRING_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import { identifierProblem, SCOPE_TOKEN } from '../store/apis.ts';

// What a paired app offers to set up besides its sign-in, for the operator to turn on or leave off when they finish
// the pairing. Its device client is one it registered with the setup URL (pairing.ts). Its API is read from its
// protected resource metadata (RFC 9728), looked for under the `client_uri` it registered with.
//
// RFC 7591 makes `client_uri` a page about the app for people to read, not the address of its metadata, so this is a
// guess heautou makes. Nothing there, or nothing usable, means nothing is offered; it never fails a pairing. The
// address is the app's own say, so it is only fetched on the host of a redirect URI heautou has already accepted,
// redirects are not followed, and what comes back is only offered when it names this provider.

/** The well-known path RFC 9728 puts protected resource metadata under. */
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

/** An API a paired app describes, for the operator to add. */
export interface OfferedApi {
  /** The resource indicator, and the `aud` of its tokens. */
  identifier: string;
  /** What the app calls it, or its host when it gives no name. */
  name: string;
  /** The scopes it lists that an API here may have. */
  scopes: string[];
}

/** The part of RFC 9728 metadata heautou reads. */
const metadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).optional(),
  resource_name: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
});

/** What the lookup needs. */
export interface ApiLookup {
  /** The `client_uri` the app registered with. */
  clientUri: string;
  /** The redirect URIs heautou accepted for the app's client. */
  redirectUris: readonly string[];
  /** This provider's issuer, which the metadata must name. */
  issuer: string;
  /** The provider's own scopes, which an API may not list. */
  reservedScopes: readonly string[];
  /** Makes the request. */
  fetch: typeof globalThis.fetch;
}

/**
 * Builds the address RFC 9728 gives the metadata of a resource: the well-known path between the host and the path.
 *
 * @param uri - The resource, here the app's `client_uri`.
 * @returns The metadata's address.
 */
export function metadataUrlFor(uri: string): string {
  const url = new URL(uri);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${WELL_KNOWN}${path}`;
}

/**
 * Reads a response body up to a size, as text.
 *
 * @param response - The response.
 * @param maxBytes - The most to read.
 * @returns The body, or null when it is larger.
 */
async function boundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Turns the metadata into an API to offer, when it is one heautou can add.
 *
 * @param body - The metadata.
 * @param lookup - The app's address, and this provider.
 * @returns The API, or null.
 */
function offerFrom(body: unknown, lookup: ApiLookup): OfferedApi | null {
  const parsed = metadataSchema.safeParse(body);
  if (parsed.success === false) {
    return null;
  }
  const {
    resource,
    authorization_servers: servers = [],
    resource_name: name,
    scopes_supported: scopes = [],
  } = parsed.data;
  const namesThisProvider = servers.some((server) => server.replace(/\/+$/, '') === lookup.issuer);
  if (namesThisProvider === false || identifierProblem(resource) !== null) {
    return null;
  }
  // An app may only describe an API of its own.
  if (new URL(resource).host !== new URL(lookup.clientUri).host) {
    return null;
  }
  const usable = scopes.filter((scope) => SCOPE_TOKEN.test(scope) && lookup.reservedScopes.includes(scope) === false);
  const trimmed = name?.trim() ?? '';
  return {
    identifier: resource,
    name: (trimmed === '' ? new URL(resource).host : trimmed).slice(0, API_DEFAULTS.maxNameLength),
    scopes: [...new Set(usable)].slice(0, API_DEFAULTS.maxScopes),
  };
}

/**
 * Looks for the API a paired app describes in its protected resource metadata.
 *
 * @param lookup - The app's address and redirect URIs, this provider, and how to fetch.
 * @returns The API to offer, or null when there is none heautou can use, for whatever reason.
 */
export async function findOfferedApi(lookup: ApiLookup): Promise<OfferedApi | null> {
  const appHost = new URL(lookup.clientUri).host;
  const isOnRedirectHost = lookup.redirectUris.some((uri) => URL.canParse(uri) && new URL(uri).host === appHost);
  if (isOnRedirectHost === false) {
    return null;
  }
  try {
    const response = await lookup.fetch(metadataUrlFor(lookup.clientUri), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PAIRING_DEFAULTS.discoveryTimeoutMs),
    });
    if (response.ok === false) {
      return null;
    }
    const text = await boundedText(response, PAIRING_DEFAULTS.maxDiscoveryBytes);
    return text === null ? null : offerFrom(JSON.parse(text), lookup);
  } catch {
    return null;
  }
}

/** Looks up what paired apps offer, once per pairing. */
export interface PairingOffers {
  /**
   * The API a pairing's app describes.
   *
   * @param pairingId - The pairing.
   * @param clientUri - The `client_uri` its app registered with, or null for none.
   * @param redirectUris - The redirect URIs heautou accepted for its client.
   * @returns The API, or null.
   */
  apiFor: (pairingId: string, clientUri: string | null, redirectUris: readonly string[]) => Promise<OfferedApi | null>;
}

/** The most lookups kept; pairings last half an hour, so this is only a bound. */
const MAX_REMEMBERED = 100;

/** One pairing's lookup: under way or answered, and until when an empty answer is believed. */
interface Remembered {
  found: Promise<OfferedApi | null>;
  /** In epoch milliseconds. Null while under way, and for an API found, which is kept. */
  retryAfter: number | null;
}

/**
 * Builds the lookup. An API found is remembered for the pairing, so the admin UI reading it again does not fetch
 * again. Finding none is believed only for `PAIRING_DEFAULTS.discoveryRetrySeconds`: the app is often still pairing
 * when heautou first looks (it registers, then starts using this provider), and its metadata names this provider
 * only after that.
 *
 * @param options - This provider, its own scopes, how to fetch, and the clock.
 * @param options.issuer - The issuer the metadata must name.
 * @param options.reservedScopes - The provider's own scopes.
 * @param options.fetch - Makes the requests.
 * @param [options.now] - The clock, in epoch milliseconds.
 * @returns The lookup.
 */
export function createPairingOffers(options: {
  issuer: string;
  reservedScopes: readonly string[];
  fetch: typeof globalThis.fetch;
  now?: () => number;
}): PairingOffers {
  const { now = Date.now, ...lookup } = options;
  const remembered = new Map<string, Remembered>();
  return {
    apiFor: (pairingId, clientUri, redirectUris) => {
      if (clientUri === null) {
        return Promise.resolve(null);
      }
      const known = remembered.get(pairingId);
      const isStale = known?.retryAfter !== null && known?.retryAfter !== undefined && known.retryAfter <= now();
      if (known !== undefined && isStale === false) {
        return known.found;
      }
      remembered.delete(pairingId);
      if (remembered.size >= MAX_REMEMBERED) {
        const oldest = remembered.keys().next().value;
        if (oldest !== undefined) {
          remembered.delete(oldest);
        }
      }
      const entry: Remembered = { found: findOfferedApi({ ...lookup, clientUri, redirectUris }), retryAfter: null };
      remembered.set(pairingId, entry);
      void entry.found.then((api) => {
        if (api === null) {
          entry.retryAfter = now() + PAIRING_DEFAULTS.discoveryRetrySeconds * MS_PER_SECOND;
        }
      });
      return entry.found;
    },
  };
}
