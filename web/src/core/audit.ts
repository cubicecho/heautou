import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  AuditEntriesDocument,
  AuditEntryAddedDocument,
  type AuditEntryFieldsFragment,
  type AuditEntryFilters,
  AuditTargetKind,
  type AuditType,
} from '@/__generated__/graphql';
import { ACTIVITY_DEFAULTS } from '@/core/defaults';
import { request, subscribe } from '@/core/gql';
import { QUERY_KEYS } from '@/core/query-keys';

/** Which audit log entries the activity page shows. */
export interface AuditFilters {
  /** Only this type, or every type with null. */
  type: AuditType | null;
  /** Only entries done by or to this user, or everyone's with null. */
  userId: string | null;
}

/** The first page of the audit log has no cursor. */
const FIRST_PAGE: string | null = null;

/** One page of the audit log, and the cursor the next one starts after, or null on the last. */
interface AuditPage {
  entries: AuditEntryFieldsFragment[];
  nextCursor: string | null;
}

/** The audit log's pages as the query cache holds them. */
export type AuditPages = InfiniteData<AuditPage, string | null>;

/**
 * Turns the activity page's filters into the audit log's: one type, and entries done by the user or to them.
 *
 * @param filters - The type and user to keep.
 * @returns The filters, or null for every entry.
 */
export function auditWhere({ type, userId }: AuditFilters): AuditEntryFilters | null {
  const byType: AuditEntryFilters = type === null ? {} : { type: { eq: type } };
  const byUser: AuditEntryFilters =
    userId === null
      ? {}
      : {
          OR: [{ actorUserId: { eq: userId } }, { targetKind: { eq: AuditTargetKind.User }, targetId: { eq: userId } }],
        };
  const where = { ...byType, ...byUser };
  return Object.keys(where).length === 0 ? null : where;
}

/**
 * Reads one page of the audit log. It asks for one entry more than a page shows, to know whether another follows.
 *
 * @param filters - The type and user to keep.
 * @param after - The cursor of the entry the page starts after, or null for the newest.
 * @returns The page.
 */
async function auditPage(filters: AuditFilters, after: string | null): Promise<AuditPage> {
  const { auditEntries } = await request(AuditEntriesDocument, {
    limit: ACTIVITY_DEFAULTS.pageSize + 1,
    after,
    where: auditWhere(filters),
  });
  const entries = auditEntries.slice(0, ACTIVITY_DEFAULTS.pageSize);
  const hasMore = auditEntries.length > ACTIVITY_DEFAULTS.pageSize;
  return { entries, nextCursor: hasMore ? (entries.at(-1)?.cursor ?? null) : null };
}

/**
 * Reads the audit log, newest first, a page at a time.
 *
 * @param filters - The type and user to keep.
 * @returns The infinite query; `fetchNextPage` loads the next page.
 */
export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: [...QUERY_KEYS.audit, filters],
    queryFn: ({ pageParam }) => auditPage(filters, pageParam),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/**
 * Puts a new entry at the top of the cached first page, once.
 *
 * @param data - The cached pages.
 * @param entry - The entry the server just recorded.
 * @returns The pages with it.
 */
export function withNewEntry(data: AuditPages | undefined, entry: AuditEntryFieldsFragment): AuditPages | undefined {
  const [first, ...rest] = data?.pages ?? [];
  if (!data || !first) {
    return data;
  }
  const isCached = data.pages.some((page) => page.entries.some((cached) => cached.id === entry.id));
  if (isCached) {
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
    const queryKey = [...QUERY_KEYS.audit, { type, userId }];
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
