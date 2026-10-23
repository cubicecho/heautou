import { allowedReturn } from '../../server/forward-auth/returns.ts';

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
