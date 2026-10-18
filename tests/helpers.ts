import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openServices, type ServiceSettings, type Services } from '../server/core/services.ts';
import { createApp } from '../server/http/app.ts';

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

/** A running app on its own data directory. */
export interface TestApp {
  /** `http://127.0.0.1:<port>`. */
  base: string;
  services: Services;
  /** Where its files are. */
  dataDir: string;
  /** Stops the server and deletes the data directory. */
  close: () => Promise<void>;
}

/**
 * Starts the whole app on a random port with an empty data directory. The issuer is that port's `/oidc`.
 *
 * @param [settings] - Overrides for the services, such as the clock, the secret key, a fake Have I Been Pwned or a fake mail transport.
 * @returns The running app.
 */
export async function startTestApp(
  settings: Pick<
    ServiceSettings,
    'now' | 'secretKeys' | 'fetchRange' | 'fetchUpstream' | 'mailServer' | 'mailTransport' | 'objectStorage' | 'proxyCookieDomain' | 'trustedProxies'
  > = {},
): Promise<TestApp> {
  const dataDir = tempDir();
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${portOf(server)}`;
  const services = openServices({ dataDir, issuer: `${base}/oidc`, isProxied: false, ...settings });
  server.on('request', createApp(services));
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, services, dataDir, close };
}
