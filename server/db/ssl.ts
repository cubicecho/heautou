/** Host names that never leave the local network. */
const PRIVATE_SUFFIXES = ['.lan', '.local', '.internal', '.home.arpa'];
/** IPv4 addresses on the machine or the local network: loopback, RFC 1918 and link-local. */
const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
/** IPv6 loopback, unique local (fc00::/7) and link-local (fe80::/10). */
const PRIVATE_IPV6 = /^(::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/;

/**
 * Says whether a Postgres URL needs TLS forced on. A self-hosted Postgres on the same machine or network needs no
 * certificate; one across the internet does.
 *
 * @param url - The connection URL.
 * @returns False for a URL that sets `sslmode` itself, and for a host on the machine or the local network.
 */
export function requiresSsl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.searchParams.has('sslmode')) {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isDotless = host.includes('.') === false && host.includes(':') === false;
  const isLocal =
    host === 'localhost' ||
    isDotless ||
    PRIVATE_IPV4.test(host) ||
    PRIVATE_IPV6.test(host) ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return isLocal === false;
}
