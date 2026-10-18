import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** The react-query keys forward auth reads, and the groups list its sites add to. */
const KEYS = {
  sites: ['protectedSites'],
  forwardAuth: ['forwardAuth'],
  groups: ['groups'],
} as const;

/**
 * Builds a mutation hook's `onSuccess` that refetches the lists a change touched.
 *
 * @param queryClient - The app's query client.
 * @param keys - The lists to refetch.
 * @returns The handler.
 */
function refetching(queryClient: QueryClient, ...keys: (readonly string[])[]) {
  return () => Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
}

/**
 * Reads the protected sites.
 *
 * @returns The query.
 */
export function useProtectedSites() {
  return useQuery({
    queryKey: KEYS.sites,
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
    queryKey: KEYS.forwardAuth,
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
    onSuccess: refetching(queryClient, KEYS.sites, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.sites, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.sites, KEYS.groups),
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
    onSuccess: refetching(queryClient, KEYS.forwardAuth),
  });
}
