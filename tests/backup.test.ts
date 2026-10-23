import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { SecretKeys } from '../server/core/secret-box.ts';
import { openServices, type Services } from '../server/core/services.ts';
import { openDatabase } from '../server/db/client.ts';
import { AuditType } from '../server/store/audit.ts';
import { newSecretKey, newSecretKeys, tempDir } from './helpers.ts';
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
 * Reads an archive the CLI wrote.
 *
 * @param file - The archive.
 * @returns Its document.
 */
function unzip(file: string): { includesSessions: boolean } {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
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

describe('the backup CLI', () => {
  it(
    'exports one data directory and restores it into another',
    async () => {
      const key = newSecretKey();
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
      const wrongKey = newSecretKey().toString('base64');
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

  it(
    'takes the provider sessions with --sessions, and refuses a flag or a missing file with its usage',
    async () => {
      const secretKeys = newSecretKeys();
      const dataDir = tempDir();
      await withDataDir(dataDir, secretKeys, async () => {});
      const SECRET_KEY = secretKeys.current.toString('base64');
      const plain = path.join(tempDir(), 'plain.json.gz');
      const withSessions = path.join(tempDir(), 'sessions.json.gz');

      expect(run(['export', plain], { DATA_DIR: dataDir, SECRET_KEY }).status).toBe(0);
      expect(run(['export', withSessions, '--sessions'], { DATA_DIR: dataDir, SECRET_KEY }).status).toBe(0);
      expect(unzip(plain).includesSessions).toBe(false);
      expect(unzip(withSessions).includesSessions).toBe(true);

      const usage = /Usage:/;
      for (const args of [['restore', plain, '--sessions'], ['export', plain, '--everything'], ['export']]) {
        const refused = run(args, { DATA_DIR: dataDir, SECRET_KEY });
        expect(refused.status).toBe(1);
        expect(refused.output).toMatch(usage);
      }
    },
    CLI_TIMEOUT_MS,
  );
});
