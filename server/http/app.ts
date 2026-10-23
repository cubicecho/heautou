import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { createYoga } from 'graphql-yoga';
import { createFactorRouter } from '../account/factors.ts';
import { createAccountRouter } from '../account/routes.ts';
import { moveFormerSessionCookie, viewerOf } from '../account/session.ts';
import { adminUrls } from '../admin/admin-client.ts';
import { createBackupRouter } from '../admin/backup.ts';
import { createPictureRouter } from '../admin/pictures.ts';
import { createAdminRouter, requireAdmin } from '../admin/routes.ts';
import { isProduction, OIDC_MOUNT_PATH, trustProxy } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import type { Services } from '../core/services.ts';
import { FORWARD_AUTH_PATH } from '../forward-auth/client.ts';
import { createForwardAuthRouter } from '../forward-auth/routes.ts';
import { createProxyTrust } from '../forward-auth/trust.ts';
import { createSchema } from '../graphql/build-schema.ts';
import { graphqlLogger } from '../graphql/logger.ts';
import { useOperationLimits } from '../graphql/operation-limits.ts';
import { createForgotPasswordRouter } from '../mail/forgot-password.ts';
import { createInteractionRouter } from '../oidc/interactions.ts';
import { createUpstreamRouter } from '../upstream/routes.ts';
import { sameOriginJson } from './guards.ts';
import { securityHeaders, webAppHeaders } from './headers.ts';
import { healthHandler } from './health.ts';
import { createLoginThrottle, limitRequests } from './rate-limit.ts';

const GRAPHQL_ENDPOINT = '/graphql';
const HEALTH_ENDPOINT = '/healthz';
/** Every path but the server's own, so the web app's routes load index.html. */
const WEB_ROUTES = /^(?!\/(graphql|healthz)$|\/(oidc|interaction|admin|api|upstream|auth)(\/|$)).*/;
/** The routes that start sign-ins or write data, limited per address. */
const LIMITED_ROUTES = [
  `${OIDC_MOUNT_PATH}/auth`,
  `${OIDC_MOUNT_PATH}/reg`,
  // The device flow's code entry, where user codes could be guessed, and the device authorization endpoint.
  `${OIDC_MOUNT_PATH}/device`,
  '/interaction',
  '/admin',
  '/api',
  '/upstream',
  FORWARD_AUTH_PATH.signIn,
];
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
    schema: createSchema(services.db),
    graphqlEndpoint: GRAPHQL_ENDPOINT,
    logging: graphqlLogger,
    graphiql: isDev,
    // The guards below decide who may call; Yoga's own CORS would answer any origin.
    cors: false,
    plugins: [useOperationLimits()],
    context: ({ req, res }): Context => ({ ...services, viewer: viewerOf(res), ip: req.ip ?? null }),
  });
  const { origin } = adminUrls(services.issuer);
  const throttle = createLoginThrottle();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy());
  app.use(securityHeaders());
  app.get(HEALTH_ENDPOINT, healthHandler(services.db));
  app.use(LIMITED_ROUTES, limitRequests());
  app.use(moveFormerSessionCookie(services, services.issuer));
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
  app.use(createPictureRouter(services));
  app.use(createInteractionRouter({ ...services, origin, throttle }));
  app.use(createForgotPasswordRouter({ ...services, mailer: services.mail, origin }));
  app.use(createUpstreamRouter(services));
  // The proxy calls verify on every request to a protected site, so it is not rate limited; sign-in is.
  const trustsHop: (address: string, hop: number) => boolean = app.get('trust proxy fn');
  const trust = createProxyTrust(services.forwardAuth.trustedProxies, (address) => trustsHop(address, 0));
  app.use(createForwardAuthRouter({ ...services, trust }));
  app.use(OIDC_MOUNT_PATH, (req, res) => services.host.handle(req, res));

  const hasWebBuild = existsSync(WEB_DIST);
  if (hasWebBuild) {
    app.use(webAppHeaders(), express.static(WEB_DIST));
    app.get(WEB_ROUTES, webAppHeaders(), (_req, res) => res.sendFile('index.html', { root: WEB_DIST }));
  }
  return app;
}
