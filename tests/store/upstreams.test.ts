import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { createSecretBox } from '../../server/core/secret-box.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { openSealedFile } from '../../server/store/sealed-file.ts';
import {
  createUpstreamStore,
  EMPTY_UPSTREAMS,
  type NewUpstream,
  UpstreamKind,
  type UpstreamsDocument,
  upstreamSecretsIn,
} from '../../server/store/upstreams.ts';
import { mappedGroups } from '../../server/upstream/accounts.ts';
import type { UpstreamIdentity } from '../../server/upstream/client.ts';
import { tempDir } from '../helpers.ts';

const GOOGLE: NewUpstream = {
  id: 'google',
  name: 'Google',
  kind: UpstreamKind.Oidc,
  issuer: 'https://accounts.google.com/',
  clientId: 'id.apps.googleusercontent.com',
  clientSecret: 'g-secret',
};
const KEY = { providerId: 'google', issuer: 'https://accounts.google.com', subject: '1234' };

/**
 * Opens an upstream store on a fresh file.
 *
 * @param [allowsHttp] - Whether plain http issuers are allowed.
 * @returns The store and the file's path.
 */
function freshStore(allowsHttp = false) {
  const file = path.join(tempDir(), 'upstreams.json');
  const store = createUpstreamStore(openJsonFile<UpstreamsDocument>(file, EMPTY_UPSTREAMS), {
    allowsHttp: () => allowsHttp,
  });
  return { file, store };
}

describe('upstream store', () => {
  it('settles what an OpenID Connect provider leaves out', () => {
    const { store } = freshStore();
    const google = store.create({ ...GOOGLE, scopes: ['email'] });
    expect(google).toMatchObject({
      issuer: 'https://accounts.google.com',
      scopes: ['openid', 'email'],
      unknownIdentity: 'refuse',
      createDomains: [],
      countsAsBothFactors: false,
      groupsClaim: null,
    });
    expect(store.create({ ...GOOGLE, id: 'google-2' }).scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('refuses a bad id, a taken id, a missing issuer and a plain http one off loopback', () => {
    const { store } = freshStore();
    store.create(GOOGLE);
    expect(() => store.create({ ...GOOGLE, id: 'Google Workspace' })).toThrow(/lower-case/);
    expect(() => store.create(GOOGLE)).toThrow(/already taken/);
    expect(() => store.create({ ...GOOGLE, id: 'x', issuer: null })).toThrow(/issuer/);
    expect(() => store.create({ ...GOOGLE, id: 'x', issuer: 'http://idp.lan' })).toThrow(/plain http/);
    expect(store.create({ ...GOOGLE, id: 'local', issuer: 'http://localhost:9000/oidc' }).issuer).toBe(
      'http://localhost:9000/oidc',
    );
    expect(freshStore(true).store.create({ ...GOOGLE, issuer: 'http://idp.lan' }).issuer).toBe('http://idp.lan');
  });

  it('needs a secret for GitHub, drops its issuer and keeps a secret left blank on update', () => {
    const { store } = freshStore();
    const github = { id: 'github', name: 'GitHub', kind: UpstreamKind.GitHub, clientId: 'Iv1.x' } as const;
    expect(() => store.create(github)).toThrow(/client secret/);
    const made = store.create({ ...github, clientSecret: 's1', issuer: 'https://ignored.example' });
    expect(made).toMatchObject({ issuer: null, scopes: ['read:user', 'user:email'], clientSecret: 's1' });
    expect(store.update('github', { ...github, name: 'GitHub.com', clientSecret: '  ' }).clientSecret).toBe('s1');
    expect(store.update('github', { ...github, clientSecret: 's2' }).clientSecret).toBe('s2');
  });

  it('never lets a provider hand out the admin group', () => {
    const { store } = freshStore();
    expect(() => store.create({ ...GOOGLE, createGroups: [ADMIN_DEFAULTS.group] })).toThrow(/admin/);
    expect(() =>
      store.create({
        ...GOOGLE,
        groupsClaim: 'groups',
        groupMappings: [{ upstream: 'it', local: ADMIN_DEFAULTS.group }],
      }),
    ).toThrow(/admin/);
    expect(() => store.create({ ...GOOGLE, groupMappings: [{ upstream: 'it', local: 'ops' }] })).toThrow(/groupsClaim/);
  });

  it('links an identity to one user, and a user to one identity per provider', () => {
    const { store } = freshStore();
    store.create(GOOGLE);
    store.link('ada', KEY, 'ada@example.com');
    expect(store.link('ada', KEY, 'ada@example.com').userId).toBe('ada');
    expect(() => store.link('bob', KEY, 'ada@example.com')).toThrow(/another user/);
    expect(() => store.link('ada', { ...KEY, subject: '999' }, 'other')).toThrow(/already have/);
    expect(store.findLink({ ...KEY, issuer: 'https://evil.example' })).toBeNull();
    store.usedLink(KEY);
    expect(store.findLink(KEY)?.lastUsedAt).not.toBeNull();
    expect(store.unlink('ada', 'google').label).toBe('ada@example.com');
    expect(() => store.unlink('ada', 'google')).toThrow(/Nothing is linked/);
  });

  it('removes the links with the provider or the user', () => {
    const { store } = freshStore();
    store.create(GOOGLE);
    store.link('ada', KEY, 'ada');
    store.link('bob', { ...KEY, subject: '2' }, 'bob');
    expect(store.removeUser('bob')).toBe(1);
    expect(store.remove('google').unlinked).toBe(1);
    expect(store.linksOf('ada')).toEqual([]);
  });

  it('follows a renamed or removed group', () => {
    const { store } = freshStore();
    store.create({
      ...GOOGLE,
      createGroups: ['staff', 'ops'],
      groupsClaim: 'groups',
      groupMappings: [{ upstream: 'it', local: 'ops' }],
    });
    store.replaceGroup('ops', 'operations');
    expect(store.find('google')).toMatchObject({
      createGroups: ['staff', 'operations'],
      groupMappings: [{ upstream: 'it', local: 'operations' }],
    });
    store.replaceGroup('operations', null);
    expect(store.find('google')).toMatchObject({ createGroups: ['staff'], groupMappings: [] });
  });

  it('keeps client secrets sealed on disk', () => {
    const file = path.join(tempDir(), 'upstreams.json');
    const box = createSecretBox({ current: Buffer.alloc(32, 7), previous: null });
    const open = () =>
      createUpstreamStore(
        openSealedFile(openJsonFile<UpstreamsDocument>(file, EMPTY_UPSTREAMS), box, upstreamSecretsIn),
      );
    open().create(GOOGLE);
    expect(readFileSync(file, 'utf8')).not.toContain('g-secret');
    expect(open().find('google')?.clientSecret).toBe('g-secret');
  });
});

describe('mapped groups', () => {
  it('gives the mapped groups held upstream, takes away the rest of them, and leaves other groups alone', () => {
    const { store } = freshStore();
    const provider = store.create({
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
