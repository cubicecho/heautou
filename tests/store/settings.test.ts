import { PASSWORD_RULE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { openDocument } from '../../server/db/document.ts';
import { SETTINGS_DOCUMENT } from '../../server/db/documents.ts';
import { createSettingsStore, MAX_PASSWORD_SCORE, type SettingsStore } from '../../server/store/settings.ts';
import { createTestStore, type TestStore } from '../db.ts';

const HTTPS_ISSUER = 'https://id.example.com/oidc';

describe('settings store', () => {
  let db: TestStore;

  /**
   * Opens a settings store on the test database.
   *
   * @param issuer - The provider's issuer.
   * @returns The store.
   */
  async function open(issuer: string): Promise<SettingsStore> {
    return createSettingsStore(await openDocument(db, SETTINGS_DOCUMENT), issuer);
  }

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('allows plain http redirect URIs by default only when the issuer is plain http', async () => {
    expect((await open('http://framework.lan:10000/oidc')).httpRedirects()).toEqual({
      isAllowed: true,
      isSet: false,
      isIssuerHttp: true,
    });
    expect((await open(HTTPS_ISSUER)).httpRedirects()).toEqual({
      isAllowed: false,
      isSet: false,
      isIssuerHttp: false,
    });
  });

  it('keeps the choice in the database, and forgets it when reset', async () => {
    const store = await open(HTTPS_ISSUER);
    expect(await store.setHttpRedirects(true)).toMatchObject({ isAllowed: true, isSet: true });
    const reopened = await open(HTTPS_ISSUER);
    expect(reopened.httpRedirects().isAllowed).toBe(true);
    expect(await reopened.setHttpRedirects(null)).toMatchObject({ isAllowed: false, isSet: false });
    expect((await open(HTTPS_ISSUER)).httpRedirects().isSet).toBe(false);
  });

  it('follows the password rule defaults until they are set', async () => {
    expect((await open(HTTPS_ISSUER)).passwordRules()).toEqual({
      minScore: PASSWORD_RULE_DEFAULTS.minScore,
      checkBreaches: PASSWORD_RULE_DEFAULTS.checkBreaches,
    });
  });

  it('keeps each password rule in the database, leaving the other alone', async () => {
    const store = await open(HTTPS_ISSUER);
    await store.setPasswordRules({ minScore: MAX_PASSWORD_SCORE });
    expect(await store.setPasswordRules({ checkBreaches: true })).toEqual({
      minScore: MAX_PASSWORD_SCORE,
      checkBreaches: true,
    });
    const reopened = await open(HTTPS_ISSUER);
    expect(reopened.passwordRules()).toEqual({ minScore: MAX_PASSWORD_SCORE, checkBreaches: true });
  });

  it('refuses a minimum score zxcvbn never gives', async () => {
    const store = await open(HTTPS_ISSUER);
    await expect(store.setPasswordRules({ minScore: MAX_PASSWORD_SCORE + 1 })).rejects.toThrow(
      expect.objectContaining({ extensions: { code: ErrorCode.BadUserInput } }),
    );
    expect(store.passwordRules().minScore).toBe(PASSWORD_RULE_DEFAULTS.minScore);
  });
});
