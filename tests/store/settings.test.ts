import path from 'node:path';
import { PASSWORD_RULE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { createSettingsStore, MAX_PASSWORD_SCORE, type SettingsDocument } from '../../server/store/settings.ts';
import { tempDir } from '../helpers.ts';

const HTTPS_ISSUER = 'https://id.example.com/oidc';

/**
 * Opens a settings store on a fresh file.
 *
 * @param issuer - The provider's issuer.
 * @returns The store and the file's path.
 */
function freshStore(issuer: string) {
  const file = path.join(tempDir(), 'settings.json');
  return { file, store: createSettingsStore(openJsonFile<SettingsDocument>(file, {}), issuer) };
}

describe('settings store', () => {
  it('allows plain http redirect URIs by default only when the issuer is plain http', () => {
    expect(freshStore('http://framework.lan:10000/oidc').store.httpRedirects()).toEqual({
      isAllowed: true,
      isSet: false,
      isIssuerHttp: true,
    });
    expect(freshStore(HTTPS_ISSUER).store.httpRedirects()).toEqual({
      isAllowed: false,
      isSet: false,
      isIssuerHttp: false,
    });
  });

  it('keeps the choice on disk, and forgets it when reset', () => {
    const { file, store } = freshStore(HTTPS_ISSUER);
    expect(store.setHttpRedirects(true)).toMatchObject({ isAllowed: true, isSet: true });
    const reopened = createSettingsStore(openJsonFile<SettingsDocument>(file, {}), HTTPS_ISSUER);
    expect(reopened.httpRedirects().isAllowed).toBe(true);
    expect(reopened.setHttpRedirects(null)).toMatchObject({ isAllowed: false, isSet: false });
  });

  it('follows the password rule defaults until they are set', () => {
    const { store } = freshStore(HTTPS_ISSUER);
    expect(store.passwordRules()).toEqual({
      minScore: PASSWORD_RULE_DEFAULTS.minScore,
      checkBreaches: PASSWORD_RULE_DEFAULTS.checkBreaches,
    });
  });

  it('keeps each password rule on disk, leaving the other alone', () => {
    const { file, store } = freshStore(HTTPS_ISSUER);
    store.setPasswordRules({ minScore: MAX_PASSWORD_SCORE });
    expect(store.setPasswordRules({ checkBreaches: true })).toEqual({
      minScore: MAX_PASSWORD_SCORE,
      checkBreaches: true,
    });
    const reopened = createSettingsStore(openJsonFile<SettingsDocument>(file, {}), HTTPS_ISSUER);
    expect(reopened.passwordRules()).toEqual({ minScore: MAX_PASSWORD_SCORE, checkBreaches: true });
  });

  it('refuses a minimum score zxcvbn never gives', () => {
    const { store } = freshStore(HTTPS_ISSUER);
    expect(() => store.setPasswordRules({ minScore: MAX_PASSWORD_SCORE + 1 })).toThrow(
      expect.objectContaining({ extensions: { code: ErrorCode.BadUserInput } }),
    );
    expect(store.passwordRules().minScore).toBe(PASSWORD_RULE_DEFAULTS.minScore);
  });
});
