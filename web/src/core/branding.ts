import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { SetBrandingLogoDocument, SetBrandingNameDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

const brandingSchema = z.object({ name: z.string(), logoUrl: z.string().nullable() });

/** What the sidebar and the sign-in pages show the provider as. */
export type Branding = z.infer<typeof brandingSchema>;

/**
 * Reads the provider's name and logo. Public: the sign-in pages show it too.
 *
 * @returns The query.
 */
export function useBranding() {
  return useQuery({
    queryKey: QUERY_KEYS.branding,
    queryFn: async () => jsonReply(await fetch('/api/branding'), brandingSchema),
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
    onSuccess: (branding) => queryClient.setQueryData(QUERY_KEYS.branding, branding),
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
    onSuccess: (branding) => queryClient.setQueryData(QUERY_KEYS.branding, branding),
  });
}
