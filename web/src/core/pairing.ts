import { MS_PER_SECOND } from '@server/core/wire.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  CancelPairingDocument,
  FinishPairingDocument,
  type FinishPairingInput,
  PairingChangedDocument,
  PairingDocument,
  type PairingFieldsFragment,
  type PairingInput,
  StartPairingDocument,
} from '@/__generated__/graphql';
import { PAIR_DIALOG_DEFAULTS } from '@/core/defaults';
import { request, subscribe } from '@/core/gql';
import { QUERY_KEYS, refetching } from '@/core/query-keys';

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
 * Says whether a paired app may still describe more to set up, so its pairing is asked for again: it is paired and
 * not finished, it has offered no API yet, and it has not been asked `PAIR_DIALOG_DEFAULTS.offerPolls` times.
 *
 * @param pairing - The pairing as last read, if any.
 * @param updates - How many times it has been read.
 * @returns True while it is still being looked at.
 */
function isLookingForOffers(pairing: PairingFieldsFragment | null | undefined, updates: number): boolean {
  return (
    pairing?.status === 'PAIRED' &&
    pairing.finished === false &&
    (pairing.offers?.api ?? null) === null &&
    updates <= PAIR_DIALOG_DEFAULTS.offerPolls
  );
}

/**
 * Names one pairing in the query cache.
 *
 * @param id - The pairing's id.
 * @returns Its query key.
 */
function pairingKey(id: string): readonly string[] {
  return [...QUERY_KEYS.pairings, id];
}

/**
 * Watches a pairing, asking again every couple of seconds while no app has registered with it. When one has, the
 * client list is fetched again so the new client shows.
 *
 * @param id - The pairing's id.
 * @returns The query, whose data is null once the pairing has expired or been cancelled, and whether the app may
 * still offer more to set up.
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
            queryClient.setQueryData(pairingKey(id), pairingChanged);
            if (pairingChanged?.status === 'PAIRED') {
              void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients });
            }
          },
        },
      ),
    [queryClient, id],
  );
  const query = useQuery({
    queryKey: pairingKey(id),
    queryFn: async () => (await request(PairingDocument, { id })).pairing,
    // An app is often still finishing its pairing when it first shows as paired, and describes its API only after,
    // so ask again for a while until it does.
    refetchInterval: (current) =>
      isLookingForOffers(current.state.data, current.state.dataUpdateCount)
        ? PAIR_DIALOG_DEFAULTS.offerPollSeconds * MS_PER_SECOND
        : false,
    // Render again on every answer, even one that changed nothing, so the count of answers read below is current.
    notifyOnChangeProps: 'all',
  });
  const updates = queryClient.getQueryState(pairingKey(id))?.dataUpdateCount ?? 0;
  return { query, isLookingForOffers: isLookingForOffers(query.data, updates) };
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
    onSuccess: refetching(queryClient, QUERY_KEYS.pairings),
  });
}

/**
 * Sets up what a paired app offers besides its sign-in: its device client's device flow, its API.
 *
 * @returns The mutation; it resolves to the pairing, finished.
 */
export function useFinishPairing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: FinishPairingInput }) =>
      (await request(FinishPairingDocument, { id, input })).finishPairing,
    onSuccess: (pairing) => {
      queryClient.setQueryData(pairingKey(pairing.id), pairing);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.clients }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.apis }),
      ]);
    },
  });
}
