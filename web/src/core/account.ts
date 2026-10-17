import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { jsonReply, postJson } from '@/core/json-reply';

/** Where a browser with no session signs in, coming back to the account page. */
export const ACCOUNT_LOGIN = '/admin/login?return=%2Faccount';
/** What `/admin/account` answers a browser with no session. */
const HTTP_UNAUTHORIZED = 401;

const KEY = ['account'] as const;

const accountSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string(),
  groups: z.array(z.string()),
  isAdmin: z.boolean(),
  sessions: z.array(
    z.object({
      id: z.string(),
      signedInAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      clientNames: z.array(z.string()),
    }),
  ),
});
const activitySchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      type: z.string(),
      ip: z.string().nullable(),
      clientName: z.string().nullable(),
    }),
  ),
});

/** One of the signed-in user's recent sign-ins. */
export type SignInEntry = z.infer<typeof activitySchema>['entries'][number];

const okSchema = z.object({ ok: z.literal(true) });
const redirectSchema = z.object({ redirectTo: z.string() });
const linkSchema = z.object({ username: z.string(), isInvite: z.boolean() });

/**
 * Reads the signed-in user's own account. With no session, the browser is sent to sign in and back.
 *
 * @returns The query.
 */
export function useAccount() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const response = await fetch('/admin/account');
      if (response.status === HTTP_UNAUTHORIZED) {
        window.location.assign(ACCOUNT_LOGIN);
        throw new Error('Signing you in…');
      }
      return jsonReply(response, accountSchema);
    },
    retry: false,
  });
}

/**
 * Reads the signed-in user's recent sign-ins, newest first.
 *
 * @returns The query.
 */
export function useAccountActivity() {
  return useQuery({
    queryKey: [...KEY, 'activity'],
    queryFn: async () => (await jsonReply(await fetch('/admin/account/activity'), activitySchema)).entries,
    retry: false,
  });
}

/**
 * Changes the signed-in user's password, given their current one.
 *
 * @returns The mutation.
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async (body: { currentPassword: string; newPassword: string }) =>
      jsonReply(await postJson('/admin/account/password', body), okSchema),
  });
}

/**
 * Ends every session and token of the signed-in user, this browser's too, and sends it to sign in again.
 *
 * @returns The mutation.
 */
export function useSignOutEverywhere() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => jsonReply(await postJson('/admin/account/sign-out-everywhere', {}), redirectSchema),
    onSuccess: ({ redirectTo }) => {
      queryClient.removeQueries({ queryKey: KEY });
      window.location.assign(redirectTo);
    },
  });
}

/**
 * Reads whose a password link is.
 *
 * @param token - The token from the link.
 * @returns The query; it fails for a link that expired or was used.
 */
export function usePasswordLink(token: string | null) {
  return useQuery({
    queryKey: ['password-link', token],
    queryFn: async () => jsonReply(await postJson('/admin/password-link', { token }), linkSchema),
    enabled: token !== null,
    retry: false,
  });
}

/**
 * Sets a password with a link's token.
 *
 * @returns The mutation; it resolves to where the browser signs in next.
 */
export function useSetPasswordWithLink() {
  return useMutation({
    mutationFn: async (body: { token: string; password: string }) =>
      jsonReply(await postJson('/admin/password-link/set', body), redirectSchema),
  });
}
