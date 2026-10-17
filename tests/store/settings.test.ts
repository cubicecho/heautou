import path from 'node:path';
import { openJsonFile } from '../../server/store/json-file.ts';
import { createSettingsStore, type SettingsDocument } from '../../server/store/settings.ts';
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
});
