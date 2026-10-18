import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BACKUP_DEFAULTS } from '../../server/core/defaults.ts';
import { createSecretBox, SECRET_KEY_BYTES, type SecretKeys } from '../../server/core/secret-box.ts';
import { BACKUP_LAYOUT, openServices, type Services } from '../../server/core/services.ts';
import { AuditType, userTarget } from '../../server/store/audit.ts';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  type BackupArchive,
  BackupErrorCode,
  createBackup,
  listDataFiles,
  readBackup,
  restoreBackup,
} from '../../server/store/backup.ts';
import { ClientAuthMethod } from '../../server/store/clients.ts';
import { tempDir } from '../helpers.ts';
import { PASSWORD, REDIRECT_URI } from '../oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';

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
 * Boots a data directory with a user, a confidential client, a web session and a provider session in it.
 *
 * @param [key] - The sealing key.
 * @returns The directory, its services, and what was made.
 */
function populated(key: Buffer | null = null) {
  const dataDir = tempDir();
  const services = boot(dataDir, key);
  const user = services.users.create({ username: 'ada', password: PASSWORD, email: '', name: 'Ada', groups: ['ops'] });
  const client = services.clients.create({
    name: 'App',
    authMethod: ClientAuthMethod.SecretBasic,
    redirectUris: [REDIRECT_URI],
    postLogoutRedirectUris: [],
  });
  const webSession = services.adminSessions.create(user.id);
  services.audit.record({ type: AuditType.UserCreated, actor: null, ip: null, target: userTarget(user) });
  // A file the provider writes, standing in for its sessions and tokens.
  mkdirSync(path.join(dataDir, 'oidc'), { recursive: true });
  writeFileSync(path.join(dataDir, 'oidc', 'Session.json'), '{}\n');
  return { dataDir, services, user, client, webSession };
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
 * Makes an archive of a fresh data directory, then changes its document.
 *
 * @param change - Changes the unzipped document.
 * @returns The gzipped bytes.
 */
function alteredArchive(change: (archive: BackupArchive) => unknown): Buffer {
  const { dataDir } = populated();
  return zip(change(unzip(createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: false }))));
}

/**
 * Says what a refused archive is refused for.
 *
 * @param run - Reads or restores an archive.
 * @returns The error's code.
 */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('The archive was not refused.');
}

