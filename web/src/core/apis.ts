import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ApiInput,
  ApiLifetimeBoundsDocument,
  ApisDocument,
  CreateApiDocument,
  DeleteApiDocument,
  type NewApiInput,
  UpdateApiDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/** What an API's change refetches: the APIs, and the clients, which show the APIs they may use. */
const API_LISTS = [QUERY_KEYS.apis, QUERY_KEYS.clients] as const;

/**
 * Reads every API.
 *
 * @returns The query.
 */
export function useApis() {
  return useQuery({ queryKey: QUERY_KEYS.apis, queryFn: async () => (await request(ApisDocument)).apis });
}

/**
 * Reads the bounds on an API's own access token lifetime.
 *
 * @returns The query.
 */
export function useApiLifetimeBounds() {
  return useQuery({
    queryKey: QUERY_KEYS.apiLifetimeBounds,
    queryFn: async () => (await request(ApiLifetimeBoundsDocument)).apiLifetimeBounds,
  });
}

/**
 * Adds an API.
 *
 * @returns The mutation; it resolves to the new API.
 */
export function useCreateApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewApiInput) => (await request(CreateApiDocument, { input })).createApi,
    onSuccess: refetching(queryClient, ...API_LISTS),
  });
}

/**
 * Changes an API.
 *
 * @returns The mutation.
 */
export function useUpdateApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { identifier: string; input: ApiInput }) =>
      (await request(UpdateApiDocument, vars)).updateApi,
    onSuccess: refetching(queryClient, ...API_LISTS),
  });
}

/**
 * Removes an API.
 *
 * @returns The mutation.
 */
export function useDeleteApi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (identifier: string) => (await request(DeleteApiDocument, { identifier })).deleteApi,
    onSuccess: refetching(queryClient, ...API_LISTS),
  });
}
