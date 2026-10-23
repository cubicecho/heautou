import { FORWARD_AUTH_DEFAULTS } from '../../server/core/defaults.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, signInAsAdmin } from '../oidc/browser.ts';

describe('the forward auth part of the admin API', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  it('gives where users sign out of the protected sites, the trusted proxies and the longest site name', async () => {
    const { data } = await adminGql(admin, '{ forwardAuth { signOutUrl trustedProxies maxNameLength } }');
    expect(data.forwardAuth).toEqual({
      signOutUrl: `${app.base}/auth/sign-out`,
      trustedProxies: null,
      maxNameLength: FORWARD_AUTH_DEFAULTS.maxNameLength,
    });
  });
});
