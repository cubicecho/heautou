// Boot only. Preflight is the first import: it exits with a sentence when the configuration is unusable.
import './core/preflight.ts';
import { dataDir, issuerUrl, port, trustProxy, version } from './core/config.ts';
import { openServices } from './core/services.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';

const LISTEN_HOST = '0.0.0.0';

const services = openServices({ dataDir: dataDir(), issuer: issuerUrl(), isProxied: trustProxy() !== false });

const server = createApp(services).listen(port(), LISTEN_HOST, () => {
  console.log(
    `[boot] heautou ${version()} on http://localhost:${port()}, issuer ${services.issuer}, data in ${dataDir()}`,
  );
  stopOnSignals(server);
});
