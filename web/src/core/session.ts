import { useQuery } from '@tanstack/react-query';
import { ViewerDocument } from '@/__generated__/graphql';
import { request } from '@/core/gql';
import { jsonReply, postJson, redirectReplySchema } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

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
  const { redirectTo } = await jsonReply(await postJson('/admin/logout', {}), redirectReplySchema);
  window.location.assign(redirectTo);
}
