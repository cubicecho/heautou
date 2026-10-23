import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ViewerDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply, postJson } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

const signOutSchema = z.object({ redirectTo: z.string() });

/**
 * Reads the signed-in admin.
 *
 * @returns The query.
 */
export function useViewer() {
  return useQuery({ queryKey: QUERY_KEYS.viewer, queryFn: async () => (await request(ViewerDocument)).viewer });
}

/**
 * Ends the admin session, then sends the browser to the provider to sign out there too.
 */
export async function signOut(): Promise<void> {
  const { redirectTo } = await jsonReply(await postJson('/admin/logout', {}), signOutSchema);
  window.location.assign(redirectTo);
}
