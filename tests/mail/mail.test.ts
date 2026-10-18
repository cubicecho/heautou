import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_KEY_BYTES } from '../../server/core/secret-box.ts';
import { BACKUP_LAYOUT, openServices } from '../../server/core/services.ts';
import { AuditType } from '../../server/store/audit.ts';
import { BackupErrorCode, readBackup } from '../../server/store/backup.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
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

describe('email', () => {
  let app: TestApp;
  let fake: FakeTransport;
  let admin: Browser;
  let adaId: string;

  beforeEach(async () => {
    fake = createFakeTransport();
    app = await startTestApp({
      mailTransport: fake.factory,
      secretKeys: { current: randomBytes(SECRET_KEY_BYTES), previous: null },
    });
    admin = await signInAsAdmin(app);
    app.services.users.update(app.services.users.list()[0]?.id ?? '', {
      username: 'root',
      email: 'root@example.home',
      name: 'Root',
      groups: ['heautou-admin'],
    });
    adaId = app.services.users.create({
      username: 'ada',
      email: 'ada@example.home',
      name: 'Ada',
      groups: [],
    }).id;
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
    const onDisk = readFileSync(path.join(app.dataDir, 'mail.json'), 'utf8');
    expect(onDisk).not.toContain(TEST_SERVER.password);
    expect(JSON.parse(onDisk).server.password).toMatch(/^enc:v1:/);
    expect(JSON.stringify(await adminGql(admin, MAIL))).not.toContain(TEST_SERVER.password);

    // A blank password keeps the saved one.
    await adminGql(admin, SET_SERVER, { input: { ...TEST_SERVER, password: '', port: 2525 } });
    await adminGql(admin, 'mutation { sendTestEmail }');
    expect(fake.sent[0]?.server).toMatchObject({ port: 2525, password: TEST_SERVER.password });

    // Booting again with another key stops, without touching the file.
    const before = readFileSync(path.join(app.dataDir, 'mail.json'), 'utf8');
    expect(() =>
      openServices({
        dataDir: app.dataDir,
        issuer: app.services.issuer,
        isProxied: false,
        secretKeys: { current: randomBytes(SECRET_KEY_BYTES), previous: null },
      }),
    ).toThrow(/SECRET_KEY/);
    expect(readFileSync(path.join(app.dataDir, 'mail.json'), 'utf8')).toBe(before);

    const types = app.services.audit.list({}).entries.map((entry) => entry.type);
    expect(types).toContain(AuditType.MailServerSet);
    expect(JSON.stringify(app.services.audit.list({}))).not.toContain(TEST_SERVER.password);
  });

  it('keeps the SMTP password sealed in a backup, and brings it back on a restore', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const archive = app.services.backup.create({ includeSessions: false });
    expect(() => readBackup(archive, BACKUP_LAYOUT, null)).toThrow(
      expect.objectContaining({ code: BackupErrorCode.WrongKey }),
    );
    app.services.mail.removeServer();
    app.services.backup.restore(archive);
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
    const [failure, success] = app.services.audit.list({ types: [AuditType.MailFailed, AuditType.MailSent] }).entries;
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
    const log = JSON.stringify(app.services.audit.list({}));
    expect(log).not.toContain(token);
    expect(log).toContain('"kind":"invite"');

    // A failed send still hands back a link that works, with the reason.
    fake.failWith = 'mailbox unavailable';
    const failed = (await adminGql(admin, EMAIL_LINK, { id: adaId })).data.emailPasswordLink;
    expect(failed.error).toBe('mailbox unavailable');
    const second = new URLSearchParams(new URL(failed.link.url).hash.slice(1)).get('token') ?? '';
    expect(app.services.passwordLinks.find(second)).toBe(adaId);
    expect(JSON.stringify(app.services.audit.list({}))).not.toContain(second);
  });

  it('refuses a user with no address', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const bob = app.services.users.create({ username: 'bob', email: '', name: '', groups: [] });
    const refused = await adminGql(admin, EMAIL_LINK, { id: bob.id });
    expect(refused.errors[0].message).toMatch(/no email address/);
  });

  it('sends the notifications that are turned on, and only those', async () => {
    await adminGql(admin, SET_SERVER, { input: TEST_SERVER });
    const setPassword = 'mutation ($id: ID!, $p: String!) { setUserPassword(id: $id, password: $p) { id } }';
    await adminGql(admin, setPassword, { id: adaId, p: NEW_PASSWORD });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toEqual([]);

    const on = await adminGql(admin, SET_OPTIONS, { on: true });
    expect(on.data.setMailOptions).toEqual({
      notifyPasswordChanged: true,
      notifyFactorRemoved: true,
      forgotPassword: false,
    });
    await adminGql(admin, setPassword, { id: adaId, p: PASSWORD });
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]).toMatchObject({ to: 'ada@example.home', subject: 'Your Heautou password was changed' });

    await adminGql(admin, 'mutation ($id: ID!) { resetSecondFactors(id: $id) { id } }', { id: adaId });
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent[1]?.subject).toMatch(/^Every second factor .* was removed from your Heautou account$/);

    // A factor added sends nothing: that option is still off.
    app.services.audit.record({
      type: AuditType.PasskeyAdded,
      actor: { userId: adaId, username: 'ada' },
      ip: null,
      detail: { name: 'Laptop' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sent).toHaveLength(2);
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
