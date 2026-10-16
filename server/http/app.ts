import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createYoga } from 'graphql-yoga';
import { isProduction, OIDC_MOUNT_PATH, trustProxy } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import type { Services } from '../core/services.ts';
import { graphqlLogger } from '../graphql/logger.ts';
import { useOperationLimits } from '../graphql/operation-limits.ts';
import { schema } from '../graphql/schema.ts';
import { createInteractionRouter } from '../oidc/interactions.ts';
import { healthHandler } from './health.ts';

const GRAPHQL_ENDPOINT = '/graphql';
const HEALTH_ENDPOINT = '/healthz';
/** Every path but the server's own, so the web app's routes load index.html. */
const WEB_ROUTES = /^(?!\/(graphql|healthz)$|\/(oidc|interaction)(\/|$)).*/;
/** Where `npm run build` puts the web app. */
const WEB_DIST = fileURLToPath(new URL('../../dist', import.meta.url));

/**
 * Builds the Express app: the provider, its sign-in routes, the admin API, health, and the built web app when
 * there is one. It does not listen.
 *
 * @param services - The stores and the provider.
 * @returns The app.
 */
export function createApp(services: Services): Express {
  const yoga = createYoga<Record<string, never>, Context>({
    schema,
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    logging: graphqlLogger,
    graphiql: isProduction() === false,
    plugins: [useOperationLimits()],
    context: () => ({ clients: services.clients, users: services.users, issuer: services.issuer }),
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  app.get(HEALTH_ENDPOINT, healthHandler());
  app.use(GRAPHQL_ENDPOINT, express.json({ limit: HTTP_DEFAULTS.bodyLimit }));
  app.all(GRAPHQL_ENDPOINT, (req, res) => yoga(req, res));
  app.use(createInteractionRouter(services));
  app.use(OIDC_MOUNT_PATH, services.provider.callback());

  const hasWebBuild = existsSync(WEB_DIST);
  if (hasWebBuild) {
    app.use(express.static(WEB_DIST));
    app.get(WEB_ROUTES, (_req, res) => res.sendFile('index.html', { root: WEB_DIST }));
  }
  return app;
}
