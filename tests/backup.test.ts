import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_KEY_BYTES } from '../server/core/secret-box.ts';
import { openServices } from '../server/core/services.ts';
import { AuditType } from '../server/store/audit.ts';
import { tempDir } from './helpers.ts';
import { PASSWORD } from './oidc/browser.ts';

const ISSUER = 'http://127.0.0.1:1/oidc';
const CLI = fileURLToPath(new URL('../server/backup.ts', import.meta.url));

/**
 * Runs the backup CLI.
 *
 * @param args - Its arguments.
 * @param env - `DATA_DIR` and `SECRET_KEY`.
 * @returns What it printed, and its exit code.
 */
function run(args: string[], env: Record<string, string>): { output: string; status: number } {
  try {
    const output = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { output, status: 0 };
  } catch (error) {
    const failed = error as { stderr: string; status: number };
    return { output: failed.stderr, status: failed.status };
  }
}

describe('the backup CLI', () => {
  it('exports one data directory and restores it into another', () => {
    const key = randomBytes(SECRET_KEY_BYTES);
    const secretKeys = { current: key, previous: null };
    const source = tempDir();
    openServices({ dataDir: source, issuer: ISSUER, isProxied: false, secretKeys }).users.create({
      username: 'ada',
      password: PASSWORD,
      email: '',
      name: '',
      groups: [],
    });
    const file = path.join(tempDir(), 'backup.json.gz');
    const SECRET_KEY = key.toString('base64');

    expect(run(['export', file], { DATA_DIR: source, SECRET_KEY })).toMatchObject({ status: 0 });

    const target = tempDir();
    openServices({ dataDir: target, issuer: ISSUER, isProxied: false, secretKeys });
    const wrongKey = randomBytes(SECRET_KEY_BYTES).toString('base64');
    const refused = run(['restore', file], { DATA_DIR: target, SECRET_KEY: wrongKey });
    expect(refused.status).toBe(1);
    expect(refused.output).toMatch(/do not open/);

    expect(run(['restore', file], { DATA_DIR: target, SECRET_KEY })).toMatchObject({ status: 0 });
    const restored = openServices({ dataDir: target, issuer: ISSUER, isProxied: false, secretKeys });
    expect(restored.users.list().map((user) => user.username)).toEqual(['ada']);
    expect(restored.audit.list({ types: [AuditType.DataRestored] }).entries[0]?.detail).toMatchObject({ via: 'cli' });

    expect(run(['upload', file], { DATA_DIR: target }).status).toBe(1);
  });
});
