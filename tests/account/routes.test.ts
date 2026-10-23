import { createHash } from 'node:crypto';
import { HttpStatus } from '../../server/core/wire.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import {
  adminGql,
  type Browser,
  createBrowser,
  PASSWORD,
  postJson,
  signInAsAdmin,
  signInToWebApp,
} from '../browser.ts';
import { createTestUser, startTestApp, type TestApp } from '../helpers.ts';

/** How many hex characters of a password's SHA-1 go to Have I Been Pwned. */
const HASH_PREFIX_LENGTH = 5;
/** A one-pixel PNG. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Posts JSON the way the web app does, and reads the reply.
 *
 * @param browser - The browser.
 * @param url - The route.
 * @param body - What to send.
 * @returns The status and parsed body.
 */
async function postAndRead(browser: Browser, url: string, body: unknown) {
  const res = await postJson(browser, url, body);
  return { status: res.status, body: await res.json() };
}

describe('the account page', () => {
  let app: TestApp;
  let adaId: string;

  beforeEach(async () => {
    app = await startTestApp();
    // With no admin yet, sign-in goes to the setup page instead.
    await signInAsAdmin(app);
    const ada = await createTestUser(app, { username: 'ada', name: 'Ada', groups: ['family'] });
    adaId = ada.id;
  });

  afterEach(() => app.close());

  it('shows a signed-in user who they are and their sessions', async () => {
    const { browser, landing } = await signInToWebApp(app, 'ada');
    expect(landing).toBe('/account');
    const res = await browser.send('/api/account');
    expect(await res.json()).toMatchObject({
      username: 'ada',
      isAdmin: false,
      groups: ['family'],
      sessions: [{ clientNames: ['Heautou'] }],
    });
    await app.services.branding.setName('Home');
    expect(await (await browser.send('/api/account')).json()).toMatchObject({
      sessions: [{ clientNames: ['Home'] }],
    });
    expect((await createBrowser(app.base).send('/api/account')).status).toBe(HttpStatus.Unauthorized);
    // The routes moved from /admin/account; nothing outside the web app called them, so nothing answers there now.
    expect((await browser.send('/admin/account')).status).toBe(HttpStatus.NotFound);
  });

  it('changes the password given the current one', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    const wrong = await postAndRead(browser, '/api/account/password', {
      currentPassword: 'nope',
      newPassword: 'a brand new one',
    });
    expect(wrong.status).toBe(HttpStatus.Forbidden);
    const short = await postAndRead(browser, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'x' });
    expect(short.status).toBe(HttpStatus.BadRequest);
    const changed = await postAndRead(browser, '/api/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'a brand new one',
    });
    expect(changed.status).toBe(HttpStatus.Ok);
    expect(await app.services.users.authenticate('ada', 'a brand new one')).not.toBeNull();
  });

  it('refuses a weak new password, saying why', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    const weak = await postAndRead(browser, '/api/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'password1',
    });
    expect(weak.status).toBe(HttpStatus.BadRequest);
    expect(weak.body.error).toMatch(/too easy to guess/);
    expect(await app.services.users.authenticate('ada', PASSWORD)).not.toBeNull();
  });

  it('signs out everywhere', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    const out = await postAndRead(browser, '/api/account/sign-out-everywhere', {});
    expect(out.body.redirectTo).toBe('/admin/login?return=%2Faccount');
    expect(app.services.sessions.sessionsOf(adaId)).toEqual([]);
    expect((await browser.send('/api/account')).status).toBe(HttpStatus.Unauthorized);
  });

  it('turns away a cross-site POST', async () => {
    const { browser } = await signInToWebApp(app, 'ada');
    const res = await browser.send('/api/account/sign-out-everywhere', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).not.toBe(HttpStatus.Ok);
    expect(app.services.sessions.sessionsOf(adaId)).not.toEqual([]);
  });
});

