import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BACKUP_DEFAULTS } from '../../server/core/defaults.ts';
import { createSecretBox, SECRET_KEY_BYTES, type SecretKeys } from '../../server/core/secret-box.ts';
import { BACKUP_LAYOUT, openServices, type Services } from '../../server/core/services.ts';
import type { OpenDatabase } from '../../server/db/client.ts';
import { adminSessions, oidcModels, users } from '../../server/db/schema.ts';
import { AuditType, userTarget } from '../../server/store/audit.ts';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupArchive,
  BackupErrorCode,
  createBackup,
  readBackup,
  readDataDirectory,
} from '../../server/store/backup.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { createTestDatabase } from '../db.ts';
import { tempDir } from '../helpers.ts';
import { PASSWORD, REDIRECT_URI } from '../oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';
/** The provider session each populated database starts with, standing in for its sessions and tokens. */
const PROVIDER_SESSION = { model: 'Session', id: 'session-1', payload: { kind: 'Session' }, expiresAt: null };

/** The databases and services a test opened, settled and handed back after it. */
const opened: { databases: OpenDatabase[]; services: Services[] } = { databases: [], services: [] };

/** How long booting the databases a test needs may take on a busy machine: each one applies every migration. */
const BOOT_TIMEOUT_MS = 60_000;

// Boot the two databases a restore test holds at once before the tests, so no test's own time goes on booting them.
beforeAll(async () => {
  const databases = await Promise.all([createTestDatabase(), createTestDatabase()]);
  await Promise.all(databases.map((database) => database.close()));
}, BOOT_TIMEOUT_MS);

afterEach(async () => {
  await Promise.all(opened.services.map((services) => services.settled()));
  await Promise.all(opened.databases.map((database) => database.close()));
  opened.services = [];
  opened.databases = [];
});

/**
 * Makes a random sealing key.
 *
 * @returns 32 random bytes.
 */
const newKey = (): Buffer => randomBytes(SECRET_KEY_BYTES);

/**
 * Opens the services on a database, as a boot does.
 *
 * @param database - The database.
 * @param [current] - The sealing key, or null for none.
 * @param [previous] - The key before it.
 * @returns The services.
 */
async function boot(
  database: OpenDatabase,
  current: Buffer | null = null,
  previous: Buffer | null = null,
): Promise<Services> {
  const secretKeys: SecretKeys | null = current === null ? null : { current, previous };
  const services = await openServices({ database: database.db, issuer: ISSUER, isProxied: false, secretKeys });
  opened.services.push(services);
  return services;
}

/**
 * Boots an empty database with a user, a confidential client, a web session, a forward auth session, an audit entry
 * and a provider session in it.
 *
 * @param [key] - The sealing key.
 * @returns The database, its services, and what was made.
 */
async function populated(key: Buffer | null = null) {
  const database = await createTestDatabase();
  opened.databases.push(database);
  await database.db.insert(oidcModels).values(PROVIDER_SESSION);
  const services = await boot(database, key);
  const user = await services.users.create({
    username: 'ada',
    password: PASSWORD,
    email: '',
    name: 'Ada',
    groups: ['ops'],
  });
  const client = await services.clients.create({
    name: 'App',
    authMethod: ClientAuthMethod.SecretBasic,
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
  });
  const webSession = await services.adminSessions.create(user.id);
  await services.proxySessions.create({ userId: user.id, grantId: 'grant-1', amr: ['pwd'], acr: 'pwd' });
  services.audit.record({ type: AuditType.UserCreated, actor: null, ip: null, target: userTarget(user) });
  await services.settled();
  return { database, services, user, client, webSession };
}

/**
 * Unzips an archive.
 *
 * @param archive - The gzipped bytes.
 * @returns Its document.
 */
const unzip = (archive: Buffer): BackupArchive => JSON.parse(gunzipSync(archive).toString('utf8'));

/**
 * Zips a document as an archive would be.
 *
 * @param document - Anything.
 * @returns The gzipped bytes.
 */
const zip = (document: unknown): Buffer => gzipSync(JSON.stringify(document));

/**
 * Makes an archive of a fresh database, unzipped, for tests to change.
 *
 * @returns Its document.
 */
async function freshArchive(): Promise<BackupArchive> {
  const { services } = await populated();
  return unzip(await services.backup.create({ includeSessions: false }));
}

/**
 * Says what a refused archive is refused for.
 *
 * @param run - Reads or restores an archive.
 * @returns The error's code.
 */
async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('The archive was not refused.');
}

