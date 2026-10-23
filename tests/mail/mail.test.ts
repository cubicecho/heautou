import { eq } from 'drizzle-orm';
import { isSealed, SecretKeyError } from '../../server/core/secret-box.ts';
import { openServices } from '../../server/core/services.ts';
import { DOCUMENT_NAMES } from '../../server/db/documents.ts';
import { documents } from '../../server/db/schema.ts';
import { AuditType } from '../../server/store/audit.ts';
import { BACKUP_LAYOUT, BackupErrorCode, readBackup } from '../../server/store/backup.ts';
import { createTestUser, newSecretKeys, startTestApp, type TestApp } from '../helpers.ts';
import { adminGql, type Browser, PASSWORD, signInAsAdmin } from '../oidc/browser.ts';
import { createFakeTransport, type FakeTransport, TEST_SERVER, waitFor } from './fake-transport.ts';

const MAIL = `{ mail { source isConfigured server { host port secure user hasPassword from } forgotPassword
  notifyPasswordChanged notifyFactorAdded notifyFactorRemoved } }`;
const SET_SERVER = `mutation ($input: MailServerInput!) { setMailServer(input: $input) { source isConfigured
  server { host hasPassword } } }`;
const SET_OPTIONS = `mutation ($on: Boolean) { setMailOptions(notifyPasswordChanged: $on, notifyFactorRemoved: $on)
  { notifyPasswordChanged notifyFactorRemoved forgotPassword } }`;
const EMAIL_LINK = 'mutation ($id: ID!) { emailPasswordLink(id: $id) { link { url expiresAt } sentTo error } }';
const NEW_PASSWORD = 'a brand new one';

/**
 * Reads the mail settings as the database holds them.
 *
 * @param app - The running app.
 * @returns The stored document, secrets as stored.
 */
async function storedMail(app: TestApp): Promise<{ server?: { password?: string } } | undefined> {
  const [row] = await app.services.db.select().from(documents).where(eq(documents.name, DOCUMENT_NAMES.mail));
  return row?.body as { server?: { password?: string } } | undefined;
}