describe('password links', () => {
  let app: TestApp;
  let admin: Browser;

  beforeEach(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterEach(() => app.close());

  it('invites a user who then sets their own password, once', async () => {
    const created = await adminGql(
      admin,
      'mutation($input: NewUserInput!) { createUser(input: $input) { id hasPassword } }',
      { input: { username: 'bob', email: '', name: '', groups: [] } },
    );
    expect(created.data.createUser.hasPassword).toBe(false);
    expect(await app.services.users.authenticate('bob', '')).toBeNull();
    const link = await adminGql(admin, 'mutation($id: ID!) { createPasswordLink(id: $id) { url expiresAt } }', {
      id: created.data.createUser.id,
    });
    const url = new URL(link.data.createPasswordLink.url);
    expect(url.origin + url.pathname).toBe(`${app.base}/set-password`);
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    const visitor = createBrowser(app.base);
    expect((await postAndRead(visitor, '/api/password-link', { token })).body).toEqual({
      username: 'bob',
      isInvite: true,
    });
    expect((await postAndRead(visitor, '/api/password-link/set', { token, password: 'x' })).status).toBe(
      HttpStatus.BadRequest,
    );
    const set = await postAndRead(visitor, '/api/password-link/set', { token, password: 'bob’s own password' });
    expect(set.body.redirectTo).toBe('/admin/login?return=%2Faccount');
    expect((await signInToWebApp(app, 'bob', 'bob’s own password')).landing).toBe('/account');
    expect((await postAndRead(visitor, '/api/password-link', { token })).status).toBe(HttpStatus.NotFound);
    expect((await postAndRead(visitor, '/api/password-link/set', { token, password: 'again and again' })).status).toBe(
      HttpStatus.NotFound,
    );
  });

  it('refuses a weak password and keeps the link for another try', async () => {
    const { id } = await createTestUser(app, { username: 'dee', password: '' });
    const link = await adminGql(admin, 'mutation($id: ID!) { createPasswordLink(id: $id) { url } }', { id });
    const token = new URLSearchParams(new URL(link.data.createPasswordLink.url).hash.slice(1)).get('token');
    const visitor = createBrowser(app.base);
    const weak = await postAndRead(visitor, '/api/password-link/set', { token, password: 'password1' });
    expect(weak.status).toBe(HttpStatus.BadRequest);
    expect(weak.body.error).toMatch(/too easy to guess/);
    expect((await postAndRead(visitor, '/api/password-link/set', { token, password: PASSWORD })).status).toBe(
      HttpStatus.Ok,
    );
  });

  it('lets a new link replace the last and an admin-set password cancel it', async () => {
    const { id } = await createTestUser(app, { username: 'cy' });
    const MAKE = 'mutation($id: ID!) { createPasswordLink(id: $id) { url } }';
    const tokenOf = (reply: Awaited<ReturnType<typeof adminGql>>): string | null =>
      new URLSearchParams(new URL(reply.data.createPasswordLink.url).hash.slice(1)).get('token');
    const first = tokenOf(await adminGql(admin, MAKE, { id }));
    const second = tokenOf(await adminGql(admin, MAKE, { id }));
    const visitor = createBrowser(app.base);
    expect((await postAndRead(visitor, '/api/password-link', { token: first })).status).toBe(HttpStatus.NotFound);
    expect((await postAndRead(visitor, '/api/password-link', { token: second })).body.isInvite).toBe(false);
    await adminGql(admin, 'mutation($id: ID!, $p: String!) { setUserPassword(id: $id, password: $p) { id } }', {
      id,
      p: 'set by the admin',
    });
    expect((await postAndRead(visitor, '/api/password-link', { token: second })).status).toBe(HttpStatus.NotFound);
  });
});

describe('groups', () => {
  let app: TestApp;
  let admin: Browser;

  beforeEach(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
    await createTestUser(app, { username: 'ada', groups: ['family', 'media'] });
    await createTestUser(app, { username: 'bob', groups: ['family'] });
  });

  afterEach(() => app.close());

  const GROUPS = '{ groups { name isProtected members { username } clients { name } } }';

  it('lists the groups users and clients name', async () => {
    const reply = await adminGql(admin, GROUPS);
    expect(reply.data.groups.map((group: { name: string }) => group.name)).toEqual([
      'family',
      'heautou-admin',
      'media',
    ]);
    expect(reply.data.groups[0].members.map((user: { username: string }) => user.username).sort()).toEqual([
      'ada',
      'bob',
    ]);
    expect(reply.data.groups[1].isProtected).toBe(true);
  });

  it('renames a group in users and clients, and merges into one that exists', async () => {
    const client = await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: ['http://app.example/callback'],
      postLogoutRedirectUris: [],
      allowedGroups: ['family'],
    });
    const renamed = await adminGql(
      admin,
      'mutation { renameGroup(name: "family", newName: "media") { name members { username } } }',
    );
    expect(renamed.data.renameGroup.members.map((user: { username: string }) => user.username).sort()).toEqual([
      'ada',
      'bob',
    ]);
    expect(app.services.users.list().find((user) => user.username === 'ada')?.groups).toEqual(['media']);
    expect(app.services.clients.find(client.clientId)?.allowedGroups).toEqual(['media']);
  });

  it('protects the admin group', async () => {
    const rename = await adminGql(admin, 'mutation { renameGroup(name: "heautou-admin", newName: "x") { name } }');
    expect(rename.errors[0].message).toContain('keeps its name');
    const into = await adminGql(admin, 'mutation { renameGroup(name: "media", newName: "heautou-admin") { name } }');
    expect(into.errors[0].message).toContain('one by one');
  });

  it('deletes a group unless a client is limited to it', async () => {
    await app.services.clients.create({
      name: 'Photos',
      authMethod: ClientAuthMethod.SecretBasic,
      redirectUris: ['http://app.example/callback'],
      postLogoutRedirectUris: [],
      allowedGroups: ['media'],
    });
    const refused = await adminGql(admin, 'mutation { deleteGroup(name: "media") }');
    expect(refused.errors[0].message).toContain('"Photos"');
    expect((await adminGql(admin, 'mutation { deleteGroup(name: "family") }')).data.deleteGroup).toBe(2);
    expect(app.services.users.list().find((user) => user.username === 'bob')?.groups).toEqual([]);
  });
});

