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

    store.complete(pairing.id, 'client-1');
    expect(store.waitingFor('iat-1')).toBeNull();
    expect(store.find(pairing.id)?.clientId).toBe('client-1');

    time += PAIRING_DEFAULTS.linkSeconds * 1000 + 1;
    expect(store.find(pairing.id)).toBeNull();
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
