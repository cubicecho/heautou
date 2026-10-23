import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateUpstreamDocument,
  DeleteUpstreamDocument,
  UnlinkUserUpstreamDocument,
  UpdateUpstreamDocument,
  type UpstreamInput,
  UpstreamRedirectUriDocument,
  UpstreamsDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/**
 * Reads the providers users may sign in through.
 *
 * @returns The query.
 */
export function useUpstreams() {
  return useQuery({
    queryKey: QUERY_KEYS.upstreams,
    queryFn: async () => (await request(UpstreamsDocument)).upstreams,
  });
}

/**
 * Reads the redirect URI a provider with an id would have, to register there before it is saved.
 *
 * @param id - The id typed so far.
 * @returns The query; disabled while the id is blank.
 */
export function useUpstreamRedirectUri(id: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.upstreams, 'redirectUri', id],
    queryFn: async () => (await request(UpstreamRedirectUriDocument, { id })).upstreamRedirectUri,
    enabled: id !== '',
  });
}

/**
 * Adds an upstream provider, or changes one.
 *
 * @returns The mutation.
 */
export function useSaveUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input, isNew }: { id: string; input: UpstreamInput; isNew: boolean }) =>
      isNew
        ? (await request(CreateUpstreamDocument, { id, input })).createUpstream
        : (await request(UpdateUpstreamDocument, { id, input })).updateUpstream,
    onSuccess: refetching(queryClient, QUERY_KEYS.upstreams),
  });
}

/**
 * Removes an upstream provider and the identities linked through it.
 *
 * @returns The mutation.
 */
export function useDeleteUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(DeleteUpstreamDocument, { id })).deleteUpstream,
    onSuccess: refetching(queryClient, QUERY_KEYS.upstreams, QUERY_KEYS.users),
  });
}

/**
 * Unlinks a user's identity at an upstream provider.
 *
 * @returns The mutation.
 */
export function useUnlinkUserUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; providerId: string }) =>
      (await request(UnlinkUserUpstreamDocument, args)).unlinkUserUpstream,
    onSuccess: refetching(queryClient, QUERY_KEYS.users, QUERY_KEYS.upstreams),
  });
}
