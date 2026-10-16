// Runs before anything listens, so a misconfigured instance fails with a sentence, not a stack trace.
import { accessSync, constants, mkdirSync } from 'node:fs';
import { DIR_MODE } from '../store/json-file.ts';
import { dataDir, isProduction, issuerUrl } from './config.ts';
import { errorMessage } from './errors.ts';

/** Hosts a plain-HTTP issuer is fine on: nothing crosses a network. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

try {
  const issuer = new URL(issuerUrl());
  const isPlainOverNetwork = issuer.protocol === 'http:' && LOOPBACK_HOSTS.has(issuer.hostname) === false;
  if (isProduction() && isPlainOverNetwork) {
    console.warn(
      `[preflight] ISSUER_URL is plain HTTP on ${issuer.hostname}: passwords, session cookies and tokens cross the network readable. Put a TLS proxy in front and set ISSUER_URL to its https:// URL.`,
    );
  }
  const directory = dataDir();
  // Owner only when made here; an existing directory, such as a mounted volume, keeps its mode.
  mkdirSync(directory, { recursive: true, mode: DIR_MODE });
  accessSync(directory, constants.W_OK);
} catch (error) {
  console.error(`[preflight] ${errorMessage(error)}`);
  process.exit(1);
}
