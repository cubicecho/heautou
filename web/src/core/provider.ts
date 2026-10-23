import { useQuery } from '@tanstack/react-query';
import { ProviderDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { QUERY_KEYS } from '@/core/query-keys';

/**
 * Reads the issuer and the URLs an application is pointed at.
 *
 * @returns The query.
 */
export function useProviderInfo() {
  return useQuery({ queryKey: QUERY_KEYS.provider, queryFn: async () => (await request(ProviderDocument)).provider });
}
