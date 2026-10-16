import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEY_DEFAULTS } from '../../server/core/defaults.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { openKeyStore, type ProviderKeys } from '../../server/store/keys.ts';
import { tempDir } from '../helpers.ts';

const DAY_MS = 86_400_000;

describe('key store', () => {
  it('makes keys once and rotates them when they are old', () => {
    const file = path.join(tempDir(), 'keys.json');
    let time = Date.parse('2026-01-01T00:00:00Z');
    const now = (): Date => new Date(time);
    const store = openKeyStore(openJsonFile<ProviderKeys | null>(file, null), now);
    const first = store.current();
    expect(first.jwks).toHaveLength(1);
    expect(openKeyStore(openJsonFile<ProviderKeys | null>(file, null), now).current()).toEqual(first);
    expect(store.isDue()).toBe(false);
    time += (KEY_DEFAULTS.rotationDays + 1) * DAY_MS;
    expect(store.isDue()).toBe(true);
    store.rotate();
    store.rotate();
    const { jwks, cookieKeys, rotatedAt } = store.current();
    expect(jwks).toHaveLength(KEY_DEFAULTS.keptKeys);
    expect(cookieKeys).toHaveLength(KEY_DEFAULTS.keptKeys);
    expect(jwks.map((jwk) => jwk.kid)).not.toContain(first.jwks[0]?.kid);
    expect(rotatedAt).toBe(now().toISOString());
    expect(store.isDue()).toBe(false);
  });

  it('dates keys written before rotation existed from now', () => {
    const file = path.join(tempDir(), 'keys.json');
    const fresh = openKeyStore(openJsonFile<ProviderKeys | null>(path.join(tempDir(), 'k.json'), null)).current();
    writeFileSync(file, JSON.stringify({ jwks: fresh.jwks, cookieKeys: fresh.cookieKeys }));
    const store = openKeyStore(openJsonFile<ProviderKeys | null>(file, null));
    expect(store.current().jwks).toEqual(fresh.jwks);
    expect(store.current().rotatedAt).toEqual(expect.any(String));
    expect(store.isDue()).toBe(false);
  });
});
