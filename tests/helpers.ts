import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openServices, type ServiceSettings, type Services } from '../server/core/services.ts';
import type { OpenDatabase } from '../server/db/client.ts';
import { createApp } from '../server/http/app.ts';
import type { NewUser, PublicUser } from '../server/store/users.ts';
import { createTestDatabase } from './db.ts';
import { PASSWORD } from './oidc/browser.ts';

/**
 * Reads the port a test server was given.
 *
 * @param server - A server listening on port 0.
 * @returns The port the OS picked.
 * @throws If the server is not listening on a TCP port.
 */
export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not listening on a TCP port.');
  }
  return address.port;
}

/**
 * Makes an empty directory under the OS temp directory.
 *
 * @returns Its path.
 */
export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'heautou-test-'));
}

/** A running app on its own database. */
export interface TestApp {
  /** `http://127.0.0.1:<port>`. */
  base: string;
  services: Services;
  /** The database its services keep their data in. */
  database: OpenDatabase;
  /** Stops the server, waits for its writes, and hands the database back emptied (unless it was passed in). */
  close: () => Promise<void>;
}

/** What a test app is started with: the services' settings it may change, and the database to use. */
export type TestAppSettings = Pick<
  ServiceSettings,
  | 'now'
  | 'secretKeys'
  | 'fetchRange'
  | 'fetchUpstream'
  | 'fetchPairing'
  | 'mailServer'
  | 'mailTransport'
  | 'objectStorage'
  | 'proxyCookieDomain'
  | 'trustedProxies'
> & {
  /**
   * A database to start on, such as another app's, to start that app again as after a restart. Left out, an empty
   * one; a database passed in is left open when the app closes.
   */
  database?: OpenDatabase;
};

/**
 * Starts the whole app on a random port with an empty database. The issuer is that port's `/oidc`.
 *
 * @param [settings] - Overrides for the services, such as the clock, the secret key, a fake Have I Been Pwned or a fake mail transport, and the database to start on.
 * @returns The running app.
 */
export async function startTestApp(settings: TestAppSettings = {}): Promise<TestApp> {
  const { database: given, ...serviceSettings } = settings;
  const database = given ?? (await createTestDatabase());
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${portOf(server)}`;
  const services = await openServices({
    database: database.db,
    issuer: `${base}/oidc`,
    isProxied: false,
    ...serviceSettings,
  });
  server.on('request', createApp(services));
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.settled();
    if (given === undefined) {
      await database.close();
    }
  };
  return { base, services, database, close };
}

/**
 * Adds a user for a test: with the test password and no email address, name or groups, unless the test says otherwise.
 *
 * @param app - The app, or anything holding its services.
 * @param given - The username, and whatever the test changes. A `password` of '' makes a user without one.
 * @returns The user.
 */
export function createTestUser(
  app: { services: Pick<Services, 'users'> },
  given: Partial<NewUser> & Pick<NewUser, 'username'>,
): Promise<PublicUser> {
  return app.services.users.create({ password: PASSWORD, email: '', name: '', groups: [], ...given });
}
