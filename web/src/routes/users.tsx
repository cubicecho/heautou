import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { UserFieldsFragment } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { KeyRound, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { useDeleteUser, useUsers } from '@/core/admin';
import { UsersRound } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { PasswordDialog } from '@/users/password-dialog';
import { UserFormDialog } from '@/users/user-form-dialog';

export const Route = createFileRoute('/users')({ component: UsersPage });

/** Which dialog is up, and for whom. */
type Dialog =
  | { kind: 'closed' }
  | { kind: 'new' }
  | { kind: 'edit'; user: UserFieldsFragment }
  | { kind: 'password'; user: UserFieldsFragment };

/**
 * A line on who a user is: their name, email and groups, whichever they have.
 *
 * @param user - The user.
 * @returns The line.
 */
function summaryOf(user: UserFieldsFragment): string {
  const groups = user.groups.length === 0 ? '' : `Groups: ${user.groups.join(', ')}`;
  return [user.name, user.email, groups].filter((part) => part !== '').join(' · ') || 'No details yet';
}

/**
 * The users who can sign in, with add, edit, password and delete.
 */
function UsersPage() {
  const query = useUsers();
  const remove = useDeleteUser();
  const users = query.data ?? [];
  const [dialog, setDialog] = useState<Dialog>({ kind: 'closed' });
  const close = (open: boolean) => {
    if (open === false) {
      setDialog({ kind: 'closed' });
    }
  };

  return (
    <PageLayout
      title="Users"
      description="The people who can sign in to your clients."
      actionSlot={
        <Button
          variant="info"
          size="sm"
          iconSlot={<Plus />}
          content="New user"
          onClick={() => setDialog({ kind: 'new' })}
        />
      }
      contentClassName="gap-4"
      contentSlot={
        <>
          {remove.error === null ? null : (
            <Alert variant="destructive" title="User not deleted" description={messageOf(remove.error)} />
          )}
          <QueryState
            query={query}
            what="the users"
            count={users.length}
            emptySlot={
              <EmptyState
                iconSlot={<UsersRound />}
                title="No users yet"
                description="Add someone so there is an account to sign in with."
                actionSlot={
                  <Button
                    variant="info"
                    iconSlot={<Plus />}
                    content="New user"
                    onClick={() => setDialog({ kind: 'new' })}
                  />
                }
              />
            }
          />
          <List
            label="Users"
            contentSlot={users.map((user) => (
              <ListItem
                key={user.id}
                title={user.username}
                description={summaryOf(user)}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${user.username}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setDialog({ kind: 'edit', user })}
                    />
                    <Button
                      aria-label={`Set ${user.username}'s password`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<KeyRound />}
                      onClick={() => setDialog({ kind: 'password', user })}
                    />
                    <ConfirmButton
                      aria-label={`Delete ${user.username}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Delete ${user.username}?`}
                      description="They can no longer sign in to any client. Sessions already signed in end when they next refresh."
                      onConfirm={() => remove.mutate(user.id)}
                    />
                  </>
                }
              />
            ))}
          />
          {dialog.kind === 'new' || dialog.kind === 'edit' ? (
            <UserFormDialog
              key={dialog.kind === 'edit' ? dialog.user.id : 'new'}
              user={dialog.kind === 'edit' ? dialog.user : null}
              open
              onOpenChange={close}
            />
          ) : null}
          {dialog.kind === 'password' ? (
            <PasswordDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          ) : null}
        </>
      }
    />
  );
}
