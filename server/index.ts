// Boot only. Preflight is the first import: it exits with a sentence when the configuration is unusable.
import './core/preflight.ts';
import { adminUrls } from './admin/admin-client.ts';
import { dataDir, issuerUrl, port, trustProxy, version } from './core/config.ts';
import { ADMIN_DEFAULTS } from './core/defaults.ts';
import { openServices } from './core/services.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';

const LISTEN_HOST = '0.0.0.0';
const SECONDS_PER_MINUTE = 60;

const services = openServices({ dataDir: dataDir(), issuer: issuerUrl(), isProxied: trustProxy() !== false });

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
