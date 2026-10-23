import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { AuditEntryFieldsFragment } from '@/__generated__/graphql';
import {
  AUDIT_TYPE_OPTIONS,
  auditTypeLabel,
  detailText,
  isAuditType,
  isWarning,
  targetKindLabel,
} from '@/activity/audit-types';
import { Combobox } from '@/components/combobox';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Activity } from '@/core/app-icons';
import { type AuditFilters, useAuditFeed, useAuditLog } from '@/core/audit';
import { useUsers } from '@/core/users';
import { formatAgo, formatDateTime, joinStats } from '@/lib/format';

export const Route = createFileRoute('/activity')({ component: ActivityPage });

type Entry = AuditEntryFieldsFragment;

/**
 * A line on who did it, to what, from where, and the entry's detail.
 *
 * @param entry - The entry.
 * @returns The line.
 */
function summaryOf(entry: Entry): string {
  return joinStats(
    entry.actorUserId === null ? 'Nobody signed in' : `By ${entry.actorUsername ?? ''}`,
    entry.targetKind !== null && `${targetKindLabel(entry.targetKind)} ${entry.targetName ?? ''}`,
    entry.ip !== null && `from ${entry.ip}`,
    ...Object.entries(entry.detail).map(([name, value]) => detailText(name, String(value))),
  );
}

/**
 * Reads a filter's pick, where clearing it gives the empty string.
 *
 * @param value - What the filter picked.
 * @returns The value, or null for none.
 */
function pickOf(value: string): string | null {
  return value === '' ? null : value;
}

/**
 * The audit log, newest first: sign-ins, admin changes and account changes, with a type and a user filter. New
 * entries appear while the page is open.
 */
function ActivityPage() {
  const [filters, setFilters] = useState<AuditFilters>({ type: null, userId: null });
  const query = useAuditLog(filters);
  const isLive = useAuditFeed(filters);
  const users = useUsers();
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const userOptions = (users.data ?? []).map((user) => ({ value: user.id, label: user.username }));
  const filtered = filters.type !== null || filters.userId !== null;

  return (
    <PageLayout
      title="Activity"
      description="Who signed in where, and every change made here. Passwords, secrets and links are never kept."
      contentClassName="gap-4"
      headerContentSlot={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isLive ? 'positive' : 'outline'} title="New entries appear as they happen.">
            {isLive ? 'Live' : 'Connecting…'}
          </Badge>
          <Combobox
            className="w-56"
            options={AUDIT_TYPE_OPTIONS}
            value={filters.type ?? ''}
            placeholder="Every kind"
            searchable
            clearable
            onValueChange={(value) => {
              const type = pickOf(value);
              setFilters({ ...filters, type: type !== null && isAuditType(type) ? type : null });
            }}
          />
          <Combobox
            className="w-56"
            options={userOptions}
            value={filters.userId ?? ''}
            placeholder="Every user"
            searchable
            clearable
            onValueChange={(value) => setFilters({ ...filters, userId: pickOf(value) })}
          />
        </div>
      }
      contentSlot={
        <>
          <QueryState
            query={query}
            what="the activity"
            count={entries.length}
            emptySlot={
              <EmptyState
                iconSlot={<Activity />}
                title={filtered ? 'Nothing matches' : 'Nothing yet'}
                description={filtered ? 'Clear a filter to see more.' : 'Sign-ins and changes show up here.'}
              />
            }
          />
          <List
            label="Activity"
            contentSlot={entries.map((entry) => (
              <ListItem
                key={entry.id}
                title={auditTypeLabel(entry.type)}
                description={summaryOf(entry)}
                meta={
                  // Quieter than the title, since what happened is read first. The tooltip has the exact time.
                  <span className="flex items-center gap-2 text-foreground/60 text-xs" title={formatDateTime(entry.at)}>
                    {isWarning(entry.type) ? <Badge variant="destructive">Failed</Badge> : null}
                    {formatAgo(entry.at)}
                  </span>
                }
              />
            ))}
          />
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                content="Load more"
                loading={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              />
            </div>
          ) : null}
        </>
      }
    />
  );
}
