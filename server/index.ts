// Boot only. Preflight is the first import: it exits with a sentence when the configuration is unusable.
import './core/preflight.ts';
import { adminUrls } from './admin/admin-client.ts';
import { dataDir, issuerUrl, port, s3Config, secretKeys, trustProxy, version } from './core/config.ts';
import { ADMIN_DEFAULTS } from './core/defaults.ts';
import { errorMessage } from './core/errors.ts';
import { createObjectStorage } from './core/object-storage.ts';
import { SecretKeyError } from './core/secret-box.ts';
import { openServices, type Services } from './core/services.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';
import { mailServerFromEnv } from './mail/env.ts';

const LISTEN_HOST = '0.0.0.0';
const SECONDS_PER_MINUTE = 60;

const sealingKeys = secretKeys();
const bucket = s3Config();

/**
 * Opens the data, stopping with a sentence when the secret key doesn't fit it.
 *
 * @returns The services.
 */
function openOrExit(): Services {
  try {
    return openServices({
      dataDir: dataDir(),
      issuer: issuerUrl(),
      isProxied: trustProxy() !== false,
      secretKeys: sealingKeys,
      mailServer: mailServerFromEnv(),
      objectStorage: bucket === null ? null : createObjectStorage(bucket),
    });
  } catch (error) {
    if (error instanceof SecretKeyError) {
      console.error(`[boot] ${error.code}: ${errorMessage(error)}`);
      process.exit(1);
    }
    throw error;
  }
}

const services = openOrExit();
if (sealingKeys === null) {
  console.warn(
    `[boot] SECRET_KEY is not set: client secrets and signing keys are stored in plain text in ${dataDir()}. Set SECRET_KEY or SECRET_KEY_FILE to seal them.`,
  );
}

const server = createApp(services).listen(port(), LISTEN_HOST, () => {
  console.log(
    `[boot] heautou ${version()} on http://localhost:${port()}, issuer ${services.issuer}, data in ${dataDir()}`,
  );
  if (services.setup.isNeeded()) {
    const { base } = adminUrls(services.issuer);
    const minutes = ADMIN_DEFAULTS.setupWindowSeconds / SECONDS_PER_MINUTE;
    console.log(
      `[setup] No admin yet. Open ${base} within ${minutes} minutes to make one. After that, or to make an existing user the admin, open ${base}/setup#token=${services.setup.token}. The token changes on every restart.`,
    );
  }
  stopOnSignals(server);
});
