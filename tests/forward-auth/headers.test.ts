import { originalRequestOf } from '../../server/forward-auth/request.ts';
import { allowedReturn } from '../../server/forward-auth/returns.ts';
import { createProxyTrust } from '../../server/forward-auth/trust.ts';

/**
 * Reads headers from a plain object, as `req.get` does.
 *
 * @param headers - The headers, by lowercase name.
 * @returns The reader.
 */
const reader = (headers: Record<string, string>) => (name: string) => headers[name];

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

describe('original request', () => {
  it('reads the forwarded headers, defaulting to https and GET', () => {
    const { request } = originalRequestOf(
      reader({ 'x-forwarded-host': 'App.home.lan:8443', 'x-forwarded-uri': '/a?b=1' }),
    );
    expect(request?.url.href).toBe('https://app.home.lan:8443/a?b=1');
    expect(request?.method).toBe('GET');
  });

  it('takes the forwarded method, and X-Original-URL alone', () => {
    const { request } = originalRequestOf(
      reader({ 'x-original-url': 'http://app.home.lan/x', 'x-forwarded-method': 'post' }),
    );
    expect(request?.url.href).toBe('http://app.home.lan/x');
    expect(request?.method).toBe('POST');
  });
});

describe('return address', () => {
  const rule = { sites: [{ host: 'app.home.lan' }], cookieDomain: 'home.lan' };

  it('allows a site host or a host under the cookie domain', () => {
    expect(allowedReturn('https://app.home.lan/x', rule)?.href).toBe('https://app.home.lan/x');
    expect(allowedReturn('http://wiki.home.lan/', rule)).not.toBeNull();
    expect(allowedReturn('https://home.lan/', rule)).not.toBeNull();
  });

  it('refuses another host, a look-alike, credentials and other schemes', () => {
    expect(allowedReturn('https://evil.example/', rule)).toBeNull();
    expect(allowedReturn('https://evilhome.lan/', rule)).toBeNull();
    expect(allowedReturn('https://app.home.lan.evil.example/', rule)).toBeNull();
    expect(allowedReturn('https://a:b@app.home.lan/', rule)).toBeNull();
    expect(allowedReturn('ftp://app.home.lan/', rule)).toBeNull();
    expect(allowedReturn('/relative', rule)).toBeNull();
    expect(allowedReturn('https://wiki.home.lan/', { ...rule, cookieDomain: null })).toBeNull();
  });
});
