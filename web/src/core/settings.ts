import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  HttpRedirectsDocument,
  PasswordRulesDocument,
  SetHttpRedirectsDocument,
  SetPasswordRulesDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

/**
 * Reads whether redirect URIs may be plain http.
 *
 * @returns The query.
 */
export function useHttpRedirects() {
  return useQuery({
    queryKey: QUERY_KEYS.httpRedirects,
    queryFn: async () => (await request(HttpRedirectsDocument)).httpRedirects,
  });
}

/**
 * Allows or refuses plain http redirect URIs, or with null follows the issuer again. The clients are read again, since
 * which of them break the rule changes with it.
 *
 * @returns The mutation.
 */
export function useSetHttpRedirects() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (allowed: boolean | null) =>
      (await request(SetHttpRedirectsDocument, { allowed })).setHttpRedirects,
    onSuccess: async (setting) => {
      queryClient.setQueryData(QUERY_KEYS.httpRedirects, setting);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients });
    },
  });
}

/**
 * Reads what a new password must pass.
 *
 * @returns The query.
 */
export function usePasswordRules() {
  return useQuery({
    queryKey: QUERY_KEYS.passwordRules,
    queryFn: async () => (await request(PasswordRulesDocument)).passwordRules,
  });
}

/**
 * Changes the password strength or breach check rule. A rule left out keeps its value.
 *
 * @returns The mutation.
 */
export function useSetPasswordRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: { minScore?: number; checkBreaches?: boolean }) =>
      (await request(SetPasswordRulesDocument, changes)).setPasswordRules,
    onSuccess: (rules) => {
      queryClient.setQueryData(QUERY_KEYS.passwordRules, rules);
      queryClient.setQueryData(QUERY_KEYS.passwordStrength, { minScore: rules.minScore });
    },
  });
}

const passwordStrengthSchema = z.object({ minScore: z.number() });

/**
 * Reads the lowest strength a new password may have. Public: the set-password and setup pages show the meter too.
 *
 * @returns The query.
 */
export function usePasswordStrengthRule() {
  return useQuery({
    queryKey: QUERY_KEYS.passwordStrength,
    queryFn: async () => jsonReply(await fetch('/api/password-rules'), passwordStrengthSchema),
  });
}
