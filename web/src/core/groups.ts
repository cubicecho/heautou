import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteGroupDocument, GroupsDocument, RenameGroupDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/**
 * Reads every group a user or client names.
 *
 * @returns The query.
 */
export function useGroups() {
  return useQuery({ queryKey: QUERY_KEYS.groups, queryFn: async () => (await request(GroupsDocument)).groups });
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
    onSuccess: refetching(queryClient, QUERY_KEYS.groups, QUERY_KEYS.users, QUERY_KEYS.clients),
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
    onSuccess: refetching(queryClient, QUERY_KEYS.groups, QUERY_KEYS.users),
  });
}
