import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { createSecretBox, isSealed } from '../../server/core/secret-box.ts';
import { openDocument } from '../../server/db/document.ts';
import { UPSTREAMS_DOCUMENT } from '../../server/db/documents.ts';
import { upstreams } from '../../server/db/schema.ts';
import { openSealedDocument } from '../../server/store/sealed-document.ts';
import {
  createUpstreamStore,
  type NewUpstream,
  UpstreamKind,
  type UpstreamStore,
  upstreamSecretsIn,
} from '../../server/store/upstreams.ts';
import { mappedGroups } from '../../server/upstream/accounts.ts';
import type { UpstreamIdentity } from '../../server/upstream/client.ts';
import { createTestStore, type TestStore } from '../db.ts';

const GOOGLE: NewUpstream = {
  id: 'google',
  name: 'Google',
  kind: UpstreamKind.Oidc,
  issuer: 'https://accounts.google.com/',
  clientId: 'id.apps.googleusercontent.com',
  clientSecret: 'g-secret',
};
const KEY = { providerId: 'google', issuer: 'https://accounts.google.com', subject: '1234' };

let db: TestStore;

beforeEach(async () => {
  db = await createTestStore();
});

afterEach(() => db.close());

/**
 * Opens an upstream store on the test database.
 *
 * @param [allowsHttp] - Whether plain http issuers are allowed.
 * @returns The store.
 */
async function openStore(allowsHttp = false): Promise<UpstreamStore> {
  return createUpstreamStore(await openDocument(db, UPSTREAMS_DOCUMENT), { allowsHttp: () => allowsHttp });
}

