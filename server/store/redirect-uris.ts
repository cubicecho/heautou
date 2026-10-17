/** Hosts plain HTTP is fine on: nothing crosses a network. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const HTTPS = 'https:';
const HTTP = 'http:';

/** What a client's redirect URIs are checked against. */
export interface RedirectRule {
  /** Whether plain `http://` URIs are allowed on any host, not only loopback. */
  allowsHttp: boolean;
  /** Whether the client is public (`authMethod` none), the only kind a native app's own scheme is allowed for. */
  isPublic: boolean;
}

/** The URIs a client is sent back to, as the client store holds them. */
export interface RedirectFields {
  redirectUris: readonly string[];
  postLogoutRedirectUris: readonly string[];
}

/**
 * Says whether a scheme is a private-use one, as RFC 8252 section 7.1 has native apps use: a reversed domain name
 * such as `com.example.app`. Requiring the dot keeps out `javascript:`, `data:`, `file:` and the like.
 *
 * @param protocol - The URL's protocol, with its colon.
 * @returns True for a reversed domain name.
 */
function isPrivateUseScheme(protocol: string): boolean {
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(protocol);
}

/**
 * Checks one redirect URI against the rule: `https` anywhere, `http` on loopback or when allowed, and a native app's
 * private-use scheme for a public client.
 *
 * @param uri - An absolute URI.
 * @param rule - What is allowed.
 * @returns Why it is refused, or null when it is fine.
 */
export function redirectUriProblem(uri: string, rule: RedirectRule): string | null {
  if (URL.canParse(uri) === false) {
    return `"${uri}" is not an absolute URI`;
  }
  const url = new URL(uri);
  if (url.protocol === HTTPS) {
    return null;
  }
  if (url.protocol === HTTP) {
    const isAllowed = rule.allowsHttp || LOOPBACK_HOSTS.has(url.hostname);
    return isAllowed ? null : `"${uri}" is plain http: use https, or allow plain http redirect URIs under Settings`;
  }
  if (isPrivateUseScheme(url.protocol)) {
    return rule.isPublic ? null : `"${uri}" uses an app's own scheme, which only a public (PKCE) client may`;
  }
  return `"${uri}" uses the scheme "${url.protocol.slice(0, -1)}": use https, or a reversed domain name for a native app`;
}

/**
 * Checks every URI a client is sent back to.
 *
 * @param fields - The client's redirect and post-logout redirect URIs.
 * @param rule - What is allowed.
 * @returns The field and the reason for the first URI refused, or null when they are all fine.
 */
export function redirectProblem(
  fields: RedirectFields,
  rule: RedirectRule,
): { field: keyof RedirectFields; message: string } | null {
  for (const field of ['redirectUris', 'postLogoutRedirectUris'] as const) {
    for (const uri of fields[field]) {
      const message = redirectUriProblem(uri, rule);
      if (message !== null) {
        return { field, message };
      }
    }
  }
  return null;
}

/**
 * Lists a client's URIs that the rule refuses, for flagging clients saved before it applied.
 *
 * @param fields - The client's redirect and post-logout redirect URIs.
 * @param rule - What is allowed.
 * @returns The refused URIs, redirect URIs first.
 */
export function refusedRedirectUris(fields: RedirectFields, rule: RedirectRule): string[] {
  return [...fields.redirectUris, ...fields.postLogoutRedirectUris].filter(
    (uri) => redirectUriProblem(uri, rule) !== null,
  );
}
