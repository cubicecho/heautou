// The host rule for protected sites and the cookie domain. It imports nothing, so the web app's form checks a host
// with the same rule the store saves it by.

/** A DNS name in lowercase: labels of up to 63 letters, digits and inner dashes, joined by dots, 253 at most. */
export const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
