import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeysDocument, RotateKeysDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS } from '@/core/query-keys';

/**
 * Reads the signing keys.
 *
 * @returns The query.
 */
export function useKeys() {
  return useQuery({ queryKey: QUERY_KEYS.signingKeys, queryFn: async () => (await request(KeysDocument)).keys });
}

/**
 * Makes new signing and cookie keys.
 *
 * @returns The mutation.
 */
export function useRotateKeys() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await request(RotateKeysDocument)).rotateKeys,
    onSuccess: (keys) => queryClient.setQueryData(QUERY_KEYS.signingKeys, keys),
  });
}
