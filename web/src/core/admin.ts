import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  AuditEntryAddedDocument,
  type AuditEntryFieldsFragment,
  AuditLogDocument,
  type AuditLogQuery,
  type AuditType,
  CancelPairingDocument,
  type ClientInput,
  ClientsDocument,
  CreateClientDocument,
  CreatePasswordLinkDocument,
  CreateUserDocument,
  DeleteClientDocument,
  DeleteGroupDocument,
  DeleteUserDocument,
  EndUserSessionDocument,
  GroupsDocument,
  HttpRedirectsDocument,
  KeysDocument,
  type NewClientInput,
  type NewUserInput,
  PairingChangedDocument,
  PairingDocument,
  type PairingInput,
  ProviderDocument,
  RenameGroupDocument,
  ResetSecondFactorsDocument,
  RotateClientSecretDocument,
  RotateKeysDocument,
  SetBrandingLogoDocument,
  SetBrandingNameDocument,
  SetHttpRedirectsDocument,
  SetUserDisabledDocument,
  SetUserPasswordDocument,
  SignOutUserDocument,
  StartPairingDocument,
  TokenLifetimeDefaultsDocument,
  UpdateClientDocument,
  UpdateUserDocument,
  type UserInput,
  UserSessionsDocument,
  UsersDocument,
  ViewerDocument,
} from '@/__generated__/graphql';
import { request, subscribe } from '@/core/gql';
import { jsonReply, postJson } from '@/core/json-reply';

/** The react-query keys of the admin API's lists. */
const KEYS = {
  viewer: ['viewer'],
  provider: ['provider'],
  clients: ['clients'],
  users: ['users'],
  sessions: ['sessions'],
  groups: ['groups'],
  keys: ['keys'],
  branding: ['branding'],
  pairings: ['pairings'],
  httpRedirects: ['httpRedirects'],
  tokenLifetimeDefaults: ['tokenLifetimeDefaults'],
  audit: ['audit'],
} as const;

/**
 * Builds a mutation hook's `onSuccess` that refetches one list.
 *
 * @param queryClient - The app's query client.
 * @param key - The list to refetch.
 * @returns The handler.
 */
function refetching(queryClient: QueryClient, ...keys: (readonly string[])[]) {
  return () => Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
}

const brandingSchema = z.object({ name: z.string(), logoUrl: z.string().nullable() });

/** What the sidebar and the sign-in pages show the provider as. */
export type Branding = z.infer<typeof brandingSchema>;

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
 * Reads the token lifetimes a client gets unless it is given its own, and the bounds on its own.
 *
 * @returns The query.
 */
export function useTokenLifetimeDefaults() {
  return useQuery({
    queryKey: KEYS.tokenLifetimeDefaults,
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
    onSuccess: refetching(queryClient, KEYS.clients, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.clients, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.clients, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.users, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.users, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.users),
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
    onSuccess: refetching(queryClient, KEYS.users, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.users, KEYS.sessions),
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
    queryKey: [...KEYS.sessions, id],
    queryFn: async () => (await request(UserSessionsDocument, { id })).user.sessions,
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
    onSuccess: refetching(queryClient, KEYS.sessions),
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
    onSuccess: refetching(queryClient, KEYS.sessions),
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
    onSuccess: refetching(queryClient, KEYS.users),
  });
}

/**
 * Makes a setup URL an app pairs itself with.
 *
 * @returns The mutation; it resolves to the pairing and its URL, which is shown only this once.
 */
export function useStartPairing() {
  return useMutation({
    mutationFn: async (input: PairingInput) => (await request(StartPairingDocument, { input })).startPairing,
  });
}

/**
 * Watches a pairing, asking again every couple of seconds while no app has registered with it. When one has, the
 * client list is fetched again so the new client shows.
 *
 * @param id - The pairing's id.
 * @returns The query; its data is null once the pairing has expired or been cancelled.
 */
export function usePairing(id: string) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribe(
        PairingChangedDocument,
        { id },
        {
          onData: ({ pairingChanged }) => {
            queryClient.setQueryData([...KEYS.pairings, id], pairingChanged);
            if (pairingChanged?.status === 'PAIRED') {
              void queryClient.invalidateQueries({ queryKey: KEYS.clients });
            }
          },
        },
      ),
    [queryClient, id],
  );
  return useQuery({
    queryKey: [...KEYS.pairings, id],
    queryFn: async () => (await request(PairingDocument, { id })).pairing,
  });
}

/**
 * Stops a setup URL working.
 *
 * @returns The mutation; it resolves to whether the pairing was still waiting.
 */
export function useCancelPairing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(CancelPairingDocument, { id })).cancelPairing,
    onSuccess: refetching(queryClient, KEYS.pairings),
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

/**
 * Reads every group a user or client names.
 *
 * @returns The query.
 */
export function useGroups() {
  return useQuery({ queryKey: KEYS.groups, queryFn: async () => (await request(GroupsDocument)).groups });
}

/**
 * Lists the groups as options for a groups field.
 *
 * @returns One option per group, by name.
 */
