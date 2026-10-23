import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const WEB_PORT = 3000;
const API_ORIGIN = 'http://localhost:8787';

export default defineConfig({
  root: 'web',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: fileURLToPath(new URL('./web/src/routes', import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL('./web/src/route-tree.gen.ts', import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      // The server modules the web app shares rules and limits with. Each imports nothing (tests/web/server-imports).
      '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: WEB_PORT,
    // The API runs beside Vite in dev. The issuer is this origin, so the provider and its sign-in routes go through
    // too; the regex keeps /graphql-ish asset paths out of the proxy.
    proxy: {
      '^/graphql(\\?|$)': API_ORIGIN,
      '/healthz': API_ORIGIN,
      '/oidc': API_ORIGIN,
      '/interaction': API_ORIGIN,
      '/admin': API_ORIGIN,
      '/api': API_ORIGIN,
      '/upstream': API_ORIGIN,
      // A user's profile picture; `/users` itself is the web app's page.
      '^/users/[^/]+/picture': API_ORIGIN,
      '/auth': API_ORIGIN,
    },
  },
});
