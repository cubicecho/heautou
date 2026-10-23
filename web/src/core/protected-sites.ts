import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateProtectedSiteDocument,
  DeleteProtectedSiteDocument,
  ForwardAuthDocument,
  type ProtectedSiteInput,
  ProtectedSitesDocument,
  SetForwardAuthCookieDomainDocument,
  UpdateProtectedSiteDocument,
} from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

/**
 * Reads the protected sites.
 *
 * @returns The query.
 */
export function useProtectedSites() {
  return useQuery({
    queryKey: QUERY_KEYS.protectedSites,
    queryFn: async () => (await request(ProtectedSitesDocument)).protectedSites,
  });
}

/**
 * Reads forward auth's addresses and cookie domain.
 *
 * @returns The query.
 */
export function useForwardAuth() {
  return useQuery({
    queryKey: QUERY_KEYS.forwardAuth,
    queryFn: async () => (await request(ForwardAuthDocument)).forwardAuth,
  });
}

/**
 * Adds a protected site.
 *
 * @returns The mutation; it resolves to the new site.
 */
export function useCreateProtectedSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProtectedSiteInput) =>
      (await request(CreateProtectedSiteDocument, { input })).createProtectedSite,
    onSuccess: refetching(queryClient, QUERY_KEYS.protectedSites, QUERY_KEYS.groups),
  });
}

/**
 * Changes a protected site.
 *
 * @returns The mutation; it resolves to the site.
 */
export function useUpdateProtectedSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; input: ProtectedSiteInput }) =>
      (await request(UpdateProtectedSiteDocument, vars)).updateProtectedSite,
    onSuccess: refetching(queryClient, QUERY_KEYS.protectedSites, QUERY_KEYS.groups),
  });
}

/**
 * Removes a protected site.
 *
 * @returns The mutation.
 */
export function useDeleteProtectedSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await request(DeleteProtectedSiteDocument, { id })).deleteProtectedSite,
    onSuccess: refetching(queryClient, QUERY_KEYS.protectedSites, QUERY_KEYS.groups),
  });
}

/**
 * Sets the domain the proxy session cookie is set on.
 *
 * @returns The mutation; null clears it.
 */
export function useSetForwardAuthCookieDomain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (domain: string | null) =>
      (await request(SetForwardAuthCookieDomainDocument, { domain })).setForwardAuthCookieDomain,
    onSuccess: refetching(queryClient, QUERY_KEYS.forwardAuth),
  });
}
