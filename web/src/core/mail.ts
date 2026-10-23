import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  EmailPasswordLinkDocument,
  MailDocument,
  type MailServerInput,
  type MailSettingsFieldsFragment,
  RemoveMailServerDocument,
  SendTestEmailDocument,
  SetMailOptionsDocument,
  type SetMailOptionsMutationVariables,
  SetMailServerDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply, okReplySchema, postJson } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';
import { fragmentParam } from '@/core/url-fragment';

/**
 * Reads the SMTP server and the email options.
 *
 * @returns The query.
 */
export function useMail() {
  return useQuery({ queryKey: QUERY_KEYS.mail, queryFn: async () => (await request(MailDocument)).mail });
}

/**
 * Builds a mutation's `onSuccess` that puts the settings it answered with in the cache.
 *
 * @param queryClient - The query client.
 * @returns The handler.
 */
function storing(queryClient: ReturnType<typeof useQueryClient>) {
  return (settings: MailSettingsFieldsFragment) => {
    queryClient.setQueryData(QUERY_KEYS.mail, settings);
  };
}

/**
 * Saves the SMTP server under Settings.
 *
 * @returns The mutation.
 */
export function useSetMailServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: MailServerInput) => (await request(SetMailServerDocument, { input })).setMailServer,
    onSuccess: storing(queryClient),
  });
}

/**
 * Removes the SMTP server saved under Settings.
 *
 * @returns The mutation.
 */
export function useRemoveMailServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await request(RemoveMailServerDocument)).removeMailServer,
    onSuccess: storing(queryClient),
  });
}

/**
 * Turns the optional emails on or off.
 *
 * @returns The mutation; its variables are the options to change.
 */
export function useSetMailOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: SetMailOptionsMutationVariables) =>
      (await request(SetMailOptionsDocument, changes)).setMailOptions,
    onSuccess: storing(queryClient),
  });
}

/**
 * Sends a test email.
 *
 * @returns The mutation; its variable is the address, or null for the admin's own. It resolves to where it went.
 */
export function useSendTestEmail() {
  return useMutation({
    mutationFn: async (to: string | null) => (await request(SendTestEmailDocument, { to })).sendTestEmail,
  });
}

/**
 * Makes a user's invite or reset link and emails it to them.
 *
 * @returns The mutation; it resolves to the link, the address and the error when the email did not go.
 */
export function useEmailPasswordLink() {
  return useMutation({
    mutationFn: async (id: string) => (await request(EmailPasswordLinkDocument, { id })).emailPasswordLink,
  });
}

/** The reset link's fragment parameter naming the sign-in it was asked from. */
const UID_PARAM = 'uid';
/** What an interaction's uid is made of: oidc-provider's ids are base64url. */
const UID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Finds where to sign in once a reset link set the password: back in the sign-in its "Forgot password?" was asked
 * from, when the link's fragment names it (`&uid=`) and it is still open in this browser.
 *
 * @param fallback - Where the server says to go otherwise: the account page's sign-in.
 * @returns The page to go to.
 */
export async function signInAfterReset(fallback: string): Promise<string> {
  const uid = fragmentParam(UID_PARAM) ?? '';
  if (UID_PATTERN.test(uid) === false) {
    return fallback;
  }
  const details = await fetch(`/interaction/${uid}/details`).catch(() => null);
  return details?.ok === true ? `/login/${uid}` : fallback;
}

const availableSchema = z.object({ isAvailable: z.boolean() });

/**
 * Says whether the sign-in page offers "Forgot password?".
 *
 * @param uid - The sign-in.
 * @returns The query.
 */
export function useForgotPasswordAvailable(uid: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.forgotPassword, uid],
    queryFn: async () =>
      (await jsonReply(await fetch(`/interaction/${encodeURIComponent(uid)}/forgot-password`), availableSchema))
        .isAvailable,
    retry: false,
  });
}

/**
 * Asks for a reset link by email. The answer is the same whoever the identifier names.
 *
 * @param uid - The sign-in it is asked from, which the link comes back to.
 * @returns The mutation; its variable is a username or an email address.
 */
export function useForgotPassword(uid: string) {
  return useMutation({
    mutationFn: async (identifier: string) =>
      jsonReply(
        await postJson(`/interaction/${encodeURIComponent(uid)}/forgot-password`, { identifier }),
        okReplySchema,
      ),
  });
}
