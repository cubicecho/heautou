import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDataSet } from '../../server/db/data-set.ts';
import { createWriteQueue } from '../../server/db/document.ts';
import { DOCUMENT_NAMES } from '../../server/db/documents.ts';
import { IMPORTED_DIRECTORY, importDataDirectory, isUnstarted } from '../../server/db/import.ts';
import { auditEntries, oidcModels, users } from '../../server/db/schema.ts';
import { AUDIT_FILE, AuditType } from '../../server/store/audit.ts';
import { BACKUP_LAYOUT } from '../../server/store/backup.ts';
import { createTestDatabase } from '../db.ts';
import { startTestApp, type TestApp, tempDir } from '../helpers.ts';
import { adminGql, signInAsAdmin } from '../oidc/browser.ts';

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

describe('data set', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp();
    await signInAsAdmin(app);
  });

  afterEach(() => app.close());

  it('puts back exactly what it wrote out, in another database', async () => {
    const options = { includeSessions: true, skipped: [] };
    const files = await app.services.dataSet.exportFiles(options);
    const target = await createTestDatabase();
    const copy = createDataSet({ db: target.db, queue: createWriteQueue() });
    await copy.replaceAll(files);
    expect(await copy.exportFiles(options)).toEqual(files);
    await target.close();
  });

  it('leaves out skipped files, untouched documents, and the provider sessions unless asked', async () => {
    const without = await app.services.dataSet.exportFiles({ includeSessions: false, skipped: BACKUP_LAYOUT.skipped });
    expect(Object.keys(without)).toEqual(
      expect.arrayContaining([DOCUMENT_NAMES.users, DOCUMENT_NAMES.keys, AUDIT_FILE]),
    );
    expect(without).not.toHaveProperty(DOCUMENT_NAMES.webSessions);
    expect(without).not.toHaveProperty(DOCUMENT_NAMES.branding);
    expect(Object.keys(without).some((file) => file.startsWith('oidc/'))).toBe(false);

    const withSessions = await app.services.dataSet.exportFiles({ includeSessions: true, skipped: [] });
    expect(Object.keys(withSessions).some((file) => file.startsWith('oidc/'))).toBe(true);
    expect(withSessions).toHaveProperty(DOCUMENT_NAMES.webSessions);
  });

  it('changes nothing when a file is not JSON', async () => {
    const files = await app.services.dataSet.exportFiles({ includeSessions: true, skipped: [] });
    const before = await app.services.db.select().from(users);
    const damaged = { ...files, [DOCUMENT_NAMES.clients]: '{ not json' };
    await expect(app.services.dataSet.replaceAll(damaged)).rejects.toThrow(DOCUMENT_NAMES.clients);
    expect(await app.services.db.select().from(users)).toEqual(before);
  });
});

describe('importing an older data directory', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('puts every file in the tables once, and moves the files aside', async () => {
    writeDataFile(dataDir, DOCUMENT_NAMES.users, OLDER_USERS);
    writeDataFile(dataDir, DOCUMENT_NAMES.keys, OLDER_KEYS);
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
    expect(existsSync(path.join(dataDir, DOCUMENT_NAMES.users))).toBe(false);
    expect(existsSync(path.join(dataDir, IMPORTED_DIRECTORY, DOCUMENT_NAMES.users))).toBe(true);
    expect(existsSync(path.join(dataDir, IMPORTED_DIRECTORY, 'oidc', 'Session.json'))).toBe(true);

    expect(await importDataDirectory(dataSet, dataDir, await isUnstarted(database.db))).toBeNull();
    await database.close();
  });

  it('lets the server start on what it imported', async () => {
    writeDataFile(dataDir, DOCUMENT_NAMES.users, OLDER_USERS);
    writeDataFile(dataDir, DOCUMENT_NAMES.keys, OLDER_KEYS);
    const database = await createTestDatabase();
    await importDataDirectory(createDataSet({ db: database.db, queue: createWriteQueue() }), dataDir, true);
    const app = await startTestApp({ database });
    expect(app.services.users.list().map((user) => user.username)).toEqual(['ada']);
    expect(app.services.users.find('u-ada')?.claims).toEqual({});
    await app.close();
    await database.close();
  });

  it('imports nothing from a directory a server never started in', async () => {
    writeDataFile(dataDir, DOCUMENT_NAMES.users, OLDER_USERS);
    const database = await createTestDatabase();
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });
    expect(await importDataDirectory(dataSet, dataDir, true)).toBeNull();
    expect(existsSync(path.join(dataDir, DOCUMENT_NAMES.users))).toBe(true);
    await database.close();
  });

  it('stops, writing and moving nothing, at a file that is not JSON', async () => {
    writeDataFile(dataDir, DOCUMENT_NAMES.users, '[{ torn');
    writeDataFile(dataDir, DOCUMENT_NAMES.keys, OLDER_KEYS);
    const database = await createTestDatabase();
    const dataSet = createDataSet({ db: database.db, queue: createWriteQueue() });
    await expect(importDataDirectory(dataSet, dataDir, true)).rejects.toThrow(DOCUMENT_NAMES.users);
    expect(await isUnstarted(database.db)).toBe(true);
    expect(existsSync(path.join(dataDir, DOCUMENT_NAMES.users))).toBe(true);
    await database.close();
  });
});

describe('the admin API over imported data', () => {
  it('lists the imported users through the generated reads', async () => {
    const dataDir = tempDir();
    writeDataFile(dataDir, DOCUMENT_NAMES.users, OLDER_USERS);
    writeDataFile(dataDir, DOCUMENT_NAMES.keys, OLDER_KEYS);
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
