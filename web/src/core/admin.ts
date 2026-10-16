import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  type ClientInput,
  ClientsDocument,
  CreateClientDocument,
  CreateUserDocument,
  DeleteClientDocument,
  DeleteUserDocument,
  type NewClientInput,
  type NewUserInput,
  ProviderDocument,
  RotateClientSecretDocument,
  SetUserPasswordDocument,
  UpdateClientDocument,
  UpdateUserDocument,
  type UserInput,
  UsersDocument,
  ViewerDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply, postJson } from '@/core/json-reply';

/** The react-query keys of the admin API's lists. */
const KEYS = {
  viewer: ['viewer'],
  provider: ['provider'],
  clients: ['clients'],
  users: ['users'],
} as const;

/**
 * Builds a mutation hook's `onSuccess` that refetches one list.
 *
 * @param queryClient - The app's query client.
 * @param key - The list to refetch.
 * @returns The handler.
 */
function refetching(queryClient: QueryClient, key: readonly string[]) {
  return () => queryClient.invalidateQueries({ queryKey: key });
}

const signOutSchema = z.object({ redirectTo: z.string() });

/**
 * Reads the signed-in admin.
 *
 * @returns The query.
 */
export function useViewer() {
  return useQuery({ queryKey: KEYS.viewer, queryFn: async () => (await request(ViewerDocument)).viewer });
}

/**
 * Ends the admin session, then sends the browser to the provider to sign out there too.
 */
export async function signOut(): Promise<void> {
  const { redirectTo } = await jsonReply(await postJson('/admin/logout', {}), signOutSchema);
  window.location.assign(redirectTo);
}

/**
 * Reads the issuer and the URLs an application is pointed at.
 *
 * @returns The query.
 */
export function useProviderInfo() {
  return useQuery({ queryKey: KEYS.provider, queryFn: async () => (await request(ProviderDocument)).provider });
}

/**
 * Reads every client.
 *
 * @returns The query.
 */
export function useClients() {
  return useQuery({ queryKey: KEYS.clients, queryFn: async () => (await request(ClientsDocument)).clients });
}

/**
 * Reads every user.
 *
 * @returns The query.
 */
export function useUsers() {
  return useQuery({ queryKey: KEYS.users, queryFn: async () => (await request(UsersDocument)).users });
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
    onSuccess: refetching(queryClient, KEYS.clients),
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
    onSuccess: refetching(queryClient, KEYS.clients),
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
    onSuccess: refetching(queryClient, KEYS.clients),
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
    onSuccess: refetching(queryClient, KEYS.clients),
  });
}

/**
 * Adds a user.
 *
 * @returns The mutation.
 */
export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewUserInput) => (await request(CreateUserDocument, { input })).createUser,
    onSuccess: refetching(queryClient, KEYS.users),
  });
}

/**
 * Changes a user's details.
 *
 * @returns The mutation.
 */
export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; input: UserInput }) => (await request(UpdateUserDocument, vars)).updateUser,
    onSuccess: refetching(queryClient, KEYS.users),
  });
}

/**
 * Sets a user's password.
 *
 * @returns The mutation.
 */
export function useSetUserPassword() {
  return useMutation({
    mutationFn: async (vars: { id: string; password: string }) =>
      (await request(SetUserPasswordDocument, vars)).setUserPassword,
  });
}

/**
 * Removes a user.
 *
 * @returns The mutation.
 */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(DeleteUserDocument, { id })).deleteUser,
    onSuccess: refetching(queryClient, KEYS.users),
  });
}
