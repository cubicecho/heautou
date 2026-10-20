import { z } from 'zod';

/**
 * A query parameter read as text. The router parses `?client=123` into a number, so anything it
 * gives back is turned into a string again.
 */
const searchText = z.preprocess((value) => (value === undefined ? undefined : String(value)), z.string().optional());

/** What the provider puts on the logout page's query string. */
export const logoutSearchSchema = z.object({ xsrf: searchText, client: searchText });

/** What the provider puts on the signed-out page's query string. */
export const loggedOutSearchSchema = z.object({ client: searchText });

/** What the provider puts on the error page's query string. */
export const errorSearchSchema = z.object({
  error: searchText,
  description: searchText,
  client: searchText,
  redirect_uri: searchText,
});

/** Where the logout form posts: the provider's end-session confirm endpoint. */
export const LOGOUT_CONFIRM_ACTION = '/oidc/session/end/confirm';

/**
 * Leaves the page for wherever the browser came from, or the overview when it came from nowhere.
 */
export function goBack(): void {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.assign('/');
  }
}

/** What the provider puts on the device page's query string; see the server's `device-flow.ts`. */
export const deviceSearchSchema = z.object({
  /** `confirm` or `done`; none asks for the code. */
  step: searchText,
  xsrf: searchText,
  user_code: searchText,
  client: searchText,
  error: searchText,
});

/** Where the device page's forms post, and where it fetches its anti-CSRF secret: the provider's `/device`. */
export const DEVICE_ACTION = '/oidc/device';
