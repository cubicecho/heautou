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

/** The react-query key of the API list. A client's change or removal refetches it too, since APIs name clients. */
export const APIS_KEY = ['apis'] as const;
const BOUNDS_KEY = ['apiLifetimeBounds'] as const;

/**
 * Reads every API.
 *
 * @returns The query.
 */
export function useApis() {
  return useQuery({ queryKey: APIS_KEY, queryFn: async () => (await request(ApisDocument)).apis });
}

/**
 * Reads the bounds on an API's own access token lifetime.
 *
 * @returns The query.
 */
export function useApiLifetimeBounds() {
  return useQuery({
    queryKey: BOUNDS_KEY,
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: APIS_KEY }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: APIS_KEY }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: APIS_KEY }),
  });
}
