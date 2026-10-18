import express, { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { adminUrls, WEB_APP_PAGE } from '../admin/admin-client.ts';
import { signedInUser } from '../admin/routes.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { HttpStatus } from '../core/wire.ts';
import { sameOriginJson, sendRefusal } from '../http/guards.ts';
import { INTERACTION_PATH } from '../oidc/provider.ts';
import type { AdminSessionStore } from '../store/admin-sessions.ts';
import { type AuditLog, AuditType, actorOf } from '../store/audit.ts';
import type { UpstreamStore } from '../store/upstreams.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import { upstreamTarget } from './accounts.ts';
import { FlowPurpose, UPSTREAM_PATH, type UpstreamFlows } from './flows.ts';

/** The account routes of upstream identities. */
export const ACCOUNT_UPSTREAM_PATH = {
  /** The providers, and which the signed-in user has linked (GET). */
  list: '/admin/account/upstreams',
  /** Starts linking one (POST `/:id/link`): the reply says where to send the browser. */
  link: '/admin/account/upstreams/:id/link',
  /** Links the identity a finished flow came back with (POST, with its ticket). */
  finish: '/admin/account/upstreams/finish',
  /** Unlinks one (POST `/:id/unlink`). */
  unlink: '/admin/account/upstreams/:id/unlink',
} as const;

/** The query parameter the account page reads a finished link's ticket from. */
export const LINK_TICKET_PARAM = 'upstreamLink';

/** What the upstream routes use. */
export interface UpstreamRouteDeps {
  users: UserStore;
  adminSessions: AdminSessionStore;
  upstreams: UpstreamStore;
  upstreamFlows: UpstreamFlows;
  audit: AuditLog;
  issuer: string;
}

const ticketSchema = z.object({ ticket: z.string().min(1) });

/**
 * Builds the routes an upstream provider sends the browser back to, and those a user links identities with.
 *
 * @param deps - The stores, the flows and the issuer.
 * @returns A router to mount at the root.
 *
 * @remarks
 * `GET /upstream/:id/callback` is the redirect URI registered at each provider. A sign-in goes on to
 * `/interaction/:uid/upstream-return`, under the interaction's own cookie; a link goes to `/account?upstreamLink=`,
 * whose ticket the page posts back with its session, so the identity is only ever linked to whoever started it.
 */
export function createUpstreamRouter(deps: UpstreamRouteDeps): Router {
  const { upstreams, upstreamFlows, audit, issuer } = deps;
  const urls = adminUrls(issuer);
  const json = [sameOriginJson(urls.origin), express.json({ limit: HTTP_DEFAULTS.bodyLimit })];
  const router = Router();

  /**
   * Finds the signed-in user, or answers 401.
   *
   * @param req - The request.
   * @param res - Its response.
   * @returns The user, or null when the response was sent.
   */
  const userOf = (req: Request, res: Response): PublicUser | null => {
    const user = signedInUser(deps, req);
    if (user === null) {
      sendRefusal(res, HttpStatus.Unauthorized, 'Sign in first.');
    }
    return user;
  };

  router.get(`${UPSTREAM_PATH}/:id/callback`, async (req, res) => {
    const query = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
    const outcome = await upstreamFlows.finish(req.params.id, query);
    if (outcome === null) {
      res
        .status(HttpStatus.BadRequest)
        .type('text/plain')
        .send('This sign-in took too long or was already used. Go back and try again.');
      return;
    }
    const { start } = outcome;
    if (start.purpose === FlowPurpose.SignIn) {
      upstreamFlows.holdForInteraction(start.uid, outcome);
      res.redirect(HttpStatus.SeeOther, `${INTERACTION_PATH}/${encodeURIComponent(start.uid)}/upstream-return`);
      return;
    }
    const ticket = upstreamFlows.holdForAccount(outcome);
    res.redirect(HttpStatus.SeeOther, `${WEB_APP_PAGE.account}?${LINK_TICKET_PARAM}=${encodeURIComponent(ticket)}`);
  });

  router.get(ACCOUNT_UPSTREAM_PATH.list, (req, res) => {
    const user = userOf(req, res);
    if (user === null) {
      return;
    }
    const links = upstreams.linksOf(user.id);
    res.json({
      hasPassword: user.hasPassword,
      providers: upstreams.list().map(({ id, name, kind }) => {
        const link = links.find((each) => each.providerId === id);
        return {
          id,
          name,
          kind,
          link: link === undefined ? null : { label: link.label, linkedAt: link.linkedAt, lastUsedAt: link.lastUsedAt },
        };
      }),
    });
  });

  router.post(ACCOUNT_UPSTREAM_PATH.finish, ...json, (req, res) => {
    const user = userOf(req, res);
    if (user === null) {
      return;
    }
    const parsed = ticketSchema.safeParse(req.body);
    const outcome = parsed.success ? upstreamFlows.takeForAccount(parsed.data.ticket) : null;
    const isTheirs = outcome !== null && outcome.start.purpose === FlowPurpose.Link && outcome.start.userId === user.id;
    if (outcome === null || isTheirs === false) {
      sendRefusal(res, HttpStatus.BadRequest, 'That link took too long or was already used. Try again.');
      return;
    }
    if (outcome.identity === null) {
      sendRefusal(res, HttpStatus.BadRequest, outcome.error);
      return;
    }
    const { provider, identity } = outcome;
    try {
      upstreams.link(
        user.id,
        { providerId: provider.id, issuer: identity.issuer, subject: identity.subject },
        identity.label,
      );
      audit.record({
        type: AuditType.UpstreamLinked,
        actor: actorOf(user),
        ip: req.ip ?? null,
        target: upstreamTarget(provider),
        detail: { identity: identity.label },
      });
      res.json({ provider: provider.name, label: identity.label });
    } catch (error) {
      sendRefusal(res, HttpStatus.BadRequest, errorMessage(error));
    }
  });

  router.post(ACCOUNT_UPSTREAM_PATH.link, ...json, async (req, res) => {
    const user = userOf(req, res);
    if (user === null) {
      return;
    }
    try {
      const redirectTo = await upstreamFlows.start(String(req.params.id), {
        purpose: FlowPurpose.Link,
        userId: user.id,
      });
      res.json({ redirectTo });
    } catch (error) {
      sendRefusal(res, HttpStatus.BadRequest, `That provider could not be reached: ${errorMessage(error)}`);
    }
  });

  router.post(ACCOUNT_UPSTREAM_PATH.unlink, ...json, (req, res) => {
    const user = userOf(req, res);
    if (user === null) {
      return;
    }
    const isLastWayIn = user.hasPassword === false && upstreams.linksOf(user.id).length <= 1;
    if (isLastWayIn) {
      sendRefusal(
        res,
        HttpStatus.BadRequest,
        'This is the only way you sign in. Ask an admin for a password link first.',
      );
      return;
    }
    try {
      const providerId = String(req.params.id);
      const provider = upstreams.find(providerId);
      const link = upstreams.unlink(user.id, providerId);
      audit.record({
        type: AuditType.UpstreamUnlinked,
        actor: actorOf(user),
        ip: req.ip ?? null,
        target: upstreamTarget(provider ?? { id: link.providerId, name: link.providerId }),
        detail: { identity: link.label },
      });
      res.json({ ok: true });
    } catch (error) {
      sendRefusal(res, HttpStatus.NotFound, errorMessage(error));
    }
  });

  return router;
}
