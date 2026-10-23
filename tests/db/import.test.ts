import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDataSet } from '../../server/db/data-set.ts';
import { createWriteQueue } from '../../server/db/document.ts';
import { archivePathOf, DOCUMENT_NAMES } from '../../server/db/documents.ts';
import { IMPORTED_DIRECTORY, importDataDirectory, isUnstarted, readDataDirectory } from '../../server/db/import.ts';
import { auditEntries, oidcModels, users } from '../../server/db/schema.ts';
import { AUDIT_FILE, AuditType } from '../../server/store/audit.ts';
import { BackupErrorCode } from '../../server/store/backup.ts';
import { adminGql, signInAsAdmin } from '../browser.ts';
import { createTestDatabase } from '../db.ts';
import { startTestApp, tempDir } from '../helpers.ts';

/** A users file as a version before the database wrote it: the claims, disabled and picture fields came later. */
const OLDER_USERS = [
  {
    id: 'u-ada',
    username: 'ada',
    passwordHash: '',
    email: 'ada@example.com',
    name: 'Ada',
    groups: ['heautou-admin'],
    createdAt: '2025-01-01T00:00:00.000Z',
  },
];

/** A keys file: the server only needs it to be there, and this one is plain. */
const OLDER_KEYS = { jwks: [], cookieKeys: ['cookie-key'], rotatedAt: '2025-01-01T00:00:00.000Z' };

/**
 * Writes a JSON lines audit file.
 *
 * @param ids - The entries' ids, oldest first.
 * @returns The file's text.
 */
function auditLines(...ids: string[]): string {
  return ids
    .map(
      (id, index) =>
        `${JSON.stringify({ id, at: new Date(index).toISOString(), type: AuditType.WebSignedIn, actor: null, ip: null })}\n`,
    )
    .join('');
}

/**
 * Writes a data file under a directory.
 *
 * @param dir - The data directory.
 * @param relative - Its path under it.
 * @param contents - What it holds: text, or a value written as JSON.
 */
