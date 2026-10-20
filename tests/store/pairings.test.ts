import path from 'node:path';
import { PAIRING_DEFAULTS } from '../../server/core/defaults.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { createPairingStore, type PairingDocument } from '../../server/store/pairings.ts';
import { tempDir } from '../helpers.ts';

describe('pairing store', () => {
  it('keeps only a digest of the token, and finds a pairing until it is used or expires', () => {
    let time = 1_000_000;
    const json = openJsonFile<PairingDocument>(path.join(tempDir(), 'pairings.json'), {});
    const store = createPairingStore(json, () => time);
    const pairing = store.start('iat-1', { allowedGroups: ['family', 'family'] });
    expect(JSON.stringify(json.read())).not.toContain('iat-1');
    expect(pairing).toMatchObject({ allowedGroups: ['family'], groupsClaim: 'groups', clientId: null });
    expect(store.waitingFor('iat-1')?.id).toBe(pairing.id);

    store.complete(pairing.id, 'client-1', 'https://app.example');
    expect(store.waitingFor('iat-1')).toBeNull();
    expect(store.find(pairing.id)).toMatchObject({ clientId: 'client-1', clientUri: 'https://app.example' });

    // Paired, it stays for the operator to finish it.
    time += PAIRING_DEFAULTS.linkSeconds * 1000 + 1;
    expect(store.find(pairing.id)?.clientId).toBe('client-1');
    time += PAIRING_DEFAULTS.reviewSeconds * 1000;
    expect(store.find(pairing.id)).toBeNull();
  });

  it('takes one device client per pairing, until it is finished', () => {
    const store = createPairingStore(openJsonFile<PairingDocument>(path.join(tempDir(), 'd.json'), {}));
    const pairing = store.start('iat-4', {});
    expect(store.waitingForDevice('iat-4')).toBeNull();
    store.complete(pairing.id, 'client-1', null);
    expect(store.waitingForDevice('iat-4')?.id).toBe(pairing.id);
    store.addDeviceClient(pairing.id, 'device-1');
    expect(store.waitingForDevice('iat-4')).toBeNull();
    expect(store.find(pairing.id)).toMatchObject({ deviceClientId: 'device-1', isFinished: false });

    const other = store.start('iat-5', {});
    store.complete(other.id, 'client-2', null);
    store.finish(other.id);
    expect(store.waitingForDevice('iat-5')).toBeNull();
    expect(store.find(other.id)?.isFinished).toBe(true);
  });

  it('cancels a pairing, and refuses a reserved groups claim', () => {
    const store = createPairingStore(openJsonFile<PairingDocument>(path.join(tempDir(), 'p.json'), {}));
    const pairing = store.start('iat-2', {});
    expect(store.cancel(pairing.id)).toBe(true);
    expect(store.cancel(pairing.id)).toBe(false);
    expect(store.waitingFor('iat-2')).toBeNull();
    expect(() => store.start('iat-3', { groupsClaim: 'email' })).toThrow(/groupsClaim/);
  });
});
