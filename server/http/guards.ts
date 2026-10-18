import type { RequestHandler, Response } from 'express';
import { HttpStatus } from '../core/wire.ts';

/** `Sec-Fetch-Site` values a page of this origin, or the user typing a URL, sends. */
const SAME_SITE_FETCHES = new Set(['same-origin', 'none']);

/**
 * Refuses a request with a sentence in JSON.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param message - Why, for a person.
 */
export function sendRefusal(res: Response, status: HttpStatus, message: string): void {
  res.status(status).json({ error: message });
}

/** What `sameOriginJson` lets through besides JSON POSTs. */
export interface SameOriginOptions {
  /** Let GETs that ask for HTML through, for GraphiQL in development. */
  allowHtmlGet?: boolean;
}

/** The body a guarded POST must carry, and what to call it in the refusal. */
export interface PostBody {
  /** The media type, such as `application/json`. Never one a cross-site form may send. */
  type: string;
  /** What the refusal asks for, such as "JSON". */
  name: string;
}

/** The body every guarded route but the restore takes. */
const JSON_BODY: PostBody = { type: 'application/json', name: 'JSON' };

/**
 * Lets only POSTs of one non-form media type from the app's own pages through. A cross-site page can make a browser
 * send a form or a "simple" POST with its cookies, but not one with a `Content-Type` such as `application/json` or
 * `application/gzip` without the browser asking first; and browsers name the page's origin in `Origin` and
 * `Sec-Fetch-Site`.
 *
 * @param origin - The app's public origin, the issuer's.
 * @param body - The media type the route takes.
 * @param [options] - What else to let through.
 * @returns The middleware.
 */
export function sameOriginPost(origin: string, body: PostBody, options: SameOriginOptions = {}): RequestHandler {
  return (req, res, next) => {
    const isHtmlGet = req.method === 'GET' && req.accepts(['json', 'html']) === 'html';
    if (options.allowHtmlGet === true && isHtmlGet) {
      next();
      return;
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      sendRefusal(res, HttpStatus.MethodNotAllowed, 'Send a POST.');
      return;
    }
    const isExpectedType = typeof req.is(body.type) === 'string';
    if (isExpectedType === false) {
      sendRefusal(res, HttpStatus.UnsupportedMediaType, `Send ${body.name}, with Content-Type: ${body.type}.`);
      return;
    }
    const sentOrigin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const isForeign =
      (sentOrigin !== undefined && sentOrigin !== origin) ||
      (site !== undefined && SAME_SITE_FETCHES.has(site) === false);
    if (isForeign) {
      sendRefusal(res, HttpStatus.Forbidden, `Only pages on ${origin} may call this.`);
      return;
    }
    next();
  };
}

/**
 * Lets only JSON POSTs from the app's own pages through; see `sameOriginPost`.
 *
 * @param origin - The app's public origin, the issuer's.
 * @param [options] - What else to let through.
 * @returns The middleware.
 */
export function sameOriginJson(origin: string, options: SameOriginOptions = {}): RequestHandler {
  return sameOriginPost(origin, JSON_BODY, options);
}
