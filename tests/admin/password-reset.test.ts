import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { type AdminPasswordReset, AdminPasswordResetOutcome } from '../../server/admin/password-reset.ts';
import { adminPasswordReset } from '../../server/core/config.ts';
import { ADMIN_DEFAULTS } from '../../server/core/defaults.ts';
import { openServices, type Services } from '../../server/core/services.ts';
import type { OpenDatabase } from '../../server/db/client.ts';
import { AuditType } from '../../server/store/audit.ts';
import { PASSWORD } from '../browser.ts';
import { createTestDatabase } from '../db.ts';
import { createTestUser, tempDir, UNSERVED_ISSUER } from '../helpers.ts';

const NEW_PASSWORD = 'violet marmot lantern 42';
const OTHER_PASSWORD = 'amber heron compass 17';
const ADMIN = { username: 'root', groups: [ADMIN_DEFAULTS.group] };

/**
 * Opens the services on a database, as a boot does, with a reset from the environment.
 *
 * @param database - The database.
 * @param [reset] - The reset, or null for none.
 * @returns The services, once what the boot wrote is saved.
 */
async function boot(database: OpenDatabase, reset: AdminPasswordReset | null = null): Promise<Services> {
  const services = await openServices({
    database: database.db,
    issuer: UNSERVED_ISSUER,
    isProxied: false,
    adminPasswordReset: reset,
  });
  await services.settled();
  return services;
}

describe('resetting an admin password from the environment', () => {
  it('does nothing without one', async () => {
    const database = await createTestDatabase();
    expect((await boot(database)).adminPasswordReset).toBeNull();
  });

  it('sets the only admin password, cancels their links and audits it with no actor', async () => {
    const database = await createTestDatabase();
    const first = await boot(database);
    const admin = await createTestUser({ services: first }, ADMIN);
    const link = await first.passwordLinks.issue(admin.id);
    await first.settled();

    const services = await boot(database, { username: null, password: NEW_PASSWORD });
    expect(services.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.Reset);
    expect(await services.users.authenticate('root', NEW_PASSWORD)).not.toBeNull();
    expect(await services.users.authenticate('root', PASSWORD)).toBeNull();
    expect(services.passwordLinks.find(link.token)).toBeNull();
    const { entries } = await services.audit.list({ types: [AuditType.UserPasswordSet] });
    expect(entries).toEqual([
      expect.objectContaining({
        actor: null,
        target: expect.objectContaining({ id: admin.id }),
        detail: { via: 'environment' },
      }),
    ]);
    expect(services.adminPasswordReset?.message).not.toContain(NEW_PASSWORD);
  });

  it('is used once: a later boot with the same reset keeps the password the admin chose since', async () => {
    const database = await createTestDatabase();
    const admin = await createTestUser({ services: await boot(database) }, ADMIN);
    const reset = { username: null, password: NEW_PASSWORD };
    const afterReset = await boot(database, reset);
    await afterReset.users.setPassword(admin.id, OTHER_PASSWORD);

    const again = await boot(database, reset);
    expect(again.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.AlreadyUsed);
    expect(await again.users.authenticate('root', OTHER_PASSWORD)).not.toBeNull();

    const different = await boot(database, { username: null, password: 'silver otter beacon 88' });
    expect(different.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.Reset);
  });

  it('stays used after a restore, which leaves its marker alone', async () => {
    const database = await createTestDatabase();
    const first = await boot(database);
    await createTestUser({ services: first }, ADMIN);
    const archive = await first.backup.create({ includeSessions: false });
    const reset = { username: null, password: NEW_PASSWORD };
    const afterReset = await boot(database, reset);
    await afterReset.backup.restore(archive);

    const again = await boot(database, reset);
    expect(again.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.AlreadyUsed);
    expect(await again.users.authenticate('root', PASSWORD)).not.toBeNull();
  });

  it('needs the username when there are several admins', async () => {
    const database = await createTestDatabase();
    const first = await boot(database);
    await createTestUser({ services: first }, ADMIN);
    await createTestUser({ services: first }, { username: 'second', groups: [ADMIN_DEFAULTS.group] });

    const unnamed = await boot(database, { username: null, password: NEW_PASSWORD });
    expect(unnamed.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.SeveralAdmins);
    expect(await unnamed.users.authenticate('root', PASSWORD)).not.toBeNull();

    const named = await boot(database, { username: 'second', password: NEW_PASSWORD });
    expect(named.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.Reset);
    expect(await named.users.authenticate('second', NEW_PASSWORD)).not.toBeNull();
    expect(await named.users.authenticate('root', PASSWORD)).not.toBeNull();
  });

  it('refuses a user who is not an admin, and a server with no admin', async () => {
    const database = await createTestDatabase();
    await createTestUser({ services: await boot(database) }, { username: 'alice' });

    const notAdmin = await boot(database, { username: 'alice', password: NEW_PASSWORD });
    expect(notAdmin.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.NotAnAdmin);
    expect(await notAdmin.users.authenticate('alice', PASSWORD)).not.toBeNull();

    const noAdmin = await boot(database, { username: null, password: NEW_PASSWORD });
    expect(noAdmin.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.NoAdmin);
  });

  it('holds the password to the password rules, and a refused one can be fixed on the next boot', async () => {
    const database = await createTestDatabase();
    await createTestUser({ services: await boot(database) }, ADMIN);

    const weak = await boot(database, { username: null, password: 'password' });
    expect(weak.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.Refused);
    expect(await weak.users.authenticate('root', PASSWORD)).not.toBeNull();

    const strong = await boot(database, { username: null, password: NEW_PASSWORD });
    expect(strong.adminPasswordReset?.outcome).toBe(AdminPasswordResetOutcome.Reset);
  });
});

describe('the admin password reset variables', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('RESET_ADMIN_PASSWORD', '');
    vi.stubEnv('RESET_ADMIN_PASSWORD_FILE', '');
    vi.stubEnv('RESET_ADMIN_USERNAME', '');
  });

  it('are off without a password', () => {
    vi.stubEnv('RESET_ADMIN_USERNAME', 'root');
    expect(adminPasswordReset()).toBeNull();
  });

  it('read the password, or the file its _FILE form names, and the username', () => {
    vi.stubEnv('RESET_ADMIN_PASSWORD', NEW_PASSWORD);
    expect(adminPasswordReset()).toEqual({ username: null, password: NEW_PASSWORD });

    const file = path.join(tempDir(), 'reset');
    writeFileSync(file, `${OTHER_PASSWORD}\n`);
    vi.stubEnv('RESET_ADMIN_PASSWORD_FILE', file);
    vi.stubEnv('RESET_ADMIN_USERNAME', ' root ');
    expect(adminPasswordReset()).toEqual({ username: 'root', password: OTHER_PASSWORD });
  });
});