describe('upstream store', () => {
  let store: UpstreamStore;

  beforeEach(async () => {
    store = await openStore();
  });

  it('settles what an OpenID Connect provider leaves out', async () => {
    const google = await store.create({ ...GOOGLE, scopes: ['email'] });
    expect(google).toMatchObject({
      issuer: 'https://accounts.google.com',
      scopes: ['openid', 'email'],
      unknownIdentity: 'refuse',
      createDomains: [],
      countsAsBothFactors: false,
      groupsClaim: null,
    });
    expect((await store.create({ ...GOOGLE, id: 'google-2' })).scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('refuses a bad id, a taken id, a missing issuer and a plain http one off loopback', async () => {
    await store.create(GOOGLE);
    await expect(store.create({ ...GOOGLE, id: 'Google Workspace' })).rejects.toThrow(/lower-case/);
    await expect(store.create(GOOGLE)).rejects.toThrow(/already taken/);
    await expect(store.create({ ...GOOGLE, id: 'x', issuer: null })).rejects.toThrow(/issuer/);
    await expect(store.create({ ...GOOGLE, id: 'x', issuer: 'http://idp.lan' })).rejects.toThrow(/plain http/);
    expect((await store.create({ ...GOOGLE, id: 'local', issuer: 'http://localhost:9000/oidc' })).issuer).toBe(
      'http://localhost:9000/oidc',
    );
    const lenient = await openStore(true);
    expect((await lenient.create({ ...GOOGLE, id: 'lan', issuer: 'http://idp.lan' })).issuer).toBe('http://idp.lan');
  });

  it('needs a secret for GitHub, drops its issuer and keeps a secret left blank on update', async () => {
    const github = { id: 'github', name: 'GitHub', kind: UpstreamKind.GitHub, clientId: 'Iv1.x' } as const;
    await expect(store.create(github)).rejects.toThrow(/client secret/);
    const made = await store.create({ ...github, clientSecret: 's1', issuer: 'https://ignored.example' });
    expect(made).toMatchObject({ issuer: null, scopes: ['read:user', 'user:email'], clientSecret: 's1' });
    const renamed = await store.update('github', { ...github, name: 'GitHub.com', clientSecret: '  ' });
    expect(renamed.clientSecret).toBe('s1');
    expect((await store.update('github', { ...github, clientSecret: 's2' })).clientSecret).toBe('s2');
  });

  it('never lets a provider hand out the admin group', async () => {
    await expect(store.create({ ...GOOGLE, createGroups: [ADMIN_DEFAULTS.group] })).rejects.toThrow(/admin/);
    await expect(
      store.create({
        ...GOOGLE,
        groupsClaim: 'groups',
        groupMappings: [{ upstream: 'it', local: ADMIN_DEFAULTS.group }],
      }),
    ).rejects.toThrow(/admin/);
    await expect(store.create({ ...GOOGLE, groupMappings: [{ upstream: 'it', local: 'ops' }] })).rejects.toThrow(
      /groupsClaim/,
    );
  });

  it('links an identity to one user, and a user to one identity per provider', async () => {
    await store.create(GOOGLE);
    await store.link('ada', KEY, 'ada@example.com');
    expect((await store.link('ada', KEY, 'ada@example.com')).userId).toBe('ada');
    await expect(store.link('bob', KEY, 'ada@example.com')).rejects.toThrow(/another user/);
    await expect(store.link('ada', { ...KEY, subject: '999' }, 'other')).rejects.toThrow(/already have/);
    expect(store.findLink({ ...KEY, issuer: 'https://evil.example' })).toBeNull();
    await store.usedLink(KEY);
    expect(store.findLink(KEY)?.lastUsedAt).not.toBeNull();
    expect((await store.unlink('ada', 'google')).label).toBe('ada@example.com');
    await expect(store.unlink('ada', 'google')).rejects.toThrow(/Nothing is linked/);
  });

  it('reads back providers and links when opened again on the same database', async () => {
    await store.create({ ...GOOGLE, groupsClaim: 'groups', groupMappings: [{ upstream: 'it', local: 'ops' }] });
    await store.link('ada', KEY, 'ada@example.com');
    await store.usedLink(KEY);
    const reopened = await openStore();
    expect(reopened.find('google')).toEqual(store.find('google'));
    expect(reopened.findLink(KEY)).toEqual(store.findLink(KEY));
  });

  it('removes the links with the provider or the user', async () => {
    await store.create(GOOGLE);
    await store.link('ada', KEY, 'ada');
    await store.link('bob', { ...KEY, subject: '2' }, 'bob');
    expect(await store.removeUser('bob')).toBe(1);
    expect((await store.remove('google')).unlinked).toBe(1);
    expect(store.linksOf('ada')).toEqual([]);
  });

  it('follows a renamed or removed group', async () => {
    await store.create({
      ...GOOGLE,
      createGroups: ['staff', 'ops'],
      groupsClaim: 'groups',
      groupMappings: [{ upstream: 'it', local: 'ops' }],
    });
    await store.replaceGroup('ops', 'operations');
    expect(store.find('google')).toMatchObject({
      createGroups: ['staff', 'operations'],
      groupMappings: [{ upstream: 'it', local: 'operations' }],
    });
    await store.replaceGroup('operations', null);
    expect(store.find('google')).toMatchObject({ createGroups: ['staff'], groupMappings: [] });
  });

  it('keeps client secrets sealed in the database', async () => {
    const box = createSecretBox({ current: Buffer.alloc(32, 7), previous: null });
    const open = async (): Promise<UpstreamStore> =>
      createUpstreamStore(await openSealedDocument(await openDocument(db, UPSTREAMS_DOCUMENT), box, upstreamSecretsIn));
    await (await open()).create(GOOGLE);
    const rows = await db.db.select().from(upstreams);
    expect(JSON.stringify(rows)).not.toContain('g-secret');
    expect(isSealed(rows[0]?.clientSecret ?? '')).toBe(true);
    expect((await open()).find('google')?.clientSecret).toBe('g-secret');
  });
});

describe('mapped groups', () => {
  it('gives the mapped groups held upstream, takes away the rest of them, and leaves other groups alone', async () => {
    const store = await openStore();
    const provider = await store.create({
      ...GOOGLE,
      groupsClaim: 'groups',
      groupMappings: [
        { upstream: 'eng', local: 'builders' },
        { upstream: 'ops', local: 'operators' },
      ],
    });
    const identity = { groups: ['eng', 'sales'] } as UpstreamIdentity;
    expect(mappedGroups(provider, identity, ['family', 'operators'])).toEqual(['family', 'builders']);
  });
});
