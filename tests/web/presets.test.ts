import { openDocument } from '../../server/db/document.ts';
import { CLIENTS_DOCUMENT } from '../../server/db/documents.ts';
import { type ClientAuthMethod, createClientStore } from '../../server/store/clients.ts';
import {
  baseUrlFrom,
  baseUrlOfClient,
  envText,
  heautouUrlOf,
  PRESETS,
  type PresetContext,
  presetById,
  presetFields,
  SITE_PRESETS,
  UNSUPPORTED_APPS,
} from '../../web/src/clients/presets.ts';
import { createTestStore } from '../db.ts';

const CONTEXT: PresetContext = {
  issuer: 'https://auth.example.com/oidc',
  discoveryUrl: 'https://auth.example.com/oidc/.well-known/openid-configuration',
  clientId: 'app',
  clientSecret: 'shh',
  baseUrl: 'http://app.lan:3000',
  allowedGroups: [],
};

/** What the client store takes as a preset ID (`server/store/clients.ts`). */
const STORED_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('client presets', () => {
  it('gives every preset an ID the client store takes, once each', () => {
    const ids = PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(STORED_ID);
      expect(id).not.toBe('blank');
    }
  });

  it('gives every preset https docs, a callback and settings that are not blank', () => {
    for (const preset of PRESETS) {
      expect(preset.docsUrl).toMatch(/^https:\/\//);
      expect(preset.client.redirectPaths.length + (preset.client.extraRedirectUris?.length ?? 0)).toBeGreaterThan(0);
      for (const path of preset.client.redirectPaths) {
        expect(path).toMatch(/^\//);
      }
      expect(baseUrlFrom(preset.baseUrlExample)).toBe(preset.baseUrlExample);
      const config = preset.configure(CONTEXT);
      if (config.format === 'file') {
        expect(config.text).toContain(CONTEXT.clientId);
      } else {
        expect(config.settings.length).toBeGreaterThan(0);
        expect(config.settings.map((setting) => setting.value)).toContain(CONTEXT.clientId);
      }
    }
  });

  it('builds a client the client store takes for every preset, on an https address', async () => {
    const db = await createTestStore();
    try {
      const store = createClientStore(await openDocument(db, CLIENTS_DOCUMENT));
      for (const preset of PRESETS) {
        const fields = presetFields(preset, 'https://app.example.com');
        // GraphQL's enum names are the store's values in capitals.
        const authMethod = fields.authMethod.toLowerCase() as ClientAuthMethod;
        const saved = await store.create({ ...fields, authMethod, clientId: preset.id, preset: preset.id });
        expect(saved).toMatchObject({ preset: preset.id, authMethod });
      }
    } finally {
      await db.close();
    }
  });

  it('keeps the IDs of clients, forward-auth guides and unsupported apps apart', () => {
    const ids = [...PRESETS, ...SITE_PRESETS, ...UNSUPPORTED_APPS].map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fills a forward-auth guide with Heautou's own address", () => {
    expect(heautouUrlOf('https://auth.example.com/oidc')).toBe('https://auth.example.com');
    for (const preset of SITE_PRESETS) {
      const config = preset.configure({ heautouUrl: 'https://auth.example.com' });
      expect(config.format === 'file' ? config.text : '').toContain('https://auth.example.com/auth/sign-out');
    }
  });

  it('tidies the address and refuses what is not a plain http(s) URL', () => {
    expect(baseUrlFrom(' http://nas.lan:31001/ ')).toBe('http://nas.lan:31001');
    expect(baseUrlFrom('https://example.com/mealie//')).toBe('https://example.com/mealie');
    expect(baseUrlFrom('nas.lan:31001')).toBeNull();
    expect(baseUrlFrom('ftp://nas.lan')).toBeNull();
    expect(baseUrlFrom('http://nas.lan/?x=1')).toBeNull();
    expect(baseUrlFrom('http://user:pw@nas.lan')).toBeNull();
  });

  it('builds the redirect URIs under the address and finds the address again from them', () => {
    const preset = presetById('ethos');
    if (preset === undefined) {
      throw new Error('no ethos preset');
    }
    const fields = presetFields(preset, 'http://ethos.lan:3000');
    expect(fields).toMatchObject({
      name: 'Ethos',
      authMethod: 'CLIENT_SECRET_BASIC',
      redirectUris: ['http://ethos.lan:3000/api/auth/callback/oidc'],
      postLogoutRedirectUris: [],
      groupsClaim: 'groups',
    });
    expect(baseUrlOfClient(preset, fields.redirectUris)).toBe('http://ethos.lan:3000');
    expect(baseUrlOfClient(preset, ['https://elsewhere.example/cb'])).toBeNull();
  });

  it('writes env settings one per line and knows nothing of an unknown preset', () => {
    expect(
      envText([
        { name: 'A', value: '1' },
        { name: 'B', value: 'two words' },
      ]),
    ).toBe('A=1\nB=two words');
    expect(presetById('nope')).toBeUndefined();
    expect(presetById(null)).toBeUndefined();
  });
});