describe('backups', () => {
  it('takes every store, secrets sealed, leaving out web sessions and, unless asked, provider sessions', async () => {
    const key = newKey();
    const { services, client } = await populated(key);

    const without = unzip(await services.backup.create({ includeSessions: false }));
    expect(without).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, includesSessions: false });
    expect(Object.keys(without.files)).toEqual(
      expect.arrayContaining(['clients.json', 'users.json', 'keys.json', 'audit.jsonl']),
    );
    expect(Object.keys(without.files)).not.toContain('admin-sessions.json');
    expect(Object.keys(without.files)).not.toContain('proxy-sessions.json');
    expect(Object.keys(without.files).some((name) => name.startsWith('oidc/'))).toBe(false);
    expect(without.files['clients.json']).toContain('enc:v1:');
    expect(without.files['clients.json']).not.toContain(client.clientSecret ?? 'no secret');
    expect(without.files['keys.json']).toContain('enc:v1:');
    expect(without.files['audit.jsonl']).toContain(AuditType.UserCreated);

    const withSessions = unzip(await services.backup.create({ includeSessions: true }));
    expect(JSON.parse(withSessions.files['oidc/Session.json'] ?? '{}')).toMatchObject({
      [PROVIDER_SESSION.id]: { payload: PROVIDER_SESSION.payload, expiresAt: null },
    });
  });

  it('builds an archive from the files it is given, and refuses one without the files a server needs', async () => {
    const files = { 'keys.json': '{"jwks":[],"cookieKeys":[]}\n', 'users.json': '[]\n' };
    const archive = unzip(createBackup(files, BACKUP_LAYOUT, { includeSessions: false }, () => 0));
    expect(archive).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: '1970-01-01T00:00:00.000Z',
      includesSessions: false,
      files,
    });
    expect(await refusal(() => createBackup({ 'users.json': '[]\n' }, BACKUP_LAYOUT, { includeSessions: false }))).toBe(
      BackupErrorCode.BadFile,
    );
  });

  it('reads an older data directory, dropping audit lines a crash cut short and refusing a JSON file that does not parse', async () => {
    const dataDir = tempDir();
    mkdirSync(path.join(dataDir, 'pg'));
    writeFileSync(path.join(dataDir, 'pg', 'ignored.json'), '{');
    writeFileSync(path.join(dataDir, 'notes.txt'), 'not data');
    writeFileSync(path.join(dataDir, 'audit.jsonl'), '{"id":"1","at":"x","type":"t"}\n{"id":"2",\n');
    expect(readDataDirectory(dataDir, ['pg'])).toEqual({ 'audit.jsonl': '{"id":"1","at":"x","type":"t"}\n' });

    writeFileSync(path.join(dataDir, 'users.json'), '[{');
    expect(await refusal(() => readDataDirectory(dataDir, ['pg']))).toBe(BackupErrorCode.BadFile);
  });

  it('round trips through a restore into a running server, signing everyone out', async () => {
    const key = newKey();
    const source = await populated(key);
    const apiIdentifier = 'https://photos-api.home.lan';
    await source.services.apis.create({
      identifier: apiIdentifier,
      name: 'Photos API',
      allowedClientIds: [source.client.clientId],
    });
    const archive = await source.services.backup.create({ includeSessions: true });
    const sourceKids = source.services.keys.current().jwks.map((jwk) => jwk.kid);

    const target = await populated(key);
    await target.services.users.create({ username: 'later', password: PASSWORD, email: '', name: '', groups: [] });
    const restored = await target.services.backup.restore(archive);

    expect(restored).toMatchObject({ includesSessions: true });
    expect(target.services.users.list().map((user) => user.username)).toEqual(['ada']);
    const client = target.services.clients.find(source.client.clientId);
    expect(client?.clientSecret).toBe(source.client.clientSecret);
    expect(target.services.apis.find(apiIdentifier)?.allowedClientIds).toEqual([source.client.clientId]);
    expect(target.services.keys.current().jwks.map((jwk) => jwk.kid)).toEqual(sourceKids);
    expect(target.services.host.current().issuer).toBe(ISSUER);
    // Neither the target's own web sessions nor the source's come back.
    expect(target.services.adminSessions.find(target.webSession)).toBeNull();
    expect(target.services.adminSessions.find(source.webSession)).toBeNull();
    expect(await target.database.db.select().from(adminSessions)).toEqual([]);
    expect(await target.database.db.select().from(oidcModels)).toMatchObject([
      { model: PROVIDER_SESSION.model, id: PROVIDER_SESSION.id },
    ]);
    // The restored data boots on its own.
    expect((await boot(target.database, key)).users.list().map((user) => user.username)).toEqual(['ada']);
  });

  it('removes the provider sessions when the archive has none', async () => {
    const source = await populated();
    const archive = await source.services.backup.create({ includeSessions: false });
    const target = await populated();
    await target.services.backup.restore(archive);
    expect(await target.database.db.select().from(oidcModels)).toEqual([]);
  });

  it('opens secrets sealed under the previous key, and re-seals them under the current one', async () => {
    const oldKey = newKey();
    const source = await populated(oldKey);
    const archive = await source.services.backup.create({ includeSessions: false });
    const newer = newKey();
    const target = await populated(newer);
    const targetServices = await boot(target.database, newer, oldKey);
    await targetServices.backup.restore(archive);
    expect(targetServices.clients.find(source.client.clientId)?.clientSecret).toBe(source.client.clientSecret);
    await targetServices.settled();
    // Without the old key now, the data still opens: the restore re-sealed it.
    expect((await boot(target.database, newer)).clients.find(source.client.clientId)?.clientSecret).toBe(
      source.client.clientSecret,
    );
  });

  it('refuses an archive sealed under another key, or when no key is set, writing nothing', async () => {
    const source = await populated(newKey());
    const archive = await source.services.backup.create({ includeSessions: false });
    const target = await populated(newKey());
    const before = await target.database.db.select().from(users);

    expect(await refusal(() => target.services.backup.restore(archive))).toBe(BackupErrorCode.WrongKey);
    expect(await refusal(() => readBackup(archive, BACKUP_LAYOUT, null))).toBe(BackupErrorCode.WrongKey);
    expect(await target.database.db.select().from(users)).toEqual(before);
    expect(target.services.users.list().map((user) => user.username)).toEqual(['ada']);
  });

  it('refuses a file that is not an archive, another version, or damaged contents', async () => {
    const box = createSecretBox({ current: newKey(), previous: null });
    const read = (archive: Buffer) => () => readBackup(archive, BACKUP_LAYOUT, box);
    const fresh = await freshArchive();
    /**
     * Says what the fresh archive is refused for once its document is changed.
     *
     * @param change - Changes a copy of the unzipped document.
     * @returns The error's code.
     */
    const altered = (change: (archive: BackupArchive) => unknown): Promise<string> =>
      refusal(read(zip(change(structuredClone(fresh)))));
    /**
     * Says what the fresh archive is refused for once its files are changed.
     *
     * @param files - The files to add or replace.
     * @returns The error's code.
     */
    const withFiles = (files: Record<string, string>): Promise<string> =>
      altered((archive) => ({ ...archive, files: { ...archive.files, ...files } }));

    expect(read(zip(fresh))()).toMatchObject({ format: BACKUP_FORMAT });
    expect(await refusal(read(Buffer.from('plain text')))).toBe(BackupErrorCode.NotAnArchive);
    expect(await refusal(read(gzipSync('not json')))).toBe(BackupErrorCode.NotAnArchive);
    expect(await refusal(read(zip({ format: 'something-else', version: 1 })))).toBe(BackupErrorCode.NotAnArchive);
    expect(await altered((archive) => ({ ...archive, version: BACKUP_VERSION + 1 }))).toBe(
      BackupErrorCode.WrongVersion,
    );
    expect(await altered((archive) => ({ ...archive, files: [] }))).toBe(BackupErrorCode.NotAnArchive);
    expect(await withFiles({ 'users.json': '[{' })).toBe(BackupErrorCode.BadFile);
    expect(await withFiles({ 'audit.jsonl': '{"a":1}\n{' })).toBe(BackupErrorCode.BadFile);
    expect(await withFiles({ '../escape.json': '{}' })).toBe(BackupErrorCode.BadFile);
    expect(await withFiles({ 'run.sh': 'echo' })).toBe(BackupErrorCode.BadFile);
    expect(
      await altered(({ files: { 'keys.json': _keys, ...rest }, ...archive }) => ({ ...archive, files: rest })),
    ).toBe(BackupErrorCode.BadFile);
  });

  it('refuses an archive over the size limits', async () => {
    const { services } = await populated();
    const archive = await services.backup.create({ includeSessions: false });
    const small = { ...BACKUP_DEFAULTS, maxArchiveBytes: archive.length - 1 };
    expect(await refusal(() => readBackup(archive, BACKUP_LAYOUT, null, small))).toBe(BackupErrorCode.TooBig);
    const shallow = { ...BACKUP_DEFAULTS, maxUnpackedBytes: 16 };
    expect(await refusal(() => readBackup(archive, BACKUP_LAYOUT, null, shallow))).toBe(BackupErrorCode.TooBig);
  });
});
