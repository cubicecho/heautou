/** Where the server starts a sign-in to the web app; `?return=` is where it comes back to. */
export const SIGN_IN_PATH = '/admin/login';

/** A user's own account page, which any signed-in user may open. */
export const ACCOUNT_PAGE = '/account';

/**
 * Builds the sign-in URL that comes back to a page once the user is signed in.
 *
 * @param returnTo - The page's path and query.
 * @returns The URL.
 */
export function signInPath(returnTo: string): string {
  return `${SIGN_IN_PATH}?return=${encodeURIComponent(returnTo)}`;
}
