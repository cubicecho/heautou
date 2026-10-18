import type { ProtectedSite } from '../store/protected-sites.ts';

const SCHEMES = new Set(['http:', 'https:']);

/** What a return address is checked against. */
export interface ReturnRule {
  /** The protected sites; their hosts may be returned to. */
  sites: readonly Pick<ProtectedSite, 'host'>[];
  /** The proxy cookie's domain; any host under it may be returned to. Null for none. */
  cookieDomain: string | null;
}

/**
 * Says whether a sign-in may send the browser to an address afterwards, so `rd` is no open redirect: an http(s)
 * URL with no credentials in it, on a protected site's host or under the cookie domain.
 *
 * @param address - The `rd` value.
 * @param rule - The sites and the cookie domain.
 * @returns The parsed URL, or null when it is refused.
 */
export function allowedReturn(address: string, rule: ReturnRule): URL | null {
  if (URL.canParse(address) === false) {
    return null;
  }
  const url = new URL(address);
  const hasCredentials = url.username !== '' || url.password !== '';
  if (SCHEMES.has(url.protocol) === false || hasCredentials) {
    return null;
  }
  const host = url.hostname;
  const isSiteHost = rule.sites.some((site) => site.host === host);
  const { cookieDomain } = rule;
  const isUnderDomain = cookieDomain !== null && (host === cookieDomain || host.endsWith(`.${cookieDomain}`));
  return isSiteHost || isUnderDomain ? url : null;
}