function writeDataFile(dir: string, relative: string, contents: unknown): void {
  const file = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

describe('importing an older data directory', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads an older data directory, dropping audit lines a crash cut short and refusing a JSON file that does not parse', () => {
    mkdirSync(path.join(dataDir, 'pg'));
    writeFileSync(path.join(dataDir, 'pg', 'ignored.json'), '{');
    writeFileSync(path.join(dataDir, 'notes.txt'), 'not data');
    writeFileSync(path.join(dataDir, AUDIT_FILE), '{"id":"1","at":"x","type":"t"}\n{"id":"2",\n');
    expect(readDataDirectory(dataDir, ['pg'])).toEqual({ [AUDIT_FILE]: '{"id":"1","at":"x","type":"t"}\n' });

    writeFileSync(path.join(dataDir, archivePathOf(DOCUMENT_NAMES.users)), '[{');
    expect(() => readDataDirectory(dataDir, ['pg'])).toThrow(
      expect.objectContaining({ code: BackupErrorCode.BadFile }),
    );
  });

  it('puts every file in the tables once, and moves the files aside', async () => {
    writeDataFile(dataDir, 'users.json', OLDER_USERS);
    writeDataFile(dataDir, 'keys.json', OLDER_KEYS);
    writeDataFile(dataDir, 'audit.2.jsonl', auditLines('oldest'));
    writeDataFile(dataDir, 'audit.1.jsonl', auditLines('older'));
    writeDataFile(dataDir, AUDIT_FILE, auditLines('newest'));
    writeDataFile(dataDir, 'oidc/Session.json', { s1: { payload: { accountId: 'u-ada' }, expiresAt: null } });
    const database = await createTestDatabase();
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });

    expect(await isUnstarted(database.db)).toBe(true);
    const imported = await importDataDirectory(dataSet, dataDir, true);
    expect(imported?.files).toBe(6);
    expect(await isUnstarted(database.db)).toBe(false);
    expect((await database.db.select().from(users)).map((row) => row.username)).toEqual(['ada']);
    expect((await database.db.select().from(oidcModels)).map((row) => row.id)).toEqual(['s1']);
    const audit = await database.db.select().from(auditEntries).orderBy(auditEntries.seq);
    expect(audit.map((row) => row.id)).toEqual(['oldest', 'older', 'newest']);
    expect(existsSync(path.join(dataDir, 'users.json'))).toBe(false);
    expect(existsSync(path.join(dataDir, IMPORTED_DIRECTORY, 'users.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, IMPORTED_DIRECTORY, 'oidc', 'Session.json'))).toBe(true);

    expect(await importDataDirectory(dataSet, dataDir, await isUnstarted(database.db))).toBeNull();
    await database.close();
  });

  it('lets the server start on what it imported', async () => {
    writeDataFile(dataDir, 'users.json', OLDER_USERS);
    writeDataFile(dataDir, 'keys.json', OLDER_KEYS);
    const database = await createTestDatabase();
    await importDataDirectory(createDataSet({ db: database.db, queue: createWriteQueue() }), dataDir, true);
    const app = await startTestApp({ database });
    expect(app.services.users.list().map((user) => user.username)).toEqual(['ada']);
    expect(app.services.users.find('u-ada')?.claims).toEqual({});
    await app.close();
    await database.close();
  });

  it('keeps the web sessions an older directory held as admin-sessions.json', async () => {
    const tokenHash = createHash('sha256').update('older-token').digest('base64url');
    writeDataFile(dataDir, 'users.json', OLDER_USERS);
    writeDataFile(dataDir, 'keys.json', OLDER_KEYS);
    writeDataFile(dataDir, 'admin-sessions.json', { [tokenHash]: { userId: 'u-ada', expiresAt: Date.now() + 60_000 } });
    const database = await createTestDatabase();
    const imported = await importDataDirectory(
      createDataSet({ db: database.db, queue: createWriteQueue() }),
      dataDir,
      true,
    );
    expect(imported?.files).toBe(3);
    expect(existsSync(path.join(dataDir, IMPORTED_DIRECTORY, 'admin-sessions.json'))).toBe(true);
    const app = await startTestApp({ database });
    expect(app.services.webSessions.find('older-token')).toBe('u-ada');
    await app.close();
    await database.close();
  });

  it('imports nothing from a directory a server never started in', async () => {
    writeDataFile(dataDir, 'users.json', OLDER_USERS);
    const database = await createTestDatabase();
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });
    expect(await importDataDirectory(dataSet, dataDir, true)).toBeNull();
    expect(existsSync(path.join(dataDir, 'users.json'))).toBe(true);
    await database.close();
  });

  it('stops, writing and moving nothing, at a file that is not JSON', async () => {
    writeDataFile(dataDir, 'users.json', '[{ torn');
    writeDataFile(dataDir, 'keys.json', OLDER_KEYS);
    const database = await createTestDatabase();
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });
    await expect(importDataDirectory(dataSet, dataDir, true)).rejects.toThrow('users.json');
    expect(await isUnstarted(database.db)).toBe(true);
    expect(existsSync(path.join(dataDir, 'users.json'))).toBe(true);
    await database.close();
  });
});

describe('the admin API over imported data', () => {
  it('lists the imported users through the generated reads', async () => {
    const dataDir = tempDir();
    writeDataFile(dataDir, 'users.json', OLDER_USERS);
    writeDataFile(dataDir, 'keys.json', OLDER_KEYS);
    const database = await createTestDatabase();
    await importDataDirectory(createDataSet({ db: database.db, queue: createWriteQueue() }), dataDir, true);
    const app = await startTestApp({ database });
    const admin = await signInAsAdmin(app);
    const reply = await adminGql(admin, '{ users { username claims disabled } }');
    expect(reply.data.users).toEqual(expect.arrayContaining([{ username: 'ada', claims: {}, disabled: false }]));
    await app.close();
    await database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
