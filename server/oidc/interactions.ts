import express, { type Request, type Response, Router } from 'express';
import type Provider from 'oidc-provider';
import { z } from 'zod';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import type { ClientStore } from '../store/clients.ts';
import type { UserStore } from '../store/users.ts';
import { PAGE_PARAM, pageUrl, WEB_PAGE } from './pages.ts';
import { INTERACTION_PATH } from './provider.ts';

/** The prompts the provider asks this server to resolve. */
const Prompt = { Login: 'login', Consent: 'consent' } as const;

/** What the consent prompt says the client asked for and has not been granted. */
const missingSchema = z.object({
  missingOIDCScope: z.array(z.string()).optional(),
  missingOIDCClaims: z.array(z.string()).optional(),
  missingResourceScopes: z.record(z.string(), z.array(z.string())).optional(),
});

const credentialsSchema = z.object({ username: z.string().trim(), password: z.string() });

/** What the interaction routes use. */
export interface InteractionDeps {
  provider: Provider;
  clients: ClientStore;
  users: UserStore;
}

/**
 * Says why an interaction could not go on, in JSON the sign-in page shows.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param message - What went wrong, for a person.
 */
function sendError(res: Response, status: HttpStatus, message: string): void {
  res.status(status).json({ error: message });
}

/**
 * Sends a browser that navigated here to the web app's error page.
 *
 * @param res - The response.
 * @param message - What went wrong, for a person.
 */
function showError(res: Response, message: string): void {
  res.redirect(
    HttpStatus.SeeOther,
    pageUrl(WEB_PAGE.error, { [PAGE_PARAM.error]: 'interaction_failed', [PAGE_PARAM.description]: message }),
  );
}

/**
 * Grants a client every scope and claim it asked for. The operator added the client, so the user is
 * not asked: there is no consent screen in this provider.
 *
 * @param provider - The provider.
 * @param req - The interaction request.
 * @param res - Its response.
 * @returns The grant's id.
 */
async function grantEverythingAsked(provider: Provider, req: Request, res: Response): Promise<string> {
  const { prompt, params, session, grantId } = await provider.interactionDetails(req, res);
  const existing = grantId === undefined ? undefined : await provider.Grant.find(grantId);
  const grant = existing ?? new provider.Grant({ accountId: session?.accountId, clientId: String(params.client_id) });
  const { missingOIDCScope, missingOIDCClaims, missingResourceScopes } = missingSchema.parse(prompt.details);
  if (missingOIDCScope !== undefined) {
    grant.addOIDCScope(missingOIDCScope.join(' '));
  }
  if (missingOIDCClaims !== undefined) {
    grant.addOIDCClaims(missingOIDCClaims);
  }
  for (const [indicator, scopes] of Object.entries(missingResourceScopes ?? {})) {
    grant.addResourceScope(indicator, scopes.join(' '));
  }
  return grant.save();
}

/**
 * Builds the routes the provider sends a browser to mid-sign-in.
 *
 * @param deps - The provider and the stores.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /interaction/:uid` resolves consent itself and sends a login prompt on to the web app's
 * `/login/:uid` page. That page reads `GET /interaction/:uid/details` and posts the username and
 * password to `POST /interaction/:uid/login`, which answers with where the browser goes next.
 */
export function createInteractionRouter(deps: InteractionDeps): Router {
  const { provider, clients, users } = deps;
  const router = Router();

  router.get(`${INTERACTION_PATH}/:uid`, async (req, res) => {
    try {
      const { prompt, uid } = await provider.interactionDetails(req, res);
      if (prompt.name === Prompt.Login) {
        res.redirect(HttpStatus.SeeOther, `${WEB_PAGE.login}/${uid}`);
        return;
      }
      if (prompt.name === Prompt.Consent) {
        const grantId = await grantEverythingAsked(provider, req, res);
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
        return;
      }
      showError(res, `This provider cannot answer the "${prompt.name}" prompt.`);
    } catch (error) {
      showError(res, errorMessage(error));
    }
  });

  router.get(`${INTERACTION_PATH}/:uid/details`, async (req, res) => {
    try {
      const { params } = await provider.interactionDetails(req, res);
      const client = clients.find(String(params.client_id));
      res.json({ clientName: client?.name ?? String(params.client_id) });
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.post(`${INTERACTION_PATH}/:uid/login`, express.json(), async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (parsed.success === false) {
      sendError(res, HttpStatus.BadRequest, 'Send a username and a password.');
      return;
    }
    try {
      const user = users.authenticate(parsed.data.username, parsed.data.password);
      if (user === null) {
        sendError(res, HttpStatus.Unauthorized, 'That username and password do not match.');
        return;
      }
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId: user.id } },
        { mergeWithLastSubmission: false },
      );
      res.json({ redirectTo });
    } catch (error) {
      sendError(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  return router;
}