describe('branding', () => {
  let app: TestApp;
  let admin: Browser;

  beforeEach(async () => {
    app = await startTestApp();
    admin = await signInAsAdmin(app);
  });

  afterEach(() => app.close());

  it('names the provider and serves its logo to anyone', async () => {
    const visitor = createBrowser(app.base);
    expect(await (await visitor.send('/api/branding')).json()).toEqual({ name: 'Heautou', logoUrl: null });
    expect((await visitor.send('/api/branding/logo')).status).toBe(HttpStatus.NotFound);
    await adminGql(admin, 'mutation { setBrandingName(name: "Home") { name } }');
    const set = await adminGql(admin, 'mutation($d: String) { setBrandingLogo(dataUrl: $d) { logoUrl } }', {
      d: `data:image/png;base64,${PIXEL_PNG}`,
    });
    const { logoUrl } = set.data.setBrandingLogo;
    expect(logoUrl).toMatch(/^\/api\/branding\/logo\?v=/);
    expect(await (await visitor.send('/api/branding')).json()).toEqual({ name: 'Home', logoUrl });
    const logo = await visitor.send(logoUrl);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await logo.arrayBuffer()).equals(Buffer.from(PIXEL_PNG, 'base64'))).toBe(true);
    await adminGql(admin, 'mutation { setBrandingLogo(dataUrl: null) { logoUrl } }');
    expect((await visitor.send('/api/branding/logo')).status).toBe(HttpStatus.NotFound);
  });

  it('refuses a logo that is not an image', async () => {
    const reply = await adminGql(admin, 'mutation($d: String) { setBrandingLogo(dataUrl: $d) { logoUrl } }', {
      d: 'data:text/html;base64,PHNjcmlwdD4=',
    });
    expect(reply.errors[0].message).toMatch(/png|image/i);
  });

  it('keeps branding mutations for admins', async () => {
    const res = await createBrowser(app.base).send('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation { setBrandingName(name: "Mine") { name } }' }),
    });
    expect(res.status).toBe(HttpStatus.Unauthorized);
    expect(app.services.branding.read().name).toBe('Heautou');
  });
});

describe('breached passwords', () => {
  let app: TestApp;
  let asked: string[];

  beforeEach(async () => {
    asked = [];
    const digest = createHash('sha1').update(PASSWORD).digest('hex').toUpperCase();
    app = await startTestApp({
      fetchRange: async (url) => {
        asked.push(url);
        return new Response(`${digest.slice(HASH_PREFIX_LENGTH)}:42\r\n`);
      },
    });
    await signInAsAdmin(app);
    await app.services.settings.setPasswordRules({ checkBreaches: true });
  });

  afterEach(() => app.close());

  it('refuses a password Have I Been Pwned knows, once the operator turns the check on', async () => {
    const { id } = await createTestUser(app, { username: 'dee', password: '' });
    const { token } = await app.services.passwordLinks.issue(id);
    const set = await postAndRead(createBrowser(app.base), '/api/password-link/set', { token, password: PASSWORD });
    expect(set.status).toBe(HttpStatus.BadRequest);
    expect(set.body.error).toMatch(/data breach/);
    expect(asked).toHaveLength(1);
  });
});
