import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_KEY_BYTES, SecretKeyErrorCode, type SecretKeys } from '../../server/core/secret-box.ts';
import { openServices, type Services } from '../../server/core/services.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { startTestApp, tempDir } from '../helpers.ts';
import { PASSWORD, payloadOf, REDIRECT_URI, signInForTokens } from '../oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';
/** What every sealed value starts with. */
const SEALED = 'enc:v1:';

/**
 * Makes a random sealing key.
 *
 * @returns 32 random bytes.
 */
const newKey = (): Buffer => randomBytes(SECRET_KEY_BYTES);

/**
 * Opens the services on a data directory, as a boot does.
 *
 * @param dataDir - The directory.
 * @param [current] - The sealing key, or null for none.
 * @param [previous] - The key before it.
 * @returns The services.
 */
function boot(dataDir: string, current: Buffer | null = null, previous: Buffer | null = null): Services {
  const secretKeys: SecretKeys | null = current === null ? null : { current, previous };
  return openServices({ dataDir, issuer: ISSUER, isProxied: false, secretKeys });
}

/**
 * Reads the two files that hold secrets.
 *
 * @param dataDir - The directory.
 * @returns Their text, joined.
 */
function secretFiles(dataDir: string): string {
  return ['clients.json', 'keys.json'].map((name) => readFileSync(path.join(dataDir, name), 'utf8')).join('\n');
}

/**
 * Adds a confidential client.
 *
 * @param services - The services.
 * @returns The client.
 */
function addClient(services: Services) {
  return services.clients.create({
    name: 'App',
    authMethod: ClientAuthMethod.SecretBasic,
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
  });
}

describe('secrets at rest', () => {
  it('keeps plain text without a key, then seals it on the first boot with one', () => {
    const dataDir = tempDir();
    const plain = boot(dataDir);
    const secret = addClient(plain).clientSecret ?? '';
    const privateHalf = plain.keys.current().jwks[0]?.d ?? '';
    const cookieKey = plain.keys.current().cookieKeys[0] ?? '';
    expect(secretFiles(dataDir)).toContain(secret);
    expect(secretFiles(dataDir)).not.toContain(SEALED);

    const sealed = boot(dataDir, newKey());
    const onDisk = secretFiles(dataDir);
    for (const value of [secret, privateHalf, cookieKey]) {
      expect(onDisk).not.toContain(value);
    }
    expect(onDisk).toContain(SEALED);
    expect(sealed.clients.list()[0]?.clientSecret).toBe(secret);
    expect(sealed.keys.current().jwks[0]?.d).toBe(privateHalf);
    expect(sealed.keys.current().cookieKeys[0]).toBe(cookieKey);
  });

  it('refuses a wrong key, or no key, without changing the files', () => {
    const dataDir = tempDir();
    addClient(boot(dataDir, newKey()));
    const before = secretFiles(dataDir);
    expect(() => boot(dataDir, newKey())).toThrow(expect.objectContaining({ code: SecretKeyErrorCode.Wrong }));
    expect(() => boot(dataDir)).toThrow(expect.objectContaining({ code: SecretKeyErrorCode.Missing }));
    expect(secretFiles(dataDir)).toBe(before);
  });

  it('re-seals under a new key while the old one is the previous key', () => {
    const dataDir = tempDir();
    const old = newKey();
    const secret = addClient(boot(dataDir, old)).clientSecret;
    const next = newKey();
    boot(dataDir, next, old);
    expect(boot(dataDir, next).clients.list()[0]?.clientSecret).toBe(secret);
    expect(() => boot(dataDir, old)).toThrow(expect.objectContaining({ code: SecretKeyErrorCode.Wrong }));
  });

  it('signs a user in with sealed keys and secrets, and writes new secrets sealed', async () => {
    const app = await startTestApp({ secretKeys: { current: newKey(), previous: null } });
    try {
      app.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
      const client = app.services.clients.rotateSecret(addClient(app.services).clientId);
      app.services.keys.rotate();
      app.services.host.refresh();
      const tokens = await signInForTokens(app, client, 'ada');
      expect(payloadOf(tokens.id_token).sub).toEqual(expect.any(String));
      const onDisk = secretFiles(app.dataDir);
      expect(onDisk).not.toContain(client.clientSecret ?? '');
      for (const jwk of app.services.keys.current().jwks) {
        expect(onDisk).not.toContain(jwk.d ?? '');
      }
    } finally {
      await app.close();
    }
  });
});
