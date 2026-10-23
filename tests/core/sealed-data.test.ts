import { eq } from 'drizzle-orm';
import {
  createSecretBox,
  isSealed,
  type SecretBox,
  SecretKeyErrorCode,
  type SecretKeys,
} from '../../server/core/secret-box.ts';
import { openServices, type Services } from '../../server/core/services.ts';
import type { Database, OpenDatabase } from '../../server/db/client.ts';
import { createWriteQueue, openDocument } from '../../server/db/document.ts';
import { DOCUMENT_NAMES, KEYS_DOCUMENT } from '../../server/db/documents.ts';
import { clients, documents, totpFactors, upstreams } from '../../server/db/schema.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { UpstreamKind } from '../../server/store/upstreams.ts';
import { createTestDatabase } from '../db.ts';
import { createTestUser, newSecretKey, newSecretKeys, startTestApp } from '../helpers.ts';
import { payloadOf, REDIRECT_URI, signInForTokens } from '../oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const UPSTREAM_SECRET = 'g-secret';

/** The two sealed stores besides clients, keys and mail, and how to seal each one's secret under another key. */
const OTHER_SEALED_STORES: { store: string; reseal: (db: Database, box: SecretBox) => Promise<unknown> }[] = [
  {
    store: 'second factors',
    reseal: async (db, box) => db.update(totpFactors).set({ secret: box.seal(TOTP_SECRET) }),
  },
  {
    store: 'upstream providers',
    reseal: async (db, box) => db.update(upstreams).set({ clientSecret: box.seal(UPSTREAM_SECRET) }),
  },
];

/**
 * Opens the services on a database, as a boot does, and waits for what the boot writes.
 *
 * @param db - The database.
 * @param [current] - The sealing key, or null for none.
 * @param [previous] - The key before it.
 * @returns The services.
 */
async function boot(db: Database, current: Buffer | null = null, previous: Buffer | null = null): Promise<Services> {
  const secretKeys: SecretKeys | null = current === null ? null : { current, previous };
  const services = await openServices({ database: db, issuer: ISSUER, isProxied: false, secretKeys });
  await services.settled();
  return services;
}

/**
 * Reads the stored clients and keys, which hold secrets, as the database has them.
 *
 * @param db - The database.
 * @returns Their rows, as JSON.
 */
async function storedSecrets(db: Database): Promise<string> {
  const clientRows = await db.select().from(clients);
  const keyRows = await db.select().from(documents).where(eq(documents.name, DOCUMENT_NAMES.keys));
  return JSON.stringify({ clientRows, keyRows });
}

/**
 * Reads the secrets the clients and keys hold, as the database has them: client secrets, private halves and cookie
 * keys.
 *
 * @param db - The database.
 * @returns The values, sealed or plain.
 */
async function storedSecretValues(db: Database): Promise<string[]> {
  const clientRows = await db.select().from(clients);
  const keys = (await openDocument({ db, queue: createWriteQueue() }, KEYS_DOCUMENT)).read();
  return [
    ...clientRows.map((row) => row.clientSecret ?? ''),
    ...(keys?.jwks.map((jwk) => jwk.d ?? '') ?? []),
    ...(keys?.cookieKeys ?? []),
  ];
}

/**
 * Adds a confidential client and waits for it to be saved.
 *
 * @param services - The services.
 * @returns The client.
 */
async function addClient(services: Services) {
  const client = await services.clients.create({
    name: 'App',
    authMethod: ClientAuthMethod.SecretBasic,
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
  });
  await services.settled();
  return client;
}

describe('secrets at rest', () => {
  let database: OpenDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(() => database.close());

  it('keeps plain text without a key, then seals it on the first boot with one', async () => {
    const { db } = database;
    const plain = await boot(db);
    const secret = (await addClient(plain)).clientSecret ?? '';
    const privateHalf = plain.keys.current().jwks[0]?.d ?? '';
    const cookieKey = plain.keys.current().cookieKeys[0] ?? '';
    expect(await storedSecrets(db)).toContain(secret);
    expect((await storedSecretValues(db)).some(isSealed)).toBe(false);

    const sealed = await boot(db, newSecretKey());
    const stored = await storedSecrets(db);
    for (const value of [secret, privateHalf, cookieKey]) {
      expect(stored).not.toContain(value);
    }
    expect((await storedSecretValues(db)).every(isSealed)).toBe(true);
    expect(sealed.clients.list()[0]?.clientSecret).toBe(secret);
    expect(sealed.keys.current().jwks[0]?.d).toBe(privateHalf);
    expect(sealed.keys.current().cookieKeys[0]).toBe(cookieKey);
  });

  it('refuses a wrong key, or no key, without changing the stored data', async () => {
    const { db } = database;
    await addClient(await boot(db, newSecretKey()));
    const before = await storedSecrets(db);
    await expect(boot(db, newSecretKey())).rejects.toMatchObject({ code: SecretKeyErrorCode.Wrong });
    await expect(boot(db)).rejects.toMatchObject({ code: SecretKeyErrorCode.Missing });
    expect(await storedSecrets(db)).toBe(before);
  });

  it.each(OTHER_SEALED_STORES)(
    'refuses a key that does not open the $store, without changing them',
    async ({ reseal }) => {
      const { db } = database;
      const key = newSecretKey();
      const services = await boot(db, key);
      await services.factors.setTotp('u1', TOTP_SECRET, 0);
      await services.upstreams.create({
        id: 'google',
        name: 'Google',
        kind: UpstreamKind.Oidc,
        issuer: 'https://accounts.google.com/',
        clientId: 'id.apps.googleusercontent.com',
        clientSecret: UPSTREAM_SECRET,
      });
      await services.settled();
      await reseal(db, createSecretBox(newSecretKeys()));
      /**
       * Reads the second factors and upstream providers as the database has them.
       *
       * @returns Their rows, as JSON.
       */
      const storedRows = async (): Promise<string> =>
        JSON.stringify([await db.select().from(totpFactors), await db.select().from(upstreams)]);
      const before = await storedRows();
      await expect(boot(db, key)).rejects.toMatchObject({ code: SecretKeyErrorCode.Wrong });
      expect(await storedRows()).toBe(before);
    },
  );

  it('re-seals under a new key while the old one is the previous key', async () => {
    const { db } = database;
    const old = newSecretKey();
    const { clientSecret } = await addClient(await boot(db, old));
    const next = newSecretKey();
    await boot(db, next, old);
    expect((await boot(db, next)).clients.list()[0]?.clientSecret).toBe(clientSecret);
    await expect(boot(db, old)).rejects.toMatchObject({ code: SecretKeyErrorCode.Wrong });
  });

  it('signs a user in with sealed keys and secrets, and writes new secrets sealed', async () => {
    const app = await startTestApp({ secretKeys: newSecretKeys() });
    try {
      await createTestUser(app, { username: 'ada' });
      const client = await app.services.clients.rotateSecret((await addClient(app.services)).clientId);
      await app.services.keys.rotate();
      app.services.host.refresh();
      const tokens = await signInForTokens(app, client, 'ada');
      expect(payloadOf(tokens.id_token).sub).toEqual(expect.any(String));
      await app.services.settled();
      const stored = await storedSecrets(app.services.db);
      expect(stored).not.toContain(client.clientSecret ?? '');
      for (const jwk of app.services.keys.current().jwks) {
        expect(stored).not.toContain(jwk.d ?? '');
      }
    } finally {
      await app.close();
    }
  });
});
