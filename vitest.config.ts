import path from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = [
  // graphql ships no exports map: Vite follows `module` to index.mjs while Node follows `main`
  // to index.js, and the two copies fail each other's instanceof checks.
  { find: /^graphql$/, replacement: path.resolve(import.meta.dirname, './node_modules/graphql/index.js') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    pool: 'threads',
    exclude: ['**/node_modules/**', '**/dist/**'],
    projects: [{ extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } }],
  },
});
