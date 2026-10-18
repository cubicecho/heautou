/** What a person is told about one error. */
export interface ErrorCopy {
  title: string;
  /** What happened and what to do, in a sentence or two. */
  description: string;
  /** Whether the fix is in Heautou's client settings, so the page links there. */
  isClientSetup: boolean;
}

/** The errors worth explaining. Anything else gets `FALLBACK`. */
const COPY: Record<string, ErrorCopy> = {
  invalid_redirect_uri: {
    title: "This app's redirect URI isn't registered",
    description:
      "The app asked to be sent back to an address its client in Heautou doesn't list. Add the exact URI below to the client's Redirect URIs, or fix the app's settings.",
    isClientSetup: true,
  },
  invalid_client: {
    title: "Heautou doesn't know this app",
    description:
      "No client has the ID the app sent, or the app's secret is wrong. Check the client ID and secret in the app's settings against the client in Heautou.",
    isClientSetup: true,
  },
  unauthorized_client: {
    title: "This app isn't allowed to sign in this way",
    description: "The client in Heautou isn't set up for what the app asked for. Check its client authentication.",
    isClientSetup: true,
  },
  invalid_scope: {
    title: 'The app asked for something Heautou doesn’t offer',
    description:
      'Heautou offers the scopes openid, profile, email, groups and offline_access. Remove any others from the app’s settings.',
    isClientSetup: false,
  },
  unsupported_response_type: {
    title: 'The app uses a sign-in flow Heautou doesn’t support',
    description: 'Heautou supports the authorization code flow (response type “code”). Set the app to use it.',
    isClientSetup: false,
  },
  interaction_failed: {
    title: 'This sign-in has expired',
    description: 'It took too long, or the page was opened twice. Go back to the app and sign in again.',
    isClientSetup: false,
  },
  invalid_request: {
    title: "Heautou couldn't use that request",
    description:
      'The app sent something Heautou can’t act on, or a page was reloaded or opened twice. Go back to the app and try again.',
    isClientSetup: false,
  },
  access_denied: {
    title: 'Sign-in was cancelled',
    description: 'Go back to the app to try again.',
    isClientSetup: false,
  },
  account_disabled: {
    title: 'That account is disabled',
    description: 'An admin turned it off. Ask them to enable it again.',
    isClientSetup: false,
  },
  admin_sign_in_failed: {
    title: 'Signing in to the admin UI didn’t finish',
    description: 'It took too long, or began in another tab or browser. Open the admin UI again to start over.',
    isClientSetup: false,
  },
  proxy_sign_in_failed: {
    title: 'Signing in to the protected site didn’t finish',
    description: 'It took too long, or began in another tab or browser. Open the site again to start over.',
    isClientSetup: false,
  },
  proxy_return_refused: {
    title: 'Heautou won’t send you back there',
    description:
      'The sign-in was asked to return to an address that is not a protected site. Open the site you meant to visit and sign in from there.',
    isClientSetup: false,
  },
  server_error: {
    title: 'Heautou hit a problem',
    description:
      'Something went wrong inside Heautou. Its logs say what. Try again, and if it keeps happening, check them.',
    isClientSetup: false,
  },
};

const FALLBACK: ErrorCopy = {
  title: 'Something went wrong signing in',
  description: 'Go back to the app and try again. The details below say what Heautou objected to.',
  isClientSetup: false,
};

/**
 * Explains an OAuth error code for a person.
 *
 * @param code - The code, such as `invalid_redirect_uri`, or undefined when none was given.
 * @returns The title and description to show.
 */
export function errorCopyOf(code: string | undefined): ErrorCopy {
  return (code === undefined ? undefined : COPY[code]) ?? FALLBACK;
}
