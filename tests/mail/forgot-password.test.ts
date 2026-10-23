import { MAIL_DEFAULTS } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AuditType } from '../../server/store/audit.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { type Browser, createBrowser, PASSWORD, postJson } from '../oidc/browser.ts';
import { createFakeTransport, type FakeTransport, TEST_SERVER, waitFor } from './fake-transport.ts';

/** More redirects than reaching the sign-in page takes. */
const MAX_HOPS = 10;

/**
 * Starts a sign-in to the web app and follows it to the sign-in page.
 *
 * @param browser - The browser.
 * @returns The interaction's uid.
 */
async function startSignIn(browser: Browser): Promise<string> {
  let next = '/admin/login';
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const uid = /^\/login\/([^/?]+)/.exec(next)?.[1];
    if (uid !== undefined) {
      return uid;
    }
    const location = (await browser.send(next)).headers.get('location') ?? '';
    next = location.replace(/^https?:\/\/[^/]+/, '');
  }
  throw new Error('The sign-in page was never reached.');
}

/**
 * Asks for a reset link the way the sign-in page does.
 *
 * @param browser - The browser, holding the interaction's cookie.
 * @param uid - The interaction.
 * @param identifier - The username or address typed.
 * @returns The status and the body.
 */
async function forgot(browser: Browser, uid: string, identifier: string) {
  const res = await postJson(browser, `/interaction/${uid}/forgot-password`, { identifier });
  return { status: res.status, body: await res.json() };
}

/**
 * Asks for one more link, for someone who gets one, and waits for its email. Requests are handled in the order they
 * came, so once it is sent every earlier request has sent whatever it was going to.
 *
 * @param browser - The browser, holding the interaction's cookie.
 * @param uid - The interaction.
 * @param fake - The transport the emails go to.
 * @param identifier - Someone the server sends a link to.
 */
async function settleWith(browser: Browser, uid: string, fake: FakeTransport, identifier: string): Promise<void> {
  const before = fake.sent.length;
  expect((await forgot(browser, uid, identifier)).status).toBe(HttpStatus.Ok);
  await waitFor(() => fake.sent.length > before);
}

describe('forgot password', () => {
  let app: TestApp;
  let fake: FakeTransport;
  let browser: Browser;
  let uid: string;

  beforeEach(async () => {
    fake = createFakeTransport();
    app = await startTestApp({ mailTransport: fake.factory });
    const { users, mail } = app.services;
    await users.create({ username: 'root', password: PASSWORD, email: '', name: '', groups: ['heautou-admin'] });
    await users.create({ username: 'ada', password: PASSWORD, email: 'Ada@Example.home', name: 'Ada', groups: [] });
    await mail.setServer(TEST_SERVER);
    await mail.setOptions({ forgotPassword: true });
    browser = createBrowser(app.base);
    uid = await startSignIn(browser);
  });

  afterEach(() => app.close());

  it('is shown only with a server and the option on', async () => {
    expect(await (await browser.send(`/interaction/${uid}/forgot-password`)).json()).toEqual({ isAvailable: true });
    await app.services.mail.setOptions({ forgotPassword: false });
    expect(await (await browser.send(`/interaction/${uid}/forgot-password`)).json()).toEqual({ isAvailable: false });
    expect((await forgot(browser, uid, 'ada')).status).toBe(HttpStatus.NotFound);
    expect(fake.sent).toEqual([]);
  });

  it('answers an unknown user exactly as a known one, and emails only the known one', async () => {
    const known = await forgot(browser, uid, 'ada');
    const unknown = await forgot(browser, uid, 'nobody@example.home');
    expect(unknown).toEqual(known);
    expect(known).toEqual({ status: HttpStatus.Ok, body: { ok: true } });
    await settleWith(browser, uid, fake, 'ada');
    expect(fake.sent.map((mail) => mail.to)).toEqual(['Ada@Example.home', 'Ada@Example.home']);
    expect(fake.sent[0]?.subject).toBe('Reset your Heautou password');
  });

  it('sends a link that sets the password and goes back to the same sign-in', async () => {
    await forgot(browser, uid, 'ada@example.home');
    await waitFor(() => fake.sent.length === 1);
    const url = /https?:\/\/\S+#\S+/.exec(fake.sent[0]?.text ?? '')?.[0] ?? '';
    const fragment = new URLSearchParams(new URL(url).hash.slice(1));
    expect(fragment.get('uid')).toBe(uid);
    const token = fragment.get('token') ?? '';
    const set = await postJson(browser, '/api/password-link/set', { token, password: 'a brand new one' });
    expect(set.status).toBe(HttpStatus.Ok);
    expect(await app.services.users.authenticate('ada', 'a brand new one')).not.toBeNull();
    // The interaction is still alive, so the page can send the browser back to it.
    expect((await browser.send(`/interaction/${uid}/details`)).status).toBe(HttpStatus.Ok);
    expect(JSON.stringify(await app.services.audit.list({}))).not.toContain(token);
  });

  it('sends nothing to a disabled user', async () => {
    const ada = app.services.users.list().find((user) => user.username === 'ada');
    await app.services.users.setDisabled(ada?.id ?? '', true);
    await app.services.users.create({ username: 'bob', email: 'bob@example.home', name: '', groups: [] });
    expect(await forgot(browser, uid, 'ada')).toEqual({ status: HttpStatus.Ok, body: { ok: true } });
    await settleWith(browser, uid, fake, 'bob');
    expect(fake.sent.map((mail) => mail.to)).toEqual(['bob@example.home']);
    const { entries } = await app.services.audit.list({ types: [AuditType.PasswordResetRequested] });
    expect(entries.find((entry) => entry.actor?.username === 'ada')?.detail).toEqual({ refused: 'disabled' });
  });

  it('is rate-limited per username or address, whether or not it exists', async () => {
    for (let i = 0; i < MAIL_DEFAULTS.forgotPerIdentifier; i += 1) {
      expect((await forgot(browser, uid, 'Nobody')).status).toBe(HttpStatus.Ok);
    }
    const limited = await forgot(browser, uid, 'nobody');
    expect(limited.status).toBe(HttpStatus.TooManyRequests);
    // Another name from the same address still goes, within the address's own limit.
    expect((await forgot(browser, uid, 'ada')).status).toBe(HttpStatus.Ok);
  });

  it('is rate-limited per address', async () => {
    for (let i = 0; i < MAIL_DEFAULTS.forgotPerIp; i += 1) {
      expect((await forgot(browser, uid, `user${i}`)).status).toBe(HttpStatus.Ok);
    }
    expect((await forgot(browser, uid, 'ada')).status).toBe(HttpStatus.TooManyRequests);
  });

  it('needs a live sign-in', async () => {
    const stranger = createBrowser(app.base);
    expect((await forgot(stranger, uid, 'ada')).status).toBe(HttpStatus.BadRequest);
  });
});
