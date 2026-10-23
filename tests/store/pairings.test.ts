import { PAIRING_DEFAULTS } from '../../server/core/defaults.ts';
import { openDocument } from '../../server/db/document.ts';
import { PAIRINGS_DOCUMENT } from '../../server/db/documents.ts';
import { pairings } from '../../server/db/schema.ts';
import { createPairingStore } from '../../server/store/pairings.ts';
import { createTestStore, type TestStore } from '../db.ts';

describe('pairing store', () => {
  let db: TestStore;

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('keeps only a digest of the token, and finds a pairing until it is used or expires', async () => {
    let time = 1_000_000;
    const store = createPairingStore(await openDocument(db, PAIRINGS_DOCUMENT), () => time);
    const pairing = await store.start('iat-1', { allowedGroups: ['family', 'family'] });
    expect(JSON.stringify(await db.db.select().from(pairings))).not.toContain('iat-1');
    expect(pairing).toMatchObject({ allowedGroups: ['family'], groupsClaim: 'groups', clientId: null });
    expect(store.waitingFor('iat-1')?.id).toBe(pairing.id);

    await store.complete(pairing.id, 'client-1', 'https://app.example');
    expect(store.waitingFor('iat-1')).toBeNull();
    expect(store.find(pairing.id)).toMatchObject({ clientId: 'client-1', clientUri: 'https://app.example' });

    // Paired, it stays for the operator to finish it.
    time += PAIRING_DEFAULTS.linkSeconds * 1000 + 1;
    expect(store.find(pairing.id)?.clientId).toBe('client-1');
    time += PAIRING_DEFAULTS.reviewSeconds * 1000;
    expect(store.find(pairing.id)).toBeNull();
  });

  it('finds a waiting pairing by its token when opened again on the same database', async () => {
    const store = createPairingStore(await openDocument(db, PAIRINGS_DOCUMENT));
    const pairing = await store.start('iat-6', { allowedGroups: ['family'] });
    const reopened = createPairingStore(await openDocument(db, PAIRINGS_DOCUMENT));
    expect(reopened.waitingFor('iat-6')).toEqual(pairing);
  });

  it('takes one device client per pairing, until it is finished', async () => {
    const store = createPairingStore(await openDocument(db, PAIRINGS_DOCUMENT));
    const pairing = await store.start('iat-4', {});
    expect(store.waitingForDevice('iat-4')).toBeNull();
    await store.complete(pairing.id, 'client-1', null);
    expect(store.waitingForDevice('iat-4')?.id).toBe(pairing.id);
    await store.addDeviceClient(pairing.id, 'device-1');
    expect(store.waitingForDevice('iat-4')).toBeNull();
    expect(store.find(pairing.id)).toMatchObject({ deviceClientId: 'device-1', isFinished: false });

    const other = await store.start('iat-5', {});
    await store.complete(other.id, 'client-2', null);
    await store.finish(other.id);
    expect(store.waitingForDevice('iat-5')).toBeNull();
    expect(store.find(other.id)?.isFinished).toBe(true);
  });

  it('cancels a pairing, and refuses a reserved groups claim', async () => {
    const store = createPairingStore(await openDocument(db, PAIRINGS_DOCUMENT));
    const pairing = await store.start('iat-2', {});
    expect(await store.cancel(pairing.id)).toBe(true);
    expect(await store.cancel(pairing.id)).toBe(false);
    expect(store.waitingFor('iat-2')).toBeNull();
    await expect(store.start('iat-3', { groupsClaim: 'email' })).rejects.toThrow(/groupsClaim/);
  });
});