describe('backups', () => {
  it('takes every data file as it is on disk, leaving out web sessions and, unless asked, provider sessions', () => {
    const key = newKey();
    const { dataDir } = populated(key);
    writeFileSync(path.join(dataDir, 'a-later-store.json'), '{"kept":true}\n');
    writeFileSync(path.join(dataDir, 'notes.txt'), 'not data');

    const without = unzip(createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: false }));
    expect(without).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, includesSessions: false });
    expect(Object.keys(without.files)).toEqual(
      expect.arrayContaining(['clients.json', 'users.json', 'keys.json', 'audit.jsonl', 'a-later-store.json']),
    );
    expect(Object.keys(without.files)).not.toContain('admin-sessions.json');
    expect(Object.keys(without.files)).not.toContain('notes.txt');
    expect(Object.keys(without.files).some((name) => name.startsWith('oidc/'))).toBe(false);
    expect(without.files['clients.json']).toBe(readFileSync(path.join(dataDir, 'clients.json'), 'utf8'));
    expect(without.files['keys.json']).toContain('enc:v1:');

    const withSessions = unzip(createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: true }));
    expect(withSessions.files['oidc/Session.json']).toBe('{}\n');
  });

  it('drops audit lines a crash cut short, and refuses a JSON file that does not parse', () => {
    const { dataDir } = populated();
    writeFileSync(path.join(dataDir, 'audit.jsonl'), '{"id":"1","at":"x","type":"t"}\n{"id":"2",\n');
    const archive = unzip(createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: false }));
    expect(archive.files['audit.jsonl']).toBe('{"id":"1","at":"x","type":"t"}\n');

    writeFileSync(path.join(dataDir, 'users.json'), '[{');
    expect(refusal(() => createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: false }))).toBe(
      BackupErrorCode.BadFile,
    );
  });

  it('round trips through a restore into a running server, signing everyone out', () => {
    const key = newKey();
    const source = populated(key);
    const apiIdentifier = 'https://photos-api.home.lan';
    source.services.apis.create({
      identifier: apiIdentifier,
      name: 'Photos API',
      allowedClientIds: [source.client.clientId],
    });
    const archive = createBackup(source.dataDir, BACKUP_LAYOUT, { includeSessions: true });
    const sourceKids = source.services.keys.current().jwks.map((jwk) => jwk.kid);

    const target = populated(key);
    target.services.users.create({ username: 'later', password: PASSWORD, email: '', name: '', groups: [] });
    const restored = target.services.backup.restore(archive);

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
    expect(existsSync(path.join(target.dataDir, 'admin-sessions.json'))).toBe(false);
    expect(existsSync(path.join(target.dataDir, 'oidc', 'Session.json'))).toBe(true);
    // The restored data boots on its own.
    expect(
      boot(target.dataDir, key)
        .users.list()
        .map((user) => user.username),
    ).toEqual(['ada']);
  });

  it('removes the provider sessions when the archive has none', () => {
    const source = populated();
    const archive = createBackup(source.dataDir, BACKUP_LAYOUT, { includeSessions: false });
    const target = populated();
    restoreBackup(target.dataDir, BACKUP_LAYOUT, readBackup(archive, BACKUP_LAYOUT, null));
    expect(listDataFiles(target.dataDir).some((name) => name.startsWith('oidc/'))).toBe(false);
  });

  it('opens secrets sealed under the previous key, and re-seals them under the current one', () => {
    const oldKey = newKey();
    const source = populated(oldKey);
    const archive = createBackup(source.dataDir, BACKUP_LAYOUT, { includeSessions: false });
    const newer = newKey();
    const target = populated(newer);
    const targetServices = boot(target.dataDir, newer, oldKey);
    targetServices.backup.restore(archive);
    expect(targetServices.clients.find(source.client.clientId)?.clientSecret).toBe(source.client.clientSecret);
    // Without the old key now, the data still opens: the restore re-sealed it.
    expect(boot(target.dataDir, newer).clients.find(source.client.clientId)?.clientSecret).toBe(
      source.client.clientSecret,
    );
  });

  it('refuses an archive sealed under another key, or when no key is set, writing nothing', () => {
    const source = populated(newKey());
    const archive = createBackup(source.dataDir, BACKUP_LAYOUT, { includeSessions: false });
    const target = populated(newKey());
    const before = readFileSync(path.join(target.dataDir, 'users.json'), 'utf8');

    expect(refusal(() => target.services.backup.restore(archive))).toBe(BackupErrorCode.WrongKey);
    expect(refusal(() => readBackup(archive, BACKUP_LAYOUT, null))).toBe(BackupErrorCode.WrongKey);
    expect(readFileSync(path.join(target.dataDir, 'users.json'), 'utf8')).toBe(before);
    expect(target.services.users.list().map((user) => user.username)).toEqual(['ada']);
  });

  it('refuses a file that is not an archive, another version, or damaged contents', () => {
    const box = createSecretBox({ current: newKey(), previous: null });
    const read = (archive: Buffer) => () => readBackup(archive, BACKUP_LAYOUT, box);

    expect(refusal(read(Buffer.from('plain text')))).toBe(BackupErrorCode.NotAnArchive);
    expect(refusal(read(gzipSync('not json')))).toBe(BackupErrorCode.NotAnArchive);
    expect(refusal(read(zip({ format: 'something-else', version: 1 })))).toBe(BackupErrorCode.NotAnArchive);
    expect(refusal(read(alteredArchive((archive) => ({ ...archive, version: BACKUP_VERSION + 1 }))))).toBe(
      BackupErrorCode.WrongVersion,
    );
    expect(refusal(read(alteredArchive((archive) => ({ ...archive, files: [] }))))).toBe(BackupErrorCode.NotAnArchive);
    expect(
      refusal(read(alteredArchive((archive) => ({ ...archive, files: { ...archive.files, 'users.json': '[{' } })))),
    ).toBe(BackupErrorCode.BadFile);
    expect(
      refusal(
        read(alteredArchive((archive) => ({ ...archive, files: { ...archive.files, 'audit.jsonl': '{"a":1}\n{' } }))),
      ),
    ).toBe(BackupErrorCode.BadFile);
    expect(
      refusal(read(alteredArchive((archive) => ({ ...archive, files: { ...archive.files, '../escape.json': '{}' } })))),
    ).toBe(BackupErrorCode.BadFile);
    expect(
      refusal(read(alteredArchive((archive) => ({ ...archive, files: { ...archive.files, 'run.sh': 'echo' } })))),
    ).toBe(BackupErrorCode.BadFile);
    expect(
      refusal(
        read(alteredArchive(({ files: { 'keys.json': _keys, ...rest }, ...archive }) => ({ ...archive, files: rest }))),
      ),
    ).toBe(BackupErrorCode.BadFile);
  });

  it('refuses an archive over the size limits', () => {
    const { dataDir } = populated();
    const archive = createBackup(dataDir, BACKUP_LAYOUT, { includeSessions: false });
    const small = { ...BACKUP_DEFAULTS, maxArchiveBytes: archive.length - 1 };
    expect(refusal(() => readBackup(archive, BACKUP_LAYOUT, null, small))).toBe(BackupErrorCode.TooBig);
    const shallow = { ...BACKUP_DEFAULTS, maxUnpackedBytes: 16 };
    expect(refusal(() => readBackup(archive, BACKUP_LAYOUT, null, shallow))).toBe(BackupErrorCode.TooBig);
  });
});
