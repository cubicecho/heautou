import type { JsonFile } from './json-file.ts';

/** The provider's settings as the file holds them. A setting left out follows its default. */
export interface SettingsDocument {
  /** Whether redirect URIs may be plain `http://` on any host. */
  allowHttpRedirectUris?: boolean;
}

/** Whether plain http redirect URIs are allowed, and why. */
export interface HttpRedirectSetting {
  isAllowed: boolean;
  /** False while the operator has not chosen, so it follows the issuer. */
  isSet: boolean;
  /** Whether the issuer is plain http, which is what the default follows. */
  isIssuerHttp: boolean;
}

/** The operator's settings, kept in one file. */
export interface SettingsStore {
  /**
   * Reads whether plain http redirect URIs are allowed.
   *
   * @returns The setting. Unset, it is allowed exactly when the issuer is plain http.
   */
  httpRedirects: () => HttpRedirectSetting;
  /**
   * Allows or refuses plain http redirect URIs.
   *
   * @param isAllowed - The choice, or null to follow the issuer again.
   * @returns The setting.
   */
  setHttpRedirects: (isAllowed: boolean | null) => HttpRedirectSetting;
}

/**
 * Opens the settings store on its file.
 *
 * @param file - The file. Missing, every setting follows its default.
 * @param issuer - The provider's issuer, which the http redirect default follows.
 * @returns The store.
 */
export function createSettingsStore(file: JsonFile<SettingsDocument>, issuer: string): SettingsStore {
  const isIssuerHttp = new URL(issuer).protocol === 'http:';
  const httpRedirects = (): HttpRedirectSetting => {
    const chosen = file.read().allowHttpRedirectUris;
    return { isAllowed: chosen ?? isIssuerHttp, isSet: chosen !== undefined, isIssuerHttp };
  };
  return {
    httpRedirects,
    setHttpRedirects: (isAllowed) => {
      file.update((current) => {
        const { allowHttpRedirectUris: _previous, ...rest } = current;
        return isAllowed === null ? rest : { ...rest, allowHttpRedirectUris: isAllowed };
      });
      return httpRedirects();
    },
  };
}
