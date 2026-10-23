import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_KEY_BYTES, type SecretKeys } from '../server/core/secret-box.ts';
import { openServices, type Services } from '../server/core/services.ts';
import { openDatabase } from '../server/db/client.ts';
import { AuditType } from '../server/store/audit.ts';
import { BackupErrorCode } from '../server/store/backup.ts';
import { startTestApp, tempDir } from './helpers.ts';
import { PASSWORD } from './oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';
const CLI = fileURLToPath(new URL('../server/backup.ts', import.meta.url));
/** Booting PGlite in a directory and migrating it, three times over, with the CLI's own boots between. */
const CLI_TIMEOUT_MS = 120_000;

/**
 * Runs the backup CLI.
 *
 * @param args - Its arguments.
 * @param env - `DATA_DIR` and `SECRET_KEY`.
 * @returns What it printed, and its exit code.
 */
function run(args: string[], env: Record<string, string>): { output: string; status: number } {
  const {
    DATABASE_URL: _url,
    DATABASE_URL_FILE: _file,
    SECRET_KEY: _key,
    SECRET_KEY_FILE: _keyFile,
    ...inherited
  } = process.env;
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...inherited, ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { output, status: 0 };
  } catch (error) {
    const failed = error as { stderr: string; status: number };
    return { output: failed.stderr, status: failed.status };
  }
}

/**
 * Opens the services on a data directory's PGlite as the server would, hands them to `use`, and closes the database
 * after, so the CLI may open it.
 *
 * @param dataDir - The data directory.
 * @param secretKeys - The sealing keys.
 * @param use - What to do with the services.
 */
async function withDataDir(
  dataDir: string,
  secretKeys: SecretKeys,
  use: (services: Services) => Promise<void>,
): Promise<void> {
  const database = await openDatabase({ url: '', dataDir, isProduction: false });
  try {
    await database.migrate();
    const services = await openServices({ database: database.db, issuer: ISSUER, isProxied: false, secretKeys });
    await use(services);
    await services.settled();
  } finally {
    await database.close();
  }
}

describe('backups between servers', () => {
  it('exports one server’s data and restores it into another under the same key only', async () => {
    const secretKeys = { current: randomBytes(SECRET_KEY_BYTES), previous: null };
    const source = await startTestApp({ secretKeys });
    const target = await startTestApp({ secretKeys });
    const stranger = await startTestApp({ secretKeys: { current: randomBytes(SECRET_KEY_BYTES), previous: null } });
    try {
      await source.services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
      const archive = await source.services.backup.create({ includeSessions: false });

      await expect(stranger.services.backup.restore(archive)).rejects.toMatchObject({
        code: BackupErrorCode.WrongKey,
      });
      expect(stranger.services.users.list()).toEqual([]);

      expect(await target.services.backup.restore(archive)).toMatchObject({ includesSessions: false });
      expect(target.services.users.list().map((user) => user.username)).toEqual(['ada']);
      expect(await target.services.users.authenticate('ada', PASSWORD)).not.toBeNull();

      // The restored data is in the target's database, so it is there after a restart.
      const restarted = await startTestApp({ database: target.database, secretKeys });
      try {
        expect(restarted.services.users.list().map((user) => user.username)).toEqual(['ada']);
      } finally {
        await restarted.close();
      }
    } finally {
      await stranger.close();
      await target.close();
      await source.close();
    }
  });
});

describe('the backup CLI', () => {
  it(
    'exports one data directory and restores it into another',
    async () => {
      const key = randomBytes(SECRET_KEY_BYTES);
      const secretKeys = { current: key, previous: null };
      const source = tempDir();
      await withDataDir(source, secretKeys, async (services) => {
        await services.users.create({ username: 'ada', password: PASSWORD, email: '', name: '', groups: [] });
      });
      const file = path.join(tempDir(), 'backup.json.gz');
      const SECRET_KEY = key.toString('base64');

      expect(run(['export', file], { DATA_DIR: source, SECRET_KEY })).toMatchObject({ status: 0 });

      const target = tempDir();
      await withDataDir(target, secretKeys, async () => {});
      const wrongKey = randomBytes(SECRET_KEY_BYTES).toString('base64');
      const refused = run(['restore', file], { DATA_DIR: target, SECRET_KEY: wrongKey });
      expect(refused.status).toBe(1);
      expect(refused.output).toMatch(/do not open/);

      expect(run(['restore', file], { DATA_DIR: target, SECRET_KEY })).toMatchObject({ status: 0 });
      await withDataDir(target, secretKeys, async (restored) => {
        expect(restored.users.list().map((user) => user.username)).toEqual(['ada']);
        const { entries } = await restored.audit.list({ types: [AuditType.DataRestored] });
        expect(entries[0]?.detail).toMatchObject({ via: 'cli' });
      });

      expect(run(['upload', file], { DATA_DIR: target }).status).toBe(1);
    },
    CLI_TIMEOUT_MS,
  );
});
