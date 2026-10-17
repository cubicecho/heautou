import { redirectProblem, redirectUriProblem, refusedRedirectUris } from '../../server/store/redirect-uris.ts';

const STRICT = { allowsHttp: false, isPublic: false };
const PUBLIC_STRICT = { allowsHttp: false, isPublic: true };
const LENIENT = { allowsHttp: true, isPublic: false };

describe('redirect URI rule', () => {
  it('allows https anywhere', () => {
    expect(redirectUriProblem('https://grafana.example/login/generic_oauth', STRICT)).toBeNull();
  });

  it('allows plain http only on loopback unless the operator allows it', () => {
    for (const uri of ['http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb']) {
      expect(redirectUriProblem(uri, STRICT)).toBeNull();
    }
    expect(redirectUriProblem('http://nas.lan:31001/login', STRICT)).toMatch(/plain http/);
    expect(redirectUriProblem('http://nas.lan:31001/login', LENIENT)).toBeNull();
  });

  it("allows a native app's own scheme for a public client only", () => {
    expect(redirectUriProblem('com.example.app:/callback', PUBLIC_STRICT)).toBeNull();
    expect(redirectUriProblem('com.example.app:/callback', STRICT)).toMatch(/public/);
  });

  it('refuses other schemes even when plain http is allowed', () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://host/cb']) {
      expect(redirectUriProblem(uri, { allowsHttp: true, isPublic: true })).toMatch(/scheme/);
    }
  });

  it('names the field of the first refused URI, and lists every refused one', () => {
    const fields = {
      redirectUris: ['https://app.example/cb'],
      postLogoutRedirectUris: ['http://app.example/bye', 'http://localhost/bye'],
    };
    expect(redirectProblem(fields, STRICT)?.field).toBe('postLogoutRedirectUris');
    expect(redirectProblem(fields, LENIENT)).toBeNull();
    expect(refusedRedirectUris(fields, STRICT)).toEqual(['http://app.example/bye']);
  });
});