export function useGroupOptions() {
  const { data } = useGroups();
  return (data ?? []).map(({ name }) => ({ value: name, label: name }));
}

/**
 * Renames a group in every user and client.
 *
 * @returns The mutation.
 */
export function useRenameGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { name: string; newName: string }) =>
      (await request(RenameGroupDocument, vars)).renameGroup,
    onSuccess: refetching(queryClient, KEYS.groups, KEYS.users, KEYS.clients),
  });
}

/**
 * Takes a group off every user.
 *
 * @returns The mutation; it resolves to how many users had it.
 */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => (await request(DeleteGroupDocument, { name })).deleteGroup,
    onSuccess: refetching(queryClient, KEYS.groups, KEYS.users),
  });
}

/**
 * Reads the signing keys.
 *
 * @returns The query.
 */
export function useKeys() {
  return useQuery({ queryKey: KEYS.keys, queryFn: async () => (await request(KeysDocument)).keys });
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
    onSuccess: (keys) => queryClient.setQueryData(KEYS.keys, keys),
  });
}

/**
 * Reads whether redirect URIs may be plain http.
 *
 * @returns The query.
 */
export function useHttpRedirects() {
  return useQuery({
    queryKey: KEYS.httpRedirects,
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
      queryClient.setQueryData(KEYS.httpRedirects, setting);
      await queryClient.invalidateQueries({ queryKey: KEYS.clients });
    },
  });
}

/**
 * Reads the provider's name and logo. Public: the sign-in pages show it too.
 *
 * @returns The query.
 */
export function useBranding() {
  return useQuery({
    queryKey: KEYS.branding,
    queryFn: async () => jsonReply(await fetch('/admin/branding'), brandingSchema),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Renames the provider.
 *
 * @returns The mutation.
 */
export function useSetBrandingName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => (await request(SetBrandingNameDocument, { name })).setBrandingName,
    onSuccess: (branding) => queryClient.setQueryData(KEYS.branding, branding),
  });
}

/**
 * Sets the logo from a data URL, or removes it with null.
 *
 * @returns The mutation.
 */
export function useSetBrandingLogo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (dataUrl: string | null) => (await request(SetBrandingLogoDocument, { dataUrl })).setBrandingLogo,
    onSuccess: (branding) => queryClient.setQueryData(KEYS.branding, branding),
  });
}

/** Which audit log entries the activity page shows. */
export interface AuditFilters {
  /** Only this type, or every type with null. */
  type: AuditType | null;
  /** Only entries done by or to this user, or everyone's with null. */
  userId: string | null;
}

/** The first page of the audit log has no cursor. */
const FIRST_PAGE: string | null = null;

/**
 * Reads the audit log, newest first, a page at a time.
 *
 * @param filters - The type and user to keep.
 * @returns The infinite query; `fetchNextPage` loads the next page.
 */
export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: [...KEYS.audit, filters],
    queryFn: async ({ pageParam }) => (await request(AuditLogDocument, { ...filters, after: pageParam })).auditLog,
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/** The audit log's pages as the query cache holds them. */
type AuditPages = InfiniteData<AuditLogQuery['auditLog'], string | null>;

/**
 * Puts a new entry at the top of the cached first page, once.
 *
 * @param data - The cached pages.
 * @param entry - The entry the server just recorded.
 * @returns The pages with it.
 */
function withNewEntry(data: AuditPages | undefined, entry: AuditEntryFieldsFragment): AuditPages | undefined {
  const [first, ...rest] = data?.pages ?? [];
  if (
    data === undefined ||
    first === undefined ||
    data.pages.some((page) => page.entries.some((e) => e.id === entry.id))
  ) {
    return data;
  }
  return { ...data, pages: [{ ...first, entries: [entry, ...first.entries] }, ...rest] };
}

/**
 * Follows the audit log while a page shows it: each entry the server records that passes the filters is added to
 * the top of `useAuditLog`'s first page. After a dropped stream opens again, the log is refetched for what was
 * missed.
 *
 * @param filters - The same filters `useAuditLog` was given.
 * @returns Whether the stream is open.
 */
export function useAuditFeed(filters: AuditFilters): boolean {
  const queryClient = useQueryClient();
  const [isLive, setLive] = useState(false);
  const { type, userId } = filters;
  useEffect(() => {
    const queryKey = [...KEYS.audit, { type, userId }];
    let hasOpened = false;
    const close = subscribe(
      AuditEntryAddedDocument,
      { type, userId },
      {
        onOpen: () => {
          setLive(true);
          if (hasOpened) {
            void queryClient.invalidateQueries({ queryKey });
          }
          hasOpened = true;
        },
        onData: ({ auditEntryAdded }) => {
          queryClient.setQueryData<AuditPages>(queryKey, (data) => withNewEntry(data, auditEntryAdded));
        },
        onComplete: () => setLive(false),
      },
    );
    return () => {
      close();
      setLive(false);
    };
  }, [queryClient, type, userId]);
  return isLive;
}
