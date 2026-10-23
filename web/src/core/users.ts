import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreatePasswordLinkDocument,
  CreateUserDocument,
  DeleteUserDocument,
  EndUserSessionDocument,
  type NewUserInput,
  ResetSecondFactorsDocument,
  SetUserDisabledDocument,
  SetUserPasswordDocument,
  SignOutUserDocument,
  UpdateUserDocument,
  type UserInput,
  UserSessionsDocument,
  UsersDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/**
 * Reads every user.
 *
 * @returns The query.
 */
export function useUsers() {
  return useQuery({ queryKey: QUERY_KEYS.users, queryFn: async () => (await request(UsersDocument)).users });
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
    onSuccess: refetching(queryClient, QUERY_KEYS.users, QUERY_KEYS.groups),
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
    onSuccess: refetching(queryClient, QUERY_KEYS.users, QUERY_KEYS.groups),
  });
}

/**
 * Sets a user's password.
 *
 * @returns The mutation.
 */
export function useSetUserPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; password: string }) =>
      (await request(SetUserPasswordDocument, vars)).setUserPassword,
    onSuccess: refetching(queryClient, QUERY_KEYS.users),
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
    onSuccess: refetching(queryClient, QUERY_KEYS.users, QUERY_KEYS.groups),
  });
}

/**
 * Disables or enables a user. Disabling ends their sessions and tokens.
 *
 * @returns The mutation.
 */
export function useSetUserDisabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; disabled: boolean }) =>
      (await request(SetUserDisabledDocument, vars)).setUserDisabled,
    onSuccess: refetching(queryClient, QUERY_KEYS.users, QUERY_KEYS.sessions),
  });
}

/**
 * Reads the browsers signed in as a user.
 *
 * @param id - The user.
 * @returns The query.
 */
export function useUserSessions(id: string) {
  return useQuery({
    queryKey: [...QUERY_KEYS.sessions, id],
    queryFn: async () => (await request(UserSessionsDocument, { id })).user?.sessions ?? [],
  });
}

/**
 * Ends one of a user's sessions.
 *
 * @returns The mutation.
 */
export function useEndUserSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; sessionId: string }) =>
      (await request(EndUserSessionDocument, vars)).endUserSession,
    onSuccess: refetching(queryClient, QUERY_KEYS.sessions),
  });
}

/**
 * Ends every session and token of a user.
 *
 * @returns The mutation.
 */
export function useSignOutUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(SignOutUserDocument, { id })).signOutUser,
    onSuccess: refetching(queryClient, QUERY_KEYS.sessions),
  });
}

/**
 * Removes every second factor a user has, as for a lost phone.
 *
 * @returns The mutation.
 */
export function useResetSecondFactors() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(ResetSecondFactorsDocument, { id })).resetSecondFactors,
    onSuccess: refetching(queryClient, QUERY_KEYS.users),
  });
}

/**
 * Makes a link that sets a user's password. Their previous link stops working.
 *
 * @returns The mutation; it resolves to the link.
 */
export function useCreatePasswordLink() {
  return useMutation({
    mutationFn: async (id: string) => (await request(CreatePasswordLinkDocument, { id })).createPasswordLink,
  });
}
