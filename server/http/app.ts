import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { createYoga } from 'graphql-yoga';
import { createAccountRouter } from '../admin/account.ts';
import { adminUrls } from '../admin/admin-client.ts';
import { createBackupRouter } from '../admin/backup.ts';
import { createFactorRouter } from '../admin/factors.ts';
import { createAdminRouter, requireAdmin } from '../admin/routes.ts';
import { isProduction, OIDC_MOUNT_PATH, trustProxy } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import type { Services } from '../core/services.ts';
import { graphqlLogger } from '../graphql/logger.ts';
import { useOperationLimits } from '../graphql/operation-limits.ts';
import { schema } from '../graphql/schema.ts';
import { createInteractionRouter } from '../oidc/interactions.ts';
import type { PublicUser } from '../store/users.ts';
import { sameOriginJson } from './guards.ts';
import { securityHeaders, webAppHeaders } from './headers.ts';
import { healthHandler } from './health.ts';
import { createLoginThrottle, limitRequests } from './rate-limit.ts';

const GRAPHQL_ENDPOINT = '/graphql';
const HEALTH_ENDPOINT = '/healthz';
/** Every path but the server's own, so the web app's routes load index.html. */
const WEB_ROUTES = /^(?!\/(graphql|healthz)$|\/(oidc|interaction|admin)(\/|$)).*/;
/** The routes that start sign-ins or write files, limited per address. */
const LIMITED_ROUTES = [`${OIDC_MOUNT_PATH}/auth`, `${OIDC_MOUNT_PATH}/reg`, '/interaction', '/admin'];
/** Where `npm run build` puts the web app. */
const WEB_DIST = fileURLToPath(new URL('../../dist', import.meta.url));

/**
 * Builds the Express app: the provider, its sign-in routes, the admin sign-in and API, health, and the built
 * web app when there is one. It does not listen.
 *
 * @remarks
 * `/graphql` takes only same-origin JSON POSTs from a signed-in admin; see `sameOriginJson` and `requireAdmin`.
 *
 * @param services - The stores and the provider.
 * @returns The app.
 */
export function createApp(services: Services): Express {
  const isDev = isProduction() === false;
  const yoga = createYoga<{ req: Request; res: Response }, Context>({
    schema,
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    logging: graphqlLogger,
    graphiql: isDev,
    // The guards below decide who may call; Yoga's own CORS would answer any origin.
    cors: false,
    plugins: [useOperationLimits()],
    context: ({ req, res }): Context => ({
      clients: services.clients,
      users: services.users,
      factors: services.factors,
      issuer: services.issuer,
      host: services.host,
      sessions: services.sessions,
      keys: services.keys,
      branding: services.branding,
      passwordLinks: services.passwordLinks,
      adminSessions: services.adminSessions,
      pairings: services.pairings,
      settings: services.settings,
      passwordPolicy: services.passwordPolicy,
      audit: services.audit,
      viewer: res.locals.viewer as PublicUser,
      ip: req.ip ?? null,
    }),
  });
  const { origin } = adminUrls(services.issuer);
  const throttle = createLoginThrottle();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  app.use(securityHeaders());
  app.get(HEALTH_ENDPOINT, healthHandler());
  app.use(LIMITED_ROUTES, limitRequests());
  app.use(
    GRAPHQL_ENDPOINT,
    sameOriginJson(origin, { allowHtmlGet: isDev }),
    requireAdmin(services),
    express.json({ limit: HTTP_DEFAULTS.bodyLimit }),
  );
  app.all(GRAPHQL_ENDPOINT, (req, res) => yoga(req, res));
  app.use(createAdminRouter({ ...services, throttle }));
  app.use(createAccountRouter({ ...services, throttle }));
  app.use(createFactorRouter({ ...services, throttle }));
  app.use(createBackupRouter(services));
  app.use(createInteractionRouter({ ...services, origin, throttle }));
  app.use(OIDC_MOUNT_PATH, (req, res) => services.host.handle(req, res));

  const hasWebBuild = existsSync(WEB_DIST);
  if (hasWebBuild) {
    app.use(webAppHeaders(), express.static(WEB_DIST));
    app.get(WEB_ROUTES, webAppHeaders(), (_req, res) => res.sendFile('index.html', { root: WEB_DIST }));
  }
  return app;
}
