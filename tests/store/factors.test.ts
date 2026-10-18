import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSecretBox } from '../../server/core/secret-box.ts';
import { newTotpSecret, totpCode, totpStepAt } from '../../server/core/totp.ts';
import { createFactorStore, type FactorsDocument, factorSecretsIn } from '../../server/store/factors.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { openSealedFile } from '../../server/store/sealed-file.ts';
import { tempDir } from '../helpers.ts';

const NOW = 1_800_000_000_000;
const PASSKEY = { id: 'cred-1', publicKey: 'cHVibGlj', counter: 0, transports: ['internal'], name: 'Laptop' };

/**
 * Opens a factor store on a fresh file.
 *
 * @returns The store and the file's path.
 */
function freshStore() {
  const file = path.join(tempDir(), 'factors.json');
  return { file, store: createFactorStore(openJsonFile<FactorsDocument>(file, {}), () => NOW) };
}

describe('factor store', () => {
  it('checks an authenticator code once', () => {
    const { store } = freshStore();
    const secret = newTotpSecret();
    store.setTotp('ada', secret, -1);
    const code = totpCode(secret, totpStepAt(NOW));
    expect(store.hasSecondFactor('ada')).toBe(true);
    expect(store.checkTotp('ada', code)).toBe(true);
    expect(store.checkTotp('ada', code)).toBe(false);
    expect(store.checkTotp('bob', code)).toBe(false);
  });

  it('keeps recovery codes hashed and lets each be used once', () => {
    const { file, store } = freshStore();
    store.setTotp('ada', newTotpSecret(), -1);
    const codes = store.newRecoveryCodes('ada');
    expect(codes).toHaveLength(10);
    const [first = '', second = ''] = codes;
    expect(readFileSync(file, 'utf8')).not.toContain(first);
    expect(store.useRecoveryCode('ada', first.toLowerCase().replace('-', ' '))).toBe(true);
    expect(store.useRecoveryCode('ada', first)).toBe(false);
    expect(store.summary('ada').recoveryCodesLeft).toBe(9);
    store.newRecoveryCodes('ada');
    expect(store.useRecoveryCode('ada', second)).toBe(false);
  });

  it('drops the recovery codes with the last factor', () => {
    const { store } = freshStore();
    store.addPasskey('ada', PASSKEY);
    store.newRecoveryCodes('ada');
    store.removePasskey('ada', PASSKEY.id);
    expect(store.summary('ada')).toEqual({ hasTotp: false, recoveryCodesLeft: 0, passkeys: [] });
    expect(store.hasSecondFactor('ada')).toBe(false);
  });

  it('finds a passkey by credential and records its use', () => {
    const { store } = freshStore();
    store.addPasskey('ada', PASSKEY);
    expect(store.findPasskey(PASSKEY.id)?.userId).toBe('ada');
    store.usedPasskey(PASSKEY.id, 3);
    expect(store.passkeysOf('ada')[0]).toMatchObject({ counter: 3, lastUsedAt: new Date(NOW).toISOString() });
    expect(store.summary('ada').passkeys[0]).not.toHaveProperty('publicKey');
    expect(() => store.removePasskey('bob', PASSKEY.id)).toThrow(/not registered/);
  });

  it('removes everything for a lost phone', () => {
    const { store } = freshStore();
    store.setTotp('ada', newTotpSecret(), -1);
    store.addPasskey('ada', PASSKEY);
    expect(store.removeAll('ada')).toBe(true);
    expect(store.hasSecondFactor('ada')).toBe(false);
    expect(store.findPasskey(PASSKEY.id)).toBeNull();
    expect(store.removeAll('ada')).toBe(false);
  });

  it('seals the authenticator secret on disk under the secret key', () => {
    const file = path.join(tempDir(), 'factors.json');
    const box = createSecretBox({ current: Buffer.alloc(32, 7), previous: null });
    const sealed = openSealedFile(openJsonFile<FactorsDocument>(file, {}), box, factorSecretsIn);
    const secret = newTotpSecret();
    createFactorStore(sealed, () => NOW).setTotp('ada', secret, -1);
    expect(readFileSync(file, 'utf8')).not.toContain(secret);
    expect(readFileSync(file, 'utf8')).toContain('enc:v1:');
    const reopened = openSealedFile(openJsonFile<FactorsDocument>(file, {}), box, factorSecretsIn);
    expect(createFactorStore(reopened, () => NOW).checkTotp('ada', totpCode(secret, totpStepAt(NOW)))).toBe(true);
  });
});