describe('email', () => {
  let app: TestApp;
  let fake: FakeTransport;
  let admin: Browser;
  let adaId: string;

  beforeEach(async () => {
    fake = createFakeTransport();
    app = await startTestApp({
      mailTransport: fake.factory,
      secretKeys: newSecretKeys(),
    });
    admin = await signInAsAdmin(app);
    await app.services.users.update(app.services.users.list()[0]?.id ?? '', {
      username: 'root',
      email: 'root@example.home',
      name: 'Root',
      groups: ['heautou-admin'],
    });
    const ada = await createTestUser(app, { username: 'ada', email: 'ada@example.home', name: 'Ada', password: '' });
    adaId = ada.id;
  });

  afterEach(() => app.close());

  it('is off until a server is saved, and works as today without one', async () => {
    expect((await adminGql(admin, MAIL)).data.mail).toEqual({
      source: 'NONE',
      isConfigured: false,
      server: null,
      forgotPassword: false,
      notifyPasswordChanged: false,
      notifyFactorAdded: false,
      notifyFactorRemoved: false,
    });
    const refused = await adminGql(admin, EMAIL_LINK, { id: adaId });
    expect(refused.errors[0].message).toMatch(/not set up/);
    const copied = await adminGql(admin, 'mutation ($id: ID!) { createPasswordLink(id: $id) { url } }', { id: adaId });
    expect(copied.data.createPasswordLink.url).toMatch(/#token=/);
  });

  it('seals the saved SMTP password under SECRET_KEY, and never shows it', async () => {
    const saved = await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    expect(saved.data.setMailServer).toEqual({
      source: 'SETTINGS',
      isConfigured: true,
      server: { host: TEST_SERVER.host, hasPassword: true },
    });
    await app.services.settled();
    const stored = await storedMail(app);
    expect(JSON.stringify(stored)).not.toContain(TEST_SERVER.password);
    expect(isSealed(stored?.server?.password ?? '')).toBe(true);
    expect(JSON.stringify(await adminGql(admin, MAIL))).not.toContain(TEST_SERVER.password);

    // A blank password keeps the saved one.
    await adminGql(admin, SET_SERVER, { input: { ...TEST_SERVER, password: '', port: 2525 } });
    await adminGql(admin, 'mutation { sendTestEmail }');
    expect(fake.sent[0]?.server).toMatchObject({ port: 2525, password: TEST_SERVER.password });

    // Booting again with another key stops, without touching the stored settings.
    await app.services.settled();
    const before = await storedMail(app);
    await expect(
      openServices({
        database: app.database.db,
        issuer: app.services.issuer,
        isProxied: false,
        secretKeys: newSecretKeys(),
      }),
    ).rejects.toThrow(SecretKeyError);
    expect(await storedMail(app)).toEqual(before);

    const log = await app.services.audit.list({});
    expect(log.entries.map((entry) => entry.type)).toContain(AuditType.MailServerSet);
    expect(JSON.stringify(log)).not.toContain(TEST_SERVER.password);
  });

  it('keeps the SMTP password sealed in a backup, and brings it back on a restore', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const archive = await app.services.backup.create({ includeSessions: false });
    expect(() => readBackup(archive, BACKUP_LAYOUT, null)).toThrow(
      expect.objectContaining({ code: BackupErrorCode.WrongKey }),
    );
    await app.services.mail.removeServer();
    expect(app.services.mail.status().server).toBeNull();
    await app.services.backup.restore(archive);
    expect(app.services.mail.status().server).toMatchObject({ host: TEST_SERVER.host, hasPassword: true });
  });

  it('sends a test email, and records it sent or failed with the error', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const sent = await adminGql(admin, 'mutation { sendTestEmail }');
    expect(sent.data.sendTestEmail).toBe('root@example.home');
    expect(fake.sent).toEqual([
      expect.objectContaining({ to: 'root@example.home', from: TEST_SERVER.from, subject: 'Test email from Heautou' }),
    ]);

    fake.failWith = 'connect ECONNREFUSED';
    const failed = await adminGql(admin, 'mutation ($to: String) { sendTestEmail(to: $to) }', { to: 'x@example.home' });
    expect(failed.errors[0].message).toMatch(/ECONNREFUSED/);
    const [failure, success] = (await app.services.audit.list({ types: [AuditType.MailFailed, AuditType.MailSent] }))
      .entries;
    expect(failure?.detail).toEqual({ kind: 'test', to: 'x@example.home', error: 'connect ECONNREFUSED' });
    expect(success?.detail).toEqual({ kind: 'test', to: 'root@example.home' });
  });

  it('emails an invite link that works, and keeps its token out of the audit log', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const reply = (await adminGql(admin, EMAIL_LINK, { id: adaId })).data.emailPasswordLink;
    expect(reply).toMatchObject({ sentTo: 'ada@example.home', error: null });
    const [mail] = fake.sent;
    expect(mail?.to).toBe('ada@example.home');
    expect(mail?.subject).toBe('Your Heautou account');
    expect(mail?.text).toContain(reply.link.url);
    const token = new URLSearchParams(new URL(reply.link.url).hash.slice(1)).get('token') ?? '';
    expect(app.services.passwordLinks.find(token)).toBe(adaId);
    const log = JSON.stringify(await app.services.audit.list({}));
    expect(log).not.toContain(token);
    expect(log).toContain('"kind":"invite"');

    // A failed send still hands back a link that works, with the reason.
    fake.failWith = 'mailbox unavailable';
    const failed = (await adminGql(admin, EMAIL_LINK, { id: adaId })).data.emailPasswordLink;
    expect(failed.error).toBe('mailbox unavailable');
    const second = new URLSearchParams(new URL(failed.link.url).hash.slice(1)).get('token') ?? '';
    expect(app.services.passwordLinks.find(second)).toBe(adaId);
    expect(JSON.stringify(await app.services.audit.list({}))).not.toContain(second);
  });

  it('refuses a user with no address', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const bob = await createTestUser(app, { username: 'bob', password: '' });
    const refused = await adminGql(admin, EMAIL_LINK, { id: bob.id });
    expect(refused.errors[0].message).toMatch(/no email address/);
  });

  it('sends the notifications that are turned on, and only those', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const setPassword = 'mutation ($id: ID!, $p: String!) { setUserPassword(id: $id, password: $p) { id } }';
    // Sends nothing: notices are sent in the order of their entries, so the one waited for below would follow it.
    await adminGql(admin, setPassword, { id: adaId, p: NEW_PASSWORD });

    const on = await adminGql(admin, SET_OPTIONS, { on: true });
    expect(on.data.setMailOptions).toEqual({
      notifyPasswordChanged: true,
      notifyFactorRemoved: true,
      forgotPassword: false,
    });
    await adminGql(admin, setPassword, { id: adaId, p: PASSWORD });
    await waitFor(() => fake.sent.length >= 1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ to: 'ada@example.home', subject: 'Your Heautou password was changed' });

    await adminGql(admin, 'mutation ($id: ID!) { resetSecondFactors(id: $id) { id } }', { id: adaId });
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent[1]?.subject).toMatch(/^Every second factor .* was removed from your Heautou account$/);

    // A factor added sends nothing: that option is still off. The removal after it does, and is the only one.
    const actor = { userId: adaId, username: 'ada' };
    app.services.audit.record({ type: AuditType.PasskeyAdded, actor, ip: null, detail: { name: 'Laptop' } });
    app.services.audit.record({ type: AuditType.PasskeyRemoved, actor, ip: null, detail: { name: 'Laptop' } });
    await waitFor(() => fake.sent.length >= 3);
    expect(fake.sent.slice(2).map((mail) => mail.subject)).toEqual([expect.stringMatching(/Laptop.* was removed/)]);
  });

  it('lets the environment set the server, and locks it under Settings', async () => {
    const locked = await startTestApp({
      mailTransport: fake.factory,
      mailServer: { ...TEST_SERVER, secure: false, host: 'env.example.home' },
    });
    try {
      const browser = await signInAsAdmin(locked);
      expect((await adminGql(browser, MAIL)).data.mail).toMatchObject({
        source: 'ENV',
        isConfigured: true,
        server: { host: 'env.example.home', hasPassword: true },
      });
      const refused = await adminGql(browser, SET_SERVER, { input: TEST_SERVER });
      expect(refused.errors[0].message).toMatch(/SMTP_URL or SMTP_HOST/);
      expect((await adminGql(browser, 'mutation { removeMailServer { source } }')).errors[0].message).toMatch(
        /SMTP_URL or SMTP_HOST/,
      );
    } finally {
      await locked.close();
    }
  });
});
