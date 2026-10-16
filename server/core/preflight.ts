// Runs before anything listens, so a misconfigured instance fails with a sentence, not a stack trace.
import { accessSync, constants, mkdirSync } from 'node:fs';
import { dataDir, issuerUrl } from './config.ts';
import { errorMessage } from './errors.ts';

try {
  issuerUrl();
  const directory = dataDir();
  mkdirSync(directory, { recursive: true });
  accessSync(directory, constants.W_OK);
} catch (error) {
  console.error(`[preflight] ${errorMessage(error)}`);
  process.exit(1);
}
