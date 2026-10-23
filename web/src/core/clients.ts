import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ClientInput,
  ClientsDocument,
  CreateClientDocument,
  DeleteClientDocument,
  type NewClientInput,
  RotateClientSecretDocument,
  TokenLifetimeDefaultsDocument,
  UpdateClientDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/**
 * Reads the token lifetimes a client gets unless it is given its own, and the bounds on its own.
 *
 * @returns The query.
 */
export function useTokenLifetimeDefaults() {
  return useQuery({
    queryKey: QUERY_KEYS.tokenLifetimeDefaults,
    queryFn: async () => (await request(TokenLifetimeDefaultsDocument)).tokenLifetimeDefaults,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Reads every client.
 *
 * @returns The query.
 */
export function useClients() {
  return useQuery({ queryKey: QUERY_KEYS.clients, queryFn: async () => (await request(ClientsDocument)).clients });
}

/**
 * Adds a client.
 *
 * @returns The mutation; it resolves to the new client, secret included.
 */
export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewClientInput) => (await request(CreateClientDocument, { input })).createClient,
    onSuccess: refetching(queryClient, QUERY_KEYS.clients, QUERY_KEYS.groups),
  });
}

/**
 * Changes a client.
 *
 * @returns The mutation.
 */
export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { clientId: string; input: ClientInput }) =>
      (await request(UpdateClientDocument, vars)).updateClient,
    onSuccess: refetching(queryClient, QUERY_KEYS.clients, QUERY_KEYS.groups, QUERY_KEYS.apis),
  });
}

/**
 * Replaces a client's secret.
 *
 * @returns The mutation.
 */
export function useRotateClientSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) =>
      (await request(RotateClientSecretDocument, { clientId })).rotateClientSecret,
    onSuccess: refetching(queryClient, QUERY_KEYS.clients),
  });
}

/**
 * Removes a client.
 *
 * @returns The mutation.
 */
export function useDeleteClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (clientId: string) => (await request(DeleteClientDocument, { clientId })).deleteClient,
    onSuccess: refetching(queryClient, QUERY_KEYS.clients, QUERY_KEYS.groups, QUERY_KEYS.apis),
  });
}
