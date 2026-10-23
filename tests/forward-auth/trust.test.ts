import { createProxyTrust } from '../../server/forward-auth/trust.ts';

describe('proxy trust', () => {
  it('trusts only the listed addresses and ranges when a list is set', () => {
    const trust = createProxyTrust(['10.0.0.5', '172.18.0.0/16', 'fd00::/8'], () => true);
    expect(trust('10.0.0.5')).toBe(true);
    expect(trust('172.18.3.4')).toBe(true);
    expect(trust('::ffff:172.18.3.4')).toBe(true);
    expect(trust('fd00::1')).toBe(true);
    expect(trust('127.0.0.1')).toBe(false);
    expect(trust('10.0.0.6')).toBe(false);
    expect(trust(undefined)).toBe(false);
  });

  it('falls back to loopback and TRUST_PROXY without a list', () => {
    const noProxy = createProxyTrust(null, () => false);
    expect(noProxy('127.0.0.1')).toBe(true);
    expect(noProxy('::1')).toBe(true);
    expect(noProxy('192.168.1.2')).toBe(false);
    const proxied = createProxyTrust(null, (address) => address === '192.168.1.2');
    expect(proxied('192.168.1.2')).toBe(true);
  });

  it('refuses an entry that is no address', () => {
    expect(() => createProxyTrust(['haproxy'], () => false)).toThrow(/FORWARD_AUTH_TRUSTED_PROXIES/);
    expect(() => createProxyTrust(['10.0.0.0/x'], () => false)).toThrow(/10.0.0.0\/x/);
  });
});
