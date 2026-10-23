import { useState } from 'react';
import type { UpstreamFieldsFragment } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { useDeleteUpstream, useUpstreams } from '@/core/admin';
import { messageOf } from '@/core/lists';
import { joinStats } from '@/lib/format';
import { UpstreamFormDialog } from '@/upstreams/upstream-form-dialog';

/** Which provider the dialog is open on: none, a new one, or one to edit. */
type UpstreamDialog = { kind: 'closed' } | { kind: 'open'; upstream: UpstreamFieldsFragment | null };

/**
 * The providers users may sign in through instead of with a password.
 */
export function UpstreamsSection() {
  const upstreams = useUpstreams();
  const remove = useDeleteUpstream();
  const [dialog, setDialog] = useState<UpstreamDialog>({ kind: 'closed' });
  const list = upstreams.data ?? [];

  return (
    <Section
      title="Sign-in providers"
      description="Accounts elsewhere, such as Google or GitHub, that users may sign in with. Each user links theirs from their account page."
      surface="card"
      actionSlot={
        <Button
          variant="outline"
          size="sm"
          iconSlot={<Plus />}
          content="Add provider"
          onClick={() => setDialog({ kind: 'open', upstream: null })}
        />
      }
      contentSlot={
        <div className="grid gap-2">
          {upstreams.isError ? (
            <QueryError error={upstreams.error} onRetry={upstreams.refetch} what="the sign-in providers" />
          ) : null}
          {upstreams.isSuccess && list.length === 0 ? (
            <EmptyState compact title="Users sign in with a password or a passkey only." />
          ) : null}
          <List
            label="Sign-in providers"
            contentSlot={list.map((upstream) => (
              <ListItem
                key={upstream.id}
                title={upstream.name}
                description={joinStats(
                  upstream.kind === 'GITHUB' ? 'GitHub' : upstream.issuer,
                  upstream.unknownIdentity === 'CREATE' ? 'makes users' : 'linked accounts only',
                  upstream.countsAsBothFactors && 'counts as both factors',
                )}
                meta={`${upstream.linksAggregate.count} linked`}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${upstream.name}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setDialog({ kind: 'open', upstream })}
                    />
                    <ConfirmButton
                      aria-label={`Remove ${upstream.name}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Remove ${upstream.name}?`}
                      description={`Its ${upstream.linksAggregate.count} linked accounts are unlinked. Users who only sign in through it need a password link to get back in.`}
                      confirmLabel="Remove"
                      onConfirm={() => remove.mutate(upstream.id)}
                    />
                  </>
                }
              />
            ))}
          />
          {remove.error === null ? null : (
            <Alert variant="destructive" title="Provider not removed" description={messageOf(remove.error)} />
          )}
          {dialog.kind === 'open' ? (
            <UpstreamFormDialog
              upstream={dialog.upstream}
              open
              onOpenChange={(open) => (open ? undefined : setDialog({ kind: 'closed' }))}
            />
          ) : null}
        </div>
      }
    />
  );
}
