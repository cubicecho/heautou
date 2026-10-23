import { createSecretBox, isSealed } from '../../server/core/secret-box.ts';
import { newTotpSecret, totpCode, totpStepAt } from '../../server/core/totp.ts';
import { openDocument } from '../../server/db/document.ts';
import { FACTORS_DOCUMENT } from '../../server/db/documents.ts';
import { recoveryCodes, totpFactors } from '../../server/db/schema.ts';
import { createFactorStore, type FactorStore, factorSecretsIn } from '../../server/store/factors.ts';
import { openSealedDocument } from '../../server/store/sealed-document.ts';
import { createTestStore, type TestStore } from '../db.ts';

const NOW = 1_800_000_000_000;
const PASSKEY = { id: 'cred-1', publicKey: 'cHVibGlj', counter: 0, transports: ['internal'], name: 'Laptop' };

describe('factor store', () => {
  let db: TestStore;
  let store: FactorStore;

  beforeEach(async () => {
    db = await createTestStore();
    store = createFactorStore(await openDocument(db, FACTORS_DOCUMENT), () => NOW);
  });

  afterEach(() => db.close());

  it('checks an authenticator code once', async () => {
    const secret = newTotpSecret();
    await store.setTotp('ada', secret, -1);
    const code = totpCode(secret, totpStepAt(NOW));
    expect(store.hasSecondFactor('ada')).toBe(true);
    expect(await store.checkTotp('ada', code)).toBe(true);
    expect(await store.checkTotp('ada', code)).toBe(false);
    expect(await store.checkTotp('bob', code)).toBe(false);
  });

  it('keeps the used step, so a code is refused after the store is opened again', async () => {
    const secret = newTotpSecret();
    await store.setTotp('ada', secret, -1);
    const code = totpCode(secret, totpStepAt(NOW));
    expect(await store.checkTotp('ada', code)).toBe(true);
    const reopened = createFactorStore(await openDocument(db, FACTORS_DOCUMENT), () => NOW);
    expect(await reopened.checkTotp('ada', code)).toBe(false);
  });

  it('keeps recovery codes hashed and lets each be used once', async () => {
    await store.setTotp('ada', newTotpSecret(), -1);
    const codes = await store.newRecoveryCodes('ada');
    expect(codes).toHaveLength(10);
    const [first = '', second = ''] = codes;
    const rows = await db.db.select().from(recoveryCodes);
    expect(rows).toHaveLength(10);
    expect(JSON.stringify(rows)).not.toContain(first);
    expect(await store.useRecoveryCode('ada', first.toLowerCase().replace('-', ' '))).toBe(true);
    expect(await store.useRecoveryCode('ada', first)).toBe(false);
    expect(store.summary('ada').recoveryCodesLeft).toBe(9);
    await store.newRecoveryCodes('ada');
    expect(await store.useRecoveryCode('ada', second)).toBe(false);
  });

  it('drops the recovery codes with the last factor', async () => {
    await store.addPasskey('ada', PASSKEY);
    await store.newRecoveryCodes('ada');
    await store.removePasskey('ada', PASSKEY.id);
    expect(store.summary('ada')).toEqual({ hasTotp: false, recoveryCodesLeft: 0, passkeys: [] });
    expect(store.hasSecondFactor('ada')).toBe(false);
  });

  it('finds a passkey by credential and records its use', async () => {
    await store.addPasskey('ada', PASSKEY);
    expect(store.findPasskey(PASSKEY.id)?.userId).toBe('ada');
    await store.usedPasskey(PASSKEY.id, 3);
    expect(store.passkeysOf('ada')[0]).toMatchObject({ counter: 3, lastUsedAt: new Date(NOW).toISOString() });
    expect(store.summary('ada').passkeys[0]).not.toHaveProperty('publicKey');
    await expect(store.removePasskey('bob', PASSKEY.id)).rejects.toThrow(/not registered/);
  });

  it('removes everything for a lost phone', async () => {
    await store.setTotp('ada', newTotpSecret(), -1);
    await store.addPasskey('ada', PASSKEY);
    expect(await store.removeAll('ada')).toBe(true);
    expect(store.hasSecondFactor('ada')).toBe(false);
    expect(store.findPasskey(PASSKEY.id)).toBeNull();
    expect(await store.removeAll('ada')).toBe(false);
  });

  it('seals the authenticator secret in the database under the secret key', async () => {
    const box = createSecretBox({ current: Buffer.alloc(32, 7), previous: null });
    const open = async (): Promise<FactorStore> =>
      createFactorStore(
        await openSealedDocument(await openDocument(db, FACTORS_DOCUMENT), box, factorSecretsIn),
        () => NOW,
      );
    const secret = newTotpSecret();
    await (await open()).setTotp('ada', secret, -1);
    const rows = await db.db.select().from(totpFactors);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(isSealed(rows[0]?.secret ?? '')).toBe(true);
    expect(await (await open()).checkTotp('ada', totpCode(secret, totpStepAt(NOW)))).toBe(true);
  });
});
