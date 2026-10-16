import type { ClientAuthMethod } from '@/__generated__/graphql';

/** What each way of proving a client's identity is called, and when to pick it. */
export const AUTH_METHODS: Record<ClientAuthMethod, { label: string; description: string }> = {
  CLIENT_SECRET_BASIC: {
    label: 'Secret, Basic header',
    description: 'A server-side app with a secret. What most apps send.',
  },
  CLIENT_SECRET_POST: {
    label: 'Secret, form body',
    description: 'A server-side app that sends its secret in the token request body.',
  },
  NONE: {
    label: 'Public (PKCE)',
    description: 'A single-page or native app that cannot keep a secret. It must use PKCE.',
  },
};

/** The choices, in the order the select lists them. */
export const AUTH_METHOD_OPTIONS = (['CLIENT_SECRET_BASIC', 'CLIENT_SECRET_POST', 'NONE'] as const).map((value) => ({
  value,
  label: AUTH_METHODS[value].label,
}));

/**
 * Narrows the select's string to an auth method.
 *
 * @param value - What the select holds.
 * @returns The auth method, or the default when it is none of them.
 */
export function authMethodOf(value: string): ClientAuthMethod {
  return AUTH_METHOD_OPTIONS.find((option) => option.value === value)?.value ?? 'CLIENT_SECRET_BASIC';
}
