import { BlockList, isIP, isIPv6 } from 'node:net';

/** Where a CIDR range's prefix length starts. */
const PREFIX_SEPARATOR = '/';
/** The `isIP` answer for an IPv6 address. */
const IP_VERSION_6 = 6;
/** Loopback addresses, which a proxy on the same machine calls from. */
const LOOPBACK = ['127.0.0.0/8', '::1/128'];

/**
 * Says whether the forward auth endpoint believes a caller's forwarded headers.
 *
 * @param address - The TCP peer's address, as `req.socket.remoteAddress` gives it.
 * @returns True for a trusted proxy.
 */
export type ProxyTrust = (address: string | undefined) => boolean;

/**
 * Adds addresses and CIDR ranges to a block list.
 *
 * @param list - The list, changed in place.
 * @param entries - Addresses such as `10.0.0.5` or ranges such as `172.18.0.0/16`.
 * @throws When an entry is neither.
 */
function addEntriesTo(list: BlockList, entries: readonly string[]): void {
  for (const entry of entries) {
    const [address = '', prefix] = entry.split(PREFIX_SEPARATOR);
    const version = isIP(address);
    const prefixLength = Number(prefix);
    const isRange = prefix !== undefined && Number.isInteger(prefixLength);
    if (version === 0 || (prefix !== undefined && isRange === false)) {
      throw new Error(
        `FORWARD_AUTH_TRUSTED_PROXIES has "${entry}". Expected addresses or CIDR ranges, comma-separated, such as 10.0.0.5,172.18.0.0/16.`,
      );
    }
    const type = version === IP_VERSION_6 ? 'ipv6' : 'ipv4';
    if (isRange) {
      list.addSubnet(address, prefixLength, type);
    } else {
      list.addAddress(address, type);
    }
  }
}

/**
 * Builds the check the verify endpoint makes before it reads `X-Forwarded-*` and `X-Original-URL`: only the proxy
 * may say which request it is asking about.
 *
 * @param trusted - `FORWARD_AUTH_TRUSTED_PROXIES`, or null to fall back to `TRUST_PROXY` and loopback.
 * @param trustsHop - Express's `trust proxy` check for the first hop, used when `trusted` is null.
 * @returns The check.
 * @throws When an entry of `trusted` is not an address or a CIDR range.
 */
export function createProxyTrust(
  trusted: readonly string[] | null,
  trustsHop: (address: string) => boolean,
): ProxyTrust {
  const list = new BlockList();
  addEntriesTo(list, trusted ?? LOOPBACK);
  return (address) => {
    if (address === undefined) {
      return false;
    }
    const isListed = list.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
    return isListed || (trusted === null && trustsHop(address));
  };
}
