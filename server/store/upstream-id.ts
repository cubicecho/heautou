// The id rule for upstream providers, which is part of their redirect URI. It imports nothing, so the web app's form
// checks an id with the same rule the store saves it by.

/** Lower-case letters, digits and dashes, starting with a letter or digit. */
export const UPSTREAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
