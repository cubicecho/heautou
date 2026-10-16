import { QueryClient } from '@tanstack/react-query';

/**
 * Builds the app's query client.
 *
 * @returns A client that neither retries nor refetches on focus.
 *
 * @remarks
 * The subscription keeps the cache current, so a refetch on focus would only repeat it.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY } },
  });
}
