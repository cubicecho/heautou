import { API_DEFAULTS } from '../../server/core/defaults.ts';
import { adminGql, signInAsAdmin } from '../browser.ts';
import { startTestApp, type TestApp } from '../helpers.ts';

describe('the APIs part of the admin API', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp();
  });

  afterAll(() => app.close());

  it('gives the bounds on an API’s own access token lifetime', async () => {
    const admin = await signInAsAdmin(app);
    const { data } = await adminGql(admin, '{ apiLifetimeBounds { minSeconds maxSeconds } }');
    expect(data.apiLifetimeBounds).toEqual({
      minSeconds: API_DEFAULTS.minAccessTokenSeconds,
      maxSeconds: API_DEFAULTS.maxAccessTokenSeconds,
    });
  });
});
