import { FORWARD_AUTH_DEFAULTS } from '../../server/core/defaults.ts';
import { MS_PER_SECOND } from '../../server/core/wire.ts';
import { openDocument } from '../../server/db/document.ts';
import { PROTECTED_SITES_DOCUMENT, PROXY_SESSIONS_DOCUMENT } from '../../server/db/documents.ts';
import { proxySessions } from '../../server/db/schema.ts';
import {
  cookieDomainProblem,
  createProtectedSiteStore,
  type ProtectedSiteStore,
} from '../../server/store/protected-sites.ts';
import { createProxySessionStore } from '../../server/store/proxy-sessions.ts';
import { createTestStore, type TestStore } from '../db.ts';

describe('protected site store', () => {
  let db: TestStore;
  let store: ProtectedSiteStore;

  /**
   * Opens a site store on the test database, as Heautou at auth.home.lan.
   *
   * @returns The store.
   */
  async function siteStore(): Promise<ProtectedSiteStore> {
    return createProtectedSiteStore(await openDocument(db, PROTECTED_SITES_DOCUMENT), { issuerHost: 'auth.home.lan' });
  }

  beforeEach(async () => {
    db = await createTestStore();
    store = await siteStore();
  });

  afterEach(() => db.close());

  it('matches the longest path prefix on the host, at a segment boundary', async () => {
    const whole = await store.create({ name: 'Wiki', host: 'wiki.home.lan' });
    const admin = await store.create({ name: 'Wiki admin', host: 'wiki.home.lan', pathPrefix: '/admin' });
    expect(store.match('wiki.home.lan', '/admin/users')?.id).toBe(admin.id);
    expect(store.match('WIKI.home.lan', '/admin')?.id).toBe(admin.id);
    expect(store.match('wiki.home.lan', '/administrator')?.id).toBe(whole.id);
    expect(store.match('other.home.lan', '/')).toBeNull();
  });

  it('refuses a malformed host or path, and a second site at the same address', async () => {
    await store.create({ name: 'Wiki', host: 'wiki.home.lan' });
    await expect(store.create({ name: 'Again', host: 'wiki.home.lan' })).rejects.toThrow(/already covers/);
    await expect(store.create({ name: 'Url', host: 'https://wiki.home.lan' })).rejects.toThrow(/host/);
    await expect(store.create({ name: 'Port', host: 'wiki.home.lan:8080' })).rejects.toThrow(/host/);
    await expect(store.create({ name: 'Dots', host: 'x.home.lan', pathPrefix: '/a/../b' })).rejects.toThrow(
      /pathPrefix/,
    );
  });

  it('renames and removes a group in every site', async () => {
    const site = await store.create({ name: 'Wiki', host: 'wiki.home.lan', allowedGroups: ['staff', 'family'] });
    await store.replaceGroup('staff', 'crew');
    expect(store.find(site.id)?.allowedGroups).toEqual(['crew', 'family']);
  });

  it('takes only a cookie domain the browser would accept from Heautou’s host', async () => {
    expect(await store.setCookieDomain('.Home.Lan')).toBe('home.lan');
    expect(store.cookieDomain()).toBe('home.lan');
    await expect(store.setCookieDomain('media.lan')).rejects.toThrow(/not under media.lan/);
    await expect(store.setCookieDomain('lan')).rejects.toThrow(/single label/);
    expect(await store.setCookieDomain(null)).toBeNull();
    expect(store.cookieDomain()).toBeNull();
    expect(cookieDomainProblem('home.lan', 'home.lan')).toBeNull();
  });

  it('reads back the sites and the cookie domain when opened again on the same database', async () => {
    const site = await store.create({ name: 'Wiki', host: 'wiki.home.lan', requireSecondFactor: true });
    await store.setCookieDomain('home.lan');
    const reopened = await siteStore();
    expect(reopened.find(site.id)).toEqual(site);
    expect(reopened.cookieDomain()).toBe('home.lan');
  });
});

describe('proxy session store', () => {
  let db: TestStore;

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('keeps only a digest of the token, and ends a session past its lifetime or idle too long', async () => {
    let time = 1_000_000;
    const store = createProxySessionStore(await openDocument(db, PROXY_SESSIONS_DOCUMENT), () => time);
    const { idleSeconds, sessionSeconds, touchSeconds } = FORWARD_AUTH_DEFAULTS;
    const token = await store.create({ userId: 'u1', grantId: 'g1', amr: ['pwd'], acr: 'pwd' });
    expect(JSON.stringify(await db.db.select().from(proxySessions))).not.toContain(token);
    expect((await store.use(token))?.userId).toBe('u1');

    // Used just inside the idle limit each time, it lasts until its lifetime ends.
    const step = (idleSeconds - touchSeconds) * MS_PER_SECOND;
    while (time + step < 1_000_000 + sessionSeconds * MS_PER_SECOND) {
      time += step;
      expect(await store.use(token)).not.toBeNull();
    }
    time = 1_000_000 + sessionSeconds * MS_PER_SECOND;
    expect(await store.use(token)).toBeNull();

    const idle = await store.create({ userId: 'u2', grantId: 'g2', amr: [], acr: 'pwd' });
    time += idleSeconds * MS_PER_SECOND;
    expect(await store.use(idle)).toBeNull();
  });

  it('ends a session on removal', async () => {
    const store = createProxySessionStore(await openDocument(db, PROXY_SESSIONS_DOCUMENT));
    const token = await store.create({ userId: 'u1', grantId: 'g1', amr: [], acr: 'pwd' });
    await store.remove(token);
    expect(await store.use(token)).toBeNull();
    expect(await db.db.select().from(proxySessions)).toEqual([]);
  });
});
