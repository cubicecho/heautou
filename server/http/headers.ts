import type { RequestHandler } from 'express';

/**
 * What the web app's pages may load: only this origin's scripts, styles and fetches. Inline styles are allowed
 * because the UI library sets some; inline scripts are not. There is no `form-action`: the provider's logout
 * form posts to its own origin and then redirects to the client's, which `form-action` would block in some browsers.
 */
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Sets the headers every response gets: no MIME sniffing, no referrer (sign-in URLs carry codes and states),
 * and no framing, so the sign-in page cannot be overlaid on another site.
 *
 * @returns The middleware.
 */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  };
}

/**
 * Adds the content security policy to the web app's files. The provider's own pages are left alone: its
 * form_post response runs an inline script the provider allows with its own policy.
 *
 * @returns The middleware.
 */
export function webAppHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.set('Content-Security-Policy', WEB_CSP);
    next();
  };
}
