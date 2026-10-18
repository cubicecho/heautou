import path from 'node:path';
import { FORWARD_AUTH_DEFAULTS } from '../../server/core/defaults.ts';
import { MS_PER_SECOND } from '../../server/core/wire.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import {
  cookieDomainProblem,
  createProtectedSiteStore,
  EMPTY_PROTECTED_SITES,
  type ProtectedSitesDocument,
} from '../../server/store/protected-sites.ts';
import { createProxySessionStore, type ProxySessionDocument } from '../../server/store/proxy-sessions.ts';
import { tempDir } from '../helpers.ts';

/**
 * Opens a site store on a new file, as Heautou at auth.home.lan.
 *
 * @returns The store.
 */
function siteStore() {
  const file = openJsonFile<ProtectedSitesDocument>(path.join(tempDir(), 'sites.json'), EMPTY_PROTECTED_SITES);
  return createProtectedSiteStore(file, { issuerHost: 'auth.home.lan' });
}

describe('protected site store', () => {
  it('matches the longest path prefix on the host, at a segment boundary', () => {
    const store = siteStore();
    const whole = store.create({ name: 'Wiki', host: 'wiki.home.lan' });
    const admin = store.create({ name: 'Wiki admin', host: 'wiki.home.lan', pathPrefix: '/admin' });
    expect(store.match('wiki.home.lan', '/admin/users')?.id).toBe(admin.id);
    expect(store.match('WIKI.home.lan', '/admin')?.id).toBe(admin.id);
    expect(store.match('wiki.home.lan', '/administrator')?.id).toBe(whole.id);
    expect(store.match('other.home.lan', '/')).toBeNull();
  });

  it('refuses a malformed host or path, and a second site at the same address', () => {
    const store = siteStore();
    store.create({ name: 'Wiki', host: 'wiki.home.lan' });
    expect(() => store.create({ name: 'Again', host: 'wiki.home.lan' })).toThrow(/already covers/);
    expect(() => store.create({ name: 'Url', host: 'https://wiki.home.lan' })).toThrow(/host/);
    expect(() => store.create({ name: 'Port', host: 'wiki.home.lan:8080' })).toThrow(/host/);
    expect(() => store.create({ name: 'Dots', host: 'x.home.lan', pathPrefix: '/a/../b' })).toThrow(/pathPrefix/);
  });

  it('renames and removes a group in every site', () => {
    const store = siteStore();
    const site = store.create({ name: 'Wiki', host: 'wiki.home.lan', allowedGroups: ['staff', 'family'] });
    store.replaceGroup('staff', 'crew');
    expect(store.find(site.id)?.allowedGroups).toEqual(['crew', 'family']);
  });

  it('takes only a cookie domain the browser would accept from Heautou’s host', () => {
    const store = siteStore();
    expect(store.setCookieDomain('.Home.Lan')).toBe('home.lan');
    expect(store.cookieDomain()).toBe('home.lan');
    expect(() => store.setCookieDomain('media.lan')).toThrow(/not under media.lan/);
    expect(() => store.setCookieDomain('lan')).toThrow(/single label/);
    expect(store.setCookieDomain(null)).toBeNull();
    expect(store.cookieDomain()).toBeNull();
    expect(cookieDomainProblem('home.lan', 'home.lan')).toBeNull();
  });
});

describe('proxy session store', () => {
  it('keeps only a digest of the token, and ends a session past its lifetime or idle too long', () => {
    let time = 1_000_000;
    const file = openJsonFile<ProxySessionDocument>(path.join(tempDir(), 'proxy.json'), {});
    const store = createProxySessionStore(file, () => time);
    const { idleSeconds, sessionSeconds, touchSeconds } = FORWARD_AUTH_DEFAULTS;
    const token = store.create({ userId: 'u1', grantId: 'g1', amr: ['pwd'], acr: 'pwd' });
    expect(JSON.stringify(file.read())).not.toContain(token);
    expect(store.use(token)?.userId).toBe('u1');

    // Used just inside the idle limit each time, it lasts until its lifetime ends.
    const step = (idleSeconds - touchSeconds) * MS_PER_SECOND;
    while (time + step < 1_000_000 + sessionSeconds * MS_PER_SECOND) {
      time += step;
      expect(store.use(token)).not.toBeNull();
    }
    time = 1_000_000 + sessionSeconds * MS_PER_SECOND;
    expect(store.use(token)).toBeNull();

    const idle = store.create({ userId: 'u2', grantId: 'g2', amr: [], acr: 'pwd' });
    time += idleSeconds * MS_PER_SECOND;
    expect(store.use(idle)).toBeNull();
  });

  it('ends a session on removal', () => {
    const store = createProxySessionStore(openJsonFile<ProxySessionDocument>(path.join(tempDir(), 'p.json'), {}));
    const token = store.create({ userId: 'u1', grantId: 'g1', amr: [], acr: 'pwd' });
    store.remove(token);
    expect(store.use(token)).toBeNull();
  });
});
