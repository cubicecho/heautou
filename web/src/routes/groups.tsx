import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { GroupsQuery } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil, Trash2 } from '@/components/ui/icons';
import { useDeleteGroup, useGroups } from '@/core/admin';
import { Tags } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { RenameGroupDialog } from '@/groups/rename-group-dialog';
import { formatCount, joinStats } from '@/lib/format';

export const Route = createFileRoute('/groups')({ component: GroupsPage });

type Group = GroupsQuery['groups'][number];

/**
 * A line on who is in a group and which clients only let it in.
 *
 * @param group - The group.
 * @returns The line.
 */
function summaryOf(group: Group): string {
  const members = group.members.map((member) => member.username).join(', ');
  return joinStats(
    group.members.length === 0 ? 'No users' : `${formatCount(group.members.length, 'user')}: ${members}`,
    group.clients.length > 0 && `Limits ${group.clients.map((client) => client.name).join(', ')}`,
  );
}

/**
 * Says why a group cannot be deleted, or nothing when it can.
 *
 * @param group - The group.
 * @returns The reason, for the button's hint.
 */
function deleteBlocker(group: Group): string | undefined {
  if (group.isProtected) {
    return 'The admin group cannot be deleted.';
  }
  return group.clients.length > 0 ? 'A client is limited to it. Change its allowed groups first.' : undefined;
}

/**
 * Every group a user or client names, with rename and delete. Groups are made by giving them to a user.
 */
function GroupsPage() {
  const query = useGroups();
  const remove = useDeleteGroup();
  const groups = query.data ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <PageLayout
      title="Groups"
      description="The groups users hold and clients can be limited to. Add one by giving it to a user."
      contentClassName="gap-4"
      contentSlot={
        <>
          {remove.error === null ? null : (
            <Alert variant="destructive" title="Group not deleted" description={messageOf(remove.error)} />
          )}
          <QueryState
            query={query}
            what="the groups"
            count={groups.length}
            emptySlot={
              <EmptyState iconSlot={<Tags />} title="No groups yet" description="Give a user a group to add one." />
            }
          />
          <List
            label="Groups"
            contentSlot={groups.map((group) => {
              const blocker = deleteBlocker(group);
              return (
                <ListItem
                  key={group.name}
                  title={group.name}
                  description={summaryOf(group)}
                  meta={group.isProtected ? <Badge variant="secondary">Admins</Badge> : null}
                  actionSlot={
                    <>
                      <Button
                        aria-label={`Rename ${group.name}`}
                        hint={group.isProtected ? 'The admin group keeps its name.' : 'Rename'}
                        variant="outline"
                        size="icon-sm"
                        iconSlot={<Pencil />}
                        disabled={group.isProtected}
                        onClick={() => setRenaming(group.name)}
                      />
                      <ConfirmButton
                        aria-label={`Delete ${group.name}`}
                        hint={blocker ?? 'Delete'}
                        variant="destructive-outline"
                        size="icon-sm"
                        iconSlot={<Trash2 />}
                        disabled={blocker !== undefined}
                        title={`Delete ${group.name}?`}
                        description={`It is taken off ${formatCount(group.members.length, 'user')}. Applications that map it to a role stop giving them that role.`}
                        onConfirm={() => remove.mutate(group.name)}
                      />
                    </>
                  }
                />
              );
            })}
          />
          {renaming === null ? null : (
            <RenameGroupDialog
              key={renaming}
              name={renaming}
              open
              onOpenChange={(open) => {
                if (open === false) {
                  setRenaming(null);
                }
              }}
            />
          )}
        </>
      }
    />
  );
}
