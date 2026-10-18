// Runs before anything listens, so a misconfigured instance fails with a sentence, not a stack trace.
import { accessSync, constants, mkdirSync } from 'node:fs';
import { mailServerFromEnv } from '../mail/env.ts';
import { DIR_MODE } from '../store/json-file.ts';
import { LOOPBACK_HOSTS } from '../store/redirect-uris.ts';
import { dataDir, isProduction, issuerUrl, secretKeys } from './config.ts';
import { errorMessage } from './errors.ts';
import { SecretKeyError } from './secret-box.ts';

try {
  const issuer = new URL(issuerUrl());
  const isPlainOverNetwork = issuer.protocol === 'http:' && LOOPBACK_HOSTS.has(issuer.hostname) === false;
  if (isProduction() && isPlainOverNetwork) {
    console.warn(
      `[preflight] ISSUER_URL is plain HTTP on ${issuer.hostname}: passwords, session cookies and tokens cross the network readable. Put a TLS proxy in front and set ISSUER_URL to its https:// URL.`,
    );
  }
  // A malformed SECRET_KEY stops boot here; one that doesn't open the data stops it in openServices.
  secretKeys();
  // A malformed SMTP_URL, SMTP_PORT or a missing SMTP_FROM stops boot here, without repeating a password.
  mailServerFromEnv();
  const directory = dataDir();
  // Owner only when made here; an existing directory, such as a mounted volume, keeps its mode.
  mkdirSync(directory, { recursive: true, mode: DIR_MODE });
  accessSync(directory, constants.W_OK);
} catch (error) {
  const code = error instanceof SecretKeyError ? `${error.code}: ` : '';
  console.error(`[preflight] ${code}${errorMessage(error)}`);
  process.exit(1);
}
