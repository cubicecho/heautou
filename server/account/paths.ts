/**
 * The account side's public routes: the sign-in, set-password and account pages read them before anyone is signed
 * in. Kept apart from the routes so `brandingView` can name the logo's URL without importing them.
 */
export const PUBLIC_PATH = {
  /** Says whose a password link is (POST). */
  passwordLink: '/api/password-link',
  /** Sets the password with a password link (POST). */
  passwordLinkSet: '/api/password-link/set',
  /** The provider's name and whether it has a logo, for every page. */
  branding: '/api/branding',
  /** The logo image. */
  logo: '/api/branding/logo',
  /** The lowest password strength the rules take, for the strength meters. */
  passwordRules: '/api/password-rules',
} as const;
