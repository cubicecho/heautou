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
/** The client list's key (`KEYS.clients` in admin.ts, which imports this file): each client shows the APIs it may use. */
const CLIENTS_KEY = ['clients'] as const;

/**
 * Fetches the APIs, and the clients that show them, again after one changed.
 *
 * @param queryClient - The query client.
 * @returns When both are fetched.
 */
const refetchApisAndClients = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: APIS_KEY }),
    queryClient.invalidateQueries({ queryKey: CLIENTS_KEY }),
  ]);
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
    onSuccess: () => refetchApisAndClients(queryClient),
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
    onSuccess: () => refetchApisAndClients(queryClient),
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
    onSuccess: () => refetchApisAndClients(queryClient),
  });
}
