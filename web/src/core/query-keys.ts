import type { QueryClient } from '@tanstack/react-query';

/**
 * The react-query key of everything the web app reads. A read that takes a parameter adds it after its key
 * (`[...QUERY_KEYS.sessions, userId]`), so refetching the key refetches every one of them.
 */
export const QUERY_KEYS = {
  viewer: ['viewer'],
  provider: ['provider'],
  tokenLifetimeDefaults: ['tokenLifetimeDefaults'],
  clients: ['clients'],
  users: ['users'],
  /** A user's sessions, by the user's id. */
  sessions: ['sessions'],
  groups: ['groups'],
  /** A pairing, by its id. */
  pairings: ['pairings'],
  signingKeys: ['keys'],
  httpRedirects: ['httpRedirects'],
  passwordRules: ['passwordRules'],
  /** The public part of the password rules, which every strength meter reads. */
  passwordStrength: ['passwordStrength'],
  branding: ['branding'],
  /** The audit log's pages, by the activity page's filters. */
  audit: ['audit'],
  /** The upstream providers; with `redirectUri` and an id, the redirect URI one would have. */
  upstreams: ['upstreams'],
  apis: ['apis'],
  apiLifetimeBounds: ['apiLifetimeBounds'],
  protectedSites: ['protectedSites'],
  forwardAuth: ['forwardAuth'],
  mail: ['mail'],
  profilePictures: ['profilePictures'],
  backup: ['backup'],
  setup: ['setup'],
  /** The signed-in user's account; every key of the account page starts with it. */
  account: ['account'],
  accountActivity: ['account', 'activity'],
  accountFactors: ['account', 'factors'],
  accountPicture: ['account', 'picture'],
  accountUpstreams: ['account', 'upstreams'],
  /** Whose a password link is, by its token. */
  passwordLink: ['password-link'],
  /** A sign-in's details, by its uid. */
  interaction: ['interaction'],
  /** Whether a sign-in offers "Forgot password?", by its uid. */
  forgotPassword: ['forgot-password'],
  /** The authenticator app's QR code, by its `otpauth://` URI. */
  totpQr: ['totp-qr'],
  /** The password strength estimator, loaded on first use. */
  zxcvbn: ['zxcvbn'],
} as const;

/**
 * Builds a mutation hook's `onSuccess` that refetches the lists a change touched.
 *
 * @param queryClient - The app's query client.
 * @param keys - The lists to refetch.
 * @returns The handler, which resolves once every list is fetched again.
 */
export function refetching(queryClient: QueryClient, ...keys: (readonly string[])[]): () => Promise<unknown> {
  return () => Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
}
