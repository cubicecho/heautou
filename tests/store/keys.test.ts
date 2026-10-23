import { KEY_DEFAULTS } from '../../server/core/defaults.ts';
import { loosen, openDocument, replaceDocument } from '../../server/db/document.ts';
import { KEYS_DOCUMENT } from '../../server/db/documents.ts';
import { openKeyStore } from '../../server/store/keys.ts';
import { createTestStore, type TestStore } from '../db.ts';

const DAY_MS = 86_400_000;

describe('key store', () => {
  let db: TestStore;

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('makes keys once and rotates them when they are old', async () => {
    let time = Date.parse('2026-01-01T00:00:00Z');
    const now = (): number => time;
    const store = await openKeyStore(await openDocument(db, KEYS_DOCUMENT), now);
    const first = store.current();
    expect(first.jwks).toHaveLength(1);
    expect((await openKeyStore(await openDocument(db, KEYS_DOCUMENT), now)).current()).toEqual(first);
    expect(store.isDue()).toBe(false);
    time += (KEY_DEFAULTS.rotationDays + 1) * DAY_MS;
    expect(store.isDue()).toBe(true);
    await store.rotate();
    await store.rotate();
    const { jwks, cookieKeys, rotatedAt } = store.current();
    expect(jwks).toHaveLength(KEY_DEFAULTS.keptKeys);
    expect(cookieKeys).toHaveLength(KEY_DEFAULTS.keptKeys);
    expect(jwks.map((jwk) => jwk.kid)).not.toContain(first.jwks[0]?.kid);
    expect(rotatedAt).toBe(new Date(now()).toISOString());
    expect(store.isDue()).toBe(false);
    expect((await openKeyStore(await openDocument(db, KEYS_DOCUMENT), now)).current()).toEqual(store.current());
  });

  it('dates keys written before rotation existed from now', async () => {
    const fresh = (await openKeyStore(await openDocument(db, KEYS_DOCUMENT))).current();
    await db.db.transaction((tx) =>
      replaceDocument(tx, loosen(KEYS_DOCUMENT), { jwks: fresh.jwks, cookieKeys: fresh.cookieKeys }),
    );
    const store = await openKeyStore(await openDocument(db, KEYS_DOCUMENT));
    expect(store.current().jwks).toEqual(fresh.jwks);
    expect(store.current().rotatedAt).toEqual(expect.any(String));
    expect(store.isDue()).toBe(false);
  });
});
