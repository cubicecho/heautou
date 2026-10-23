import { HttpStatus } from '@server/core/wire.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { jsonReply, okReplySchema, postJson, redirectReplySchema } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

/** Where a browser with no session signs in, coming back to the account page. */
const ACCOUNT_LOGIN = '/admin/login?return=%2Faccount';

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

/** One browser signed in as the signed-in user. */
export type AccountSession = z.infer<typeof accountSchema>['sessions'][number];

/** One of the signed-in user's recent sign-ins. */
export type SignInEntry = z.infer<typeof activitySchema>['entries'][number];

const linkSchema = z.object({ username: z.string(), isInvite: z.boolean() });

/**
 * Reads the signed-in user's own account. With no session, the browser is sent to sign in and back.
 *
 * @returns The query.
 */
export function useAccount() {
  return useQuery({
    queryKey: QUERY_KEYS.account,
    queryFn: async () => {
      const response = await fetch('/api/account');
      if (response.status === HttpStatus.Unauthorized) {
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
    queryKey: QUERY_KEYS.accountActivity,
    queryFn: async () => (await jsonReply(await fetch('/api/account/activity'), activitySchema)).entries,
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
      jsonReply(await postJson('/api/account/password', body), okReplySchema),
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
    mutationFn: async () => jsonReply(await postJson('/api/account/sign-out-everywhere', {}), redirectReplySchema),
    onSuccess: ({ redirectTo }) => {
      queryClient.removeQueries({ queryKey: QUERY_KEYS.account });
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
    queryKey: [...QUERY_KEYS.passwordLink, token],
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
      jsonReply(await postJson('/admin/password-link/set', body), redirectReplySchema),
  });
}

const upstreamsSchema = z.object({
  /** Whether the user has a password, so unlinking their last provider would not lock them out. */
  hasPassword: z.boolean(),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      link: z.object({ label: z.string(), linkedAt: z.string(), lastUsedAt: z.string().nullable() }).nullable(),
    }),
  ),
});
const linkedSchema = z.object({ provider: z.string(), label: z.string() });

/** One provider the user may link an account at, and theirs when they have. */
export type AccountUpstream = z.infer<typeof upstreamsSchema>['providers'][number];

/**
 * Reads the providers the signed-in user may link an account at, and the ones they have.
 *
 * @returns The query.
 */
export function useAccountUpstreams() {
  return useQuery({
    queryKey: QUERY_KEYS.accountUpstreams,
    queryFn: async () => jsonReply(await fetch('/api/account/upstreams'), upstreamsSchema),
    retry: false,
  });
}

/**
 * Starts linking an account at a provider: the browser goes there, and comes back to the account page.
 *
 * @returns The mutation.
 */
export function useStartLink() {
  return useMutation({
    mutationFn: async (providerId: string) =>
      jsonReply(
        await postJson(`/api/account/upstreams/${encodeURIComponent(providerId)}/link`, {}),
        redirectReplySchema,
      ),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
  });
}

/**
 * Links the account a provider sent the browser back with.
 *
 * @returns The mutation; it resolves to the provider's name and the account's.
 */
export function useFinishLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ticket: string) =>
      jsonReply(await postJson('/api/account/upstreams/finish', { ticket }), linkedSchema),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.accountUpstreams }),
  });
}

/**
 * Unlinks the signed-in user's account at a provider.
 *
 * @returns The mutation.
 */
export function useUnlink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) =>
      jsonReply(await postJson(`/api/account/upstreams/${encodeURIComponent(providerId)}/unlink`, {}), okReplySchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEYS.accountUpstreams }),
  });
}
