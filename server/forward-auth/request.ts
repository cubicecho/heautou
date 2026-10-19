import { FORWARD_AUTH_PATH } from './client.ts';

/** The headers a reverse proxy describes the original request with. */
export const FORWARDED_HEADER = {
  host: 'x-forwarded-host',
  uri: 'x-forwarded-uri',
  proto: 'x-forwarded-proto',
  method: 'x-forwarded-method',
  /** nginx's habit: the whole URL in one header. */
  originalUrl: 'x-original-url',
  originalMethod: 'x-original-method',
} as const;

/** The scheme assumed when the proxy names none. */
const DEFAULT_PROTO = 'https';
const DEFAULT_METHOD = 'GET';
const SCHEMES = new Set(['http', 'https']);
/** Separates the values a chain of proxies appended to one header. */
const LIST_SEPARATOR = ',';

/** The request the proxy is asking about. */
export interface OriginalRequest {
  /** Its absolute URL. */
  url: URL;
  /** Its method, uppercase. */
  method: string;
}

/** What the forwarded headers said: the request, or why they could not be used. */
export type OriginalRequestResult = { request: OriginalRequest; problem: null } | { request: null; problem: string };

/**
 * Builds a refusal of the forwarded headers.
 *
 * @param problem - What is wrong, for the operator.
 * @returns The result.
 */
function refused(problem: string): OriginalRequestResult {
  return { request: null, problem };
}

/**
 * Reads the original request from the headers a reverse proxy sets on its forward auth call: `X-Forwarded-Proto`,
 * `-Host` and `-Uri` (Traefik, Caddy, HAProxy), or `X-Original-URL` (nginx), and `X-Forwarded-Method`.
 *
 * @param header - Reads one request header by its lowercase name.
 * @returns The request, or the problem with the headers.
 *
 * @remarks
 * When both forms are sent they must agree, so a client header a proxy passes through cannot name another site
 * than the one the proxy set. A header with several values (a chain of proxies appending) is refused rather than
 * guessed at.
 */
export function originalRequestOf(header: (name: string) => string | undefined): OriginalRequestResult {
  const host = header(FORWARDED_HEADER.host)?.trim();
  const uri = header(FORWARDED_HEADER.uri)?.trim();
  const proto = (header(FORWARDED_HEADER.proto)?.trim() || DEFAULT_PROTO).toLowerCase();
  const originalUrl = header(FORWARDED_HEADER.originalUrl)?.trim();
  const method = (header(FORWARDED_HEADER.method) ?? header(FORWARDED_HEADER.originalMethod) ?? DEFAULT_METHOD)
    .trim()
    .toUpperCase();
  const isChained = [host, proto, method].some((value) => value?.includes(LIST_SEPARATOR) === true);
  if (isChained) {
    return refused('a forwarded header holds several values; have the proxy set it rather than append to it');
  }
  if (SCHEMES.has(proto) === false) {
    return refused(`X-Forwarded-Proto is "${proto}"; expected http or https`);
  }
  const fromForwarded =
    host !== undefined && host !== '' && uri?.startsWith('/') === true ? `${proto}://${host}${uri}` : null;
  const candidate = fromForwarded ?? originalUrl ?? null;
  if (candidate === null || URL.canParse(candidate) === false) {
    return refused(
      `send X-Forwarded-Host and X-Forwarded-Uri, or X-Original-URL, describing the request; see ${FORWARD_AUTH_PATH.verify} in docs/forward-auth.md`,
    );
  }
  const url = new URL(candidate);
  if (SCHEMES.has(url.protocol.slice(0, -1)) === false) {
    return refused(`the original URL is not http or https`);
  }
  if (fromForwarded !== null && originalUrl !== undefined) {
    const isParseable = URL.canParse(originalUrl);
    const other = isParseable ? new URL(originalUrl) : null;
    const isSame = other !== null && other.host === url.host && other.pathname === url.pathname;
    if (isSame === false) {
      return refused('X-Original-URL and X-Forwarded-Host/-Uri name different requests');
    }
  }
  return { request: { url, method }, problem: null };
}
