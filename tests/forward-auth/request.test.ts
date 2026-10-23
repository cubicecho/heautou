import { originalRequestOf } from '../../server/forward-auth/request.ts';

/**
 * Reads headers from a plain object, as `req.get` does.
 *
 * @param headers - The headers, by lowercase name.
 * @returns The reader.
 */
const reader = (headers: Record<string, string>) => (name: string) => headers[name];

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
