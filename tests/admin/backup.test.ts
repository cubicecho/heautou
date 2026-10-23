import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { BACKUP_PATH } from '../../server/admin/backup.ts';
import { SECRET_KEY_BYTES } from '../../server/core/secret-box.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, createBrowser, PASSWORD, signIn, signInAsAdmin } from '../oidc/browser.ts';

const ARCHIVE_TYPE = 'application/gzip';

/**
 * Downloads a backup the way the Settings page does.
 *
 * @param browser - A signed-in browser.
 * @param includeSessions - Whether to take the provider's sessions.
 * @returns The response.
 */
function download(browser: Browser, includeSessions = false): Promise<Response> {
  return browser.send(BACKUP_PATH.backup, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ includeSessions }),
  });
}

/**
 * Uploads an archive the way the Settings page does.
 *
 * @param browser - A browser.
 * @param archive - The bytes.
 * @param [headers] - Headers instead of the page's.
 * @returns The response.
 */
function upload(
  browser: Browser,
  archive: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return browser.send(BACKUP_PATH.restore, {
    method: 'POST',
    headers: { 'content-type': ARCHIVE_TYPE, ...headers },
    body: archive,
  });
}

describe('backup routes', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp({ secretKeys: { current: randomBytes(SECRET_KEY_BYTES), previous: null } });
  });

  afterEach(async () => {
    await app.close();
  });

  it('says whether secrets are sealed, to admins only', async () => {
    const admin = await signInAsAdmin(app);
    expect(await (await admin.send(BACKUP_PATH.backup)).json()).toEqual({ isSealed: true });
    expect((await createBrowser(app.base).send(BACKUP_PATH.backup)).status).toBe(HttpStatus.Unauthorized);
  });

  it('downloads an archive, and restores it, signing the admin out', async () => {
    const admin = await signInAsAdmin(app);
    const res = await download(admin);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(res.headers.get('content-type')).toContain(ARCHIVE_TYPE);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="heautou-backup-.+\.json\.gz"/);
    const archive = new Uint8Array(await res.arrayBuffer());
    expect(Object.keys(JSON.parse(gunzipSync(archive).toString('utf8')).files)).toContain('users.json');

    await app.services.users.create({ username: 'later', password: PASSWORD, email: '', name: '', groups: [] });
    const restored = await upload(admin, archive);
    expect(restored.status).toBe(HttpStatus.Ok);
    expect(await restored.json()).toMatchObject({ redirectTo: '/admin/login', restored: { includesSessions: false } });
    expect(restored.headers.getSetCookie().join()).toMatch(/heautou_admin=;/);

    expect(app.services.users.list().map((user) => user.username)).toEqual(['root']);
    const after = await adminGql(admin, '{ users { username } }');
    expect(after.error).toBe('Sign in to the admin UI first.');
    const [entry] = (await app.services.audit.list({ types: [AuditType.DataRestored] })).entries;
    expect(entry).toMatchObject({ actor: { username: 'root' }, detail: { via: 'web', sessions: 'left out' } });
    expect((await app.services.audit.list({ types: [AuditType.BackupDownloaded] })).entries).toHaveLength(0);

    // The provider was rebuilt on the restored data, and the admin signs in again.
    const again = await signInAsAdmin(app);
    expect((await adminGql(again, '{ users { username } }')).data.users).toEqual([{ username: 'root' }]);
  });

  it('refuses a bad archive and leaves the data as it was', async () => {
    const admin = await signInAsAdmin(app);
    const res = await upload(admin, new TextEncoder().encode('not a backup'));
    expect(res.status).toBe(HttpStatus.BadRequest);
    expect((await res.json()).error).toMatch(/not a heautou backup/);
    expect((await adminGql(admin, '{ users { username } }')).data.users).toEqual([{ username: 'root' }]);
  });

  it('takes only same-origin archive uploads from admins', async () => {
    const archive = new Uint8Array(await (await download(await signInAsAdmin(app))).arrayBuffer());
    expect((await upload(createBrowser(app.base), archive)).status).toBe(HttpStatus.Unauthorized);

    await app.services.users.create({ username: 'bob', password: PASSWORD, email: '', name: '', groups: [] });
    const user = createBrowser(app.base);
    const callback = await signIn(app, '/admin/login', 'bob', PASSWORD, user, `${app.base}/admin/callback`);
    await user.send(callback.pathname + callback.search);
    expect((await upload(user, archive)).status).toBe(HttpStatus.Forbidden);
    expect((await download(user)).status).toBe(HttpStatus.Forbidden);

    const admin = await signInAsAdmin(app);
    expect((await upload(admin, archive, { 'content-type': 'multipart/form-data' })).status).toBe(
      HttpStatus.UnsupportedMediaType,
    );
    expect((await upload(admin, archive, { origin: 'http://evil.example' })).status).toBe(HttpStatus.Forbidden);
    expect(
      app.services.users
        .list()
        .map((each) => each.username)
        .sort(),
    ).toEqual(['bob', 'root']);
  });
});
