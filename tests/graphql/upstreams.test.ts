import { ErrorCode } from '../../server/core/errors.ts';
import { AuditTargetKind, AuditType } from '../../server/store/audit.ts';
import { UpstreamKind } from '../../server/store/upstreams.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, signInAsAdmin } from '../oidc/browser.ts';

const UNLINK = `mutation ($id: ID!, $providerId: ID!) {
  unlinkUserUpstream(id: $id, providerId: $providerId) { username upstreamLinks { label } }
}`;

describe('the upstream providers part of the admin API', () => {
  let app: TestApp;
  let admin: Browser;

  beforeAll(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterAll(() => app.close());

  it('gives the redirect URI a provider will have, trimmed, before it is saved', async () => {
    const { data } = await adminGql(admin, '{ upstreamRedirectUri(id: " google ") }');
    expect(data.upstreamRedirectUri).toBe(`${app.base}/upstream/google/callback`);
  });

  it('unlinks a user’s identity at a provider and records who it was', async () => {
    await app.services.upstreams.create({
      id: 'github',
      name: 'GitHub',
      kind: UpstreamKind.GitHub,
      clientId: 'Iv1.abc',
      clientSecret: 's3cret',
    });
    const user = await app.services.users.create({ username: 'ada', email: '', name: 'Ada', groups: [] });
    await app.services.upstreams.link(
      user.id,
      { providerId: 'github', issuer: 'https://github.com', subject: '42' },
      'ada-gh',
    );

    const { data } = await adminGql(admin, UNLINK, { id: user.id, providerId: 'github' });

    expect(data.unlinkUserUpstream).toEqual({ username: 'ada', upstreamLinks: [] });
    expect(app.services.upstreams.linksOf(user.id)).toEqual([]);
    const [entry] = (await app.services.audit.list({ first: 1, types: [AuditType.UpstreamUnlinked] })).entries;
    expect(entry?.target).toEqual({ kind: AuditTargetKind.Upstream, id: 'github', name: 'GitHub' });
    expect(entry?.detail).toEqual({ identity: 'ada-gh', user: 'ada' });

    const again = await adminGql(admin, UNLINK, { id: user.id, providerId: 'github' });
    expect(again.errors[0].extensions.code).toBe(ErrorCode.NotFound);
  });

  it('refuses to unlink a user who does not exist', async () => {
    const { errors } = await adminGql(admin, UNLINK, { id: 'nobody', providerId: 'github' });
    expect(errors[0].extensions.code).toBe(ErrorCode.NotFound);
  });
});
