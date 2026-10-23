import sharp from 'sharp';
import { PROFILE_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { createFakeS3, type FakeS3 } from '../fake-s3.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import {
  adminGql,
  type Browser,
  createBrowser,
  PASSWORD,
  payloadOf,
  REDIRECT_URI,
  signIn,
  signInAsAdmin,
  signInForTokens,
} from '../oidc/browser.ts';

/**
 * Makes a test image.
 *
 * @param background - Its colour, so two pictures differ.
 * @param [format] - What to encode it as.
 * @returns Its bytes.
 */
function image(background: string, format: 'png' | 'jpeg' | 'gif' = 'png'): Promise<Buffer> {
  return sharp({ create: { width: 400, height: 300, channels: 3, background } })
    .toFormat(format)
    .toBuffer();
}

/**
 * Signs a user in to the web app, the way the account page does.
 *
 * @param app - The running app.
 * @param username - Who signs in.
 * @returns The browser, holding the session cookie.
 */
async function signInToWebApp(app: TestApp, username: string): Promise<Browser> {
  const browser = createBrowser(app.base);
  const callback = await signIn(app, '/admin/login', username, PASSWORD, browser, `${app.base}/admin/callback`);
  await browser.send(callback.pathname + callback.search);
  return browser;
}

/**
 * Uploads a picture the way the web app does.
 *
 * @param browser - The browser.
 * @param url - The route.
 * @param body - The image.
 * @param [type] - Its `Content-Type`.
 * @returns The status and parsed body.
 */
