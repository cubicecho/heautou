import path from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = [
  // graphql ships no exports map: Vite follows `module` to index.mjs while Node follows `main`
  // to index.js, and the two copies fail each other's instanceof checks.
  { find: /^graphql$/, replacement: path.resolve(import.meta.dirname, './node_modules/graphql/index.js') },
];

/**
 * How long a test or hook may take, in milliseconds. Most boot a server or a PGlite database and apply every
 * migration, which takes seconds on a busy machine; vitest's own 5 and 10 seconds failed them under load.
 */
const BOOT_TIMEOUT_MS = 60_000;

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    pool: 'threads',
    testTimeout: BOOT_TIMEOUT_MS,
    hookTimeout: BOOT_TIMEOUT_MS,
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [{ extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } }],
  },
});