async function upload(browser: Browser, url: string, body: Buffer, type = 'image/png') {
  const res = await browser.send(url, {
    method: 'POST',
    headers: { 'content-type': type },
    body: new Uint8Array(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Posts JSON the way the web app does.
 *
 * @param browser - The browser.
 * @param url - The route.
 * @returns The status and parsed body.
 */
async function postEmpty(browser: Browser, url: string) {
  const res = await browser.send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: res.status, body: await res.json() };
}

/**
 * Lists the types of the audit entries so far, oldest first.
 *
 * @param app - The running app.
 * @returns The types.
 */
async function auditTypes(app: TestApp): Promise<string[]> {
  const { entries } = await app.services.audit.list({ first: 100 });
  return entries.map((entry) => entry.type).reverse();
}

describe('profile pictures', () => {
  let app: TestApp;
  let s3: FakeS3;
  let adaId: string;

  beforeEach(async () => {
    s3 = createFakeS3();
    app = await startTestApp({ objectStorage: s3.storage });
    await signInAsAdmin(app);
    const ada = await app.services.users.create({
      username: 'ada',
      password: PASSWORD,
      email: 'ada@example.home',
      name: 'Ada',
      groups: [],
    });
    adaId = ada.id;
  });

  afterEach(() => app.close());

  it('lets a user set theirs, and serves it from the bucket with cache headers', async () => {
    const browser = await signInToWebApp(app, 'ada');
    expect(await (await browser.send('/admin/account/picture')).json()).toEqual({
      isEnabled: true,
      maxBytes: PROFILE_DEFAULTS.maxPictureBytes,
      url: null,
    });
    const set = await upload(browser, '/admin/account/picture', await image('#cc3333', 'jpeg'), 'image/jpeg');
    expect(set.status).toBe(HttpStatus.Ok);
    const url = new URL(set.body.url);
    expect(url.origin + url.pathname).toBe(`${app.base}/users/${adaId}/picture`);
    expect(url.searchParams.get('v')).toMatch(/^[0-9a-f]{16}$/);
    expect([...s3.objects.keys()]).toEqual([`pictures/${adaId}/${url.searchParams.get('v')}`]);
    expect(await auditTypes(app)).toContain(AuditType.PictureSet);

    // Anyone may fetch it, signed in or not: apps show it.
    const res = await fetch(url);
    expect(res.status).toBe(HttpStatus.Ok);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(
      `public, max-age=${PROFILE_DEFAULTS.versionedCacheSeconds}, immutable`,
    );
    const etag = res.headers.get('etag');
    expect(etag).toBe(`"${url.searchParams.get('v')}"`);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: 'png',
      width: PROFILE_DEFAULTS.pictureSidePx,
      height: PROFILE_DEFAULTS.pictureSidePx,
    });

    const fetchesBefore = s3.requests.length;
    const again = await fetch(url, { headers: { 'if-none-match': etag ?? '' } });
    expect(again.status).toBe(HttpStatus.NotModified);
    expect(s3.requests.length).toBe(fetchesBefore);

    const unversioned = await fetch(`${app.base}/users/${adaId}/picture`);
    expect(unversioned.headers.get('cache-control')).toBe(
      `public, max-age=${PROFILE_DEFAULTS.unversionedCacheSeconds}`,
    );
  });

  it('refuses what is not a PNG, JPEG or WebP image', async () => {
    const browser = await signInToWebApp(app, 'ada');
    const gif = await upload(browser, '/admin/account/picture', await image('#000000', 'gif'), 'image/gif');
    expect(gif.status).toBe(HttpStatus.BadRequest);
    expect(gif.body.error).toContain('PNG, JPEG or WebP');
    const fakePng = Buffer.concat([(await image('#000000')).subarray(0, 8), Buffer.from('not an image')]);
    const fake = await upload(browser, '/admin/account/picture', fakePng);
    expect(fake.body.error).toContain('not a readable image');
    const text = await upload(browser, '/admin/account/picture', Buffer.from('hello'), 'text/plain');
    expect(text.status).toBe(HttpStatus.UnsupportedMediaType);
    const big = Buffer.concat([await image('#000000'), Buffer.alloc(PROFILE_DEFAULTS.maxPictureBytes)]);
    const tooLarge = await upload(browser, '/admin/account/picture', big);
    expect(tooLarge.status).toBe(HttpStatus.PayloadTooLarge);
    expect(s3.objects.size).toBe(0);
    expect(app.services.users.find(adaId)?.pictureVersion).toBeNull();
  });

  it('releases the picture claim with the profile scope', async () => {
    const browser = await signInToWebApp(app, 'ada');
    const { body } = await upload(browser, '/admin/account/picture', await image('#33cc33'));
    const client = await app.services.clients.create({
      name: 'Gallery',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [],
    });
    const tokens = await signInForTokens(app, client, 'ada', 'openid profile');
    expect(payloadOf(tokens.id_token).picture).toBe(body.url);
    const userinfo = await fetch(`${app.services.issuer}/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect((await userinfo.json()).picture).toBe(body.url);
    const withoutProfile = await signInForTokens(app, client, 'ada', 'openid email');
    expect(payloadOf(withoutProfile.id_token).picture).toBeUndefined();
  });

  it('replaces and removes a picture, deleting it from the bucket', async () => {
    const browser = await signInToWebApp(app, 'ada');
    const first = await upload(browser, '/admin/account/picture', await image('#111111'));
    const second = await upload(browser, '/admin/account/picture', await image('#eeeeee'));
    expect(second.body.url).not.toBe(first.body.url);
    expect(s3.objects.size).toBe(1);
    const removed = await postEmpty(browser, '/admin/account/picture/remove');
    expect(removed).toEqual({ status: HttpStatus.Ok, body: { url: null } });
    expect(s3.objects.size).toBe(0);
    expect((await fetch(second.body.url)).status).toBe(HttpStatus.NotFound);
    expect((await auditTypes(app)).filter((type) => type.startsWith('picture_'))).toEqual([
      AuditType.PictureSet,
      AuditType.PictureSet,
      AuditType.PictureRemoved,
    ]);
  });

  it('lets an admin set and remove a user’s picture, and only an admin', async () => {
    const admin = await signInAsAdmin(app);
    const set = await upload(admin, `/admin/users/${adaId}/picture`, await image('#336699'));
    expect(set.status).toBe(HttpStatus.Ok);
    const listed = await adminGql(admin, `{ users { username pictureUrl } profilePictures { isEnabled maxBytes } }`);
    expect(listed.data.users).toContainEqual({ username: 'ada', pictureUrl: set.body.url });
    expect(listed.data.profilePictures).toEqual({ isEnabled: true, maxBytes: PROFILE_DEFAULTS.maxPictureBytes });
    const [entry] = (await app.services.audit.list({ first: 1 })).entries;
    expect(entry).toMatchObject({ type: AuditType.PictureSet, actor: { username: 'root' }, target: { id: adaId } });

    const ada = await signInToWebApp(app, 'ada');
    const refused = await upload(ada, `/admin/users/${adaId}/picture`, await image('#000000'));
    expect(refused.status).toBe(HttpStatus.Forbidden);

    expect((await postEmpty(admin, `/admin/users/${adaId}/picture/remove`)).status).toBe(HttpStatus.Ok);
    expect(s3.objects.size).toBe(0);
  });

  it('deletes the picture with the user', async () => {
    const browser = await signInToWebApp(app, 'ada');
    await upload(browser, '/admin/account/picture', await image('#999999'));
    expect(s3.objects.size).toBe(1);
    const admin = await signInAsAdmin(app);
    const deleted = await adminGql(admin, 'mutation ($id: ID!) { deleteUser(id: $id) { id } }', { id: adaId });
    expect(deleted.errors).toBeUndefined();
    expect(s3.objects.size).toBe(0);
  });

  it('answers 502 when the bucket is down, and keeps the old picture', async () => {
    const browser = await signInToWebApp(app, 'ada');
    const first = await upload(browser, '/admin/account/picture', await image('#123456'));
    s3.setDown(true);
    const failed = await upload(browser, '/admin/account/picture', await image('#654321'));
    expect(failed.status).toBe(HttpStatus.BadGateway);
    expect((await fetch(`${app.base}/users/${adaId}/picture`)).status).toBe(HttpStatus.BadGateway);
    s3.setDown(false);
    expect((await fetch(first.body.url)).status).toBe(HttpStatus.Ok);
  });
});

describe('profile pictures without a bucket', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp();
  });

  afterEach(() => app.close());

  it('are off, and the account page and admin UI are told', async () => {
    const admin = await signInAsAdmin(app);
    expect(await (await admin.send('/admin/account/picture')).json()).toMatchObject({ isEnabled: false, url: null });
    const refused = await upload(admin, '/admin/account/picture', await image('#000000'));
    expect(refused.status).toBe(HttpStatus.BadRequest);
    expect(refused.body.error).toContain('off');
    const listed = await adminGql(admin, '{ profilePictures { isEnabled } }');
    expect(listed.data.profilePictures.isEnabled).toBe(false);
  });
});
