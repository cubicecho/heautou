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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { useDeleteUser, useResetSecondFactors, useSetUserDisabled, useUsers } from '@/core/admin';
import { Ban, Link2, MonitorSmartphone, ShieldCheck, ShieldOff, UserRoundCheck, UsersRound } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { LinkedAccountsDialog } from '@/users/linked-accounts-dialog';
import { PasswordDialog } from '@/users/password-dialog';
import { PasswordLinkDialog } from '@/users/password-link-dialog';
import { SessionsDialog } from '@/users/sessions-dialog';
import { UserFormDialog } from '@/users/user-form-dialog';

export const Route = createFileRoute('/users')({ component: UsersPage });

/** Which dialog is up, and for whom. */
type Dialog =
  | { kind: 'closed' }
  | { kind: 'new' }
  | { kind: 'edit'; user: UserFieldsFragment }
  | { kind: 'password'; user: UserFieldsFragment }
  | { kind: 'link'; user: UserFieldsFragment }
  | { kind: 'sessions'; user: UserFieldsFragment }
  | { kind: 'linked'; user: UserFieldsFragment };

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
 * Says whether a user signs in with a second factor.
 *
 * @param user - The user.
 * @returns True when they have an authenticator app or a passkey.
 */
function hasTwoFactor(user: UserFieldsFragment): boolean {
  const { hasTotp, passkeyCount } = user.secondFactors;
  return hasTotp || passkeyCount > 0;
}

/**
 * The badges a user's row carries: whether they are disabled, or invited and not signed up yet, whether they
 * use a second factor, and the sign-in providers they have linked.
 *
 * @param user - The user.
 * @returns The badges, or null for a user with none.
 */
function badgesOf(user: UserFieldsFragment) {
  const state = user.disabled ? (
    <Badge variant="destructive">Disabled</Badge>
  ) : user.hasPassword ? null : (
    <Badge variant="outline">Invited</Badge>
  );
  const twoFactor = hasTwoFactor(user) ? <Badge variant="outline">Two-factor</Badge> : null;
  const linked =
    user.upstreamLinks.length === 0 ? null : (
      <Badge variant="outline">{user.upstreamLinks.map((link) => link.providerName).join(', ')}</Badge>
    );
  return state === null && twoFactor === null && linked === null ? null : (
    <>
      {state}
      {twoFactor}
      {linked}
    </>
  );
}

/**
 * The users who can sign in, with add, edit, password links, sessions, disable and delete.
 */
function UsersPage() {
  const query = useUsers();
  const remove = useDeleteUser();
  const setDisabled = useSetUserDisabled();
  const resetTwoFactor = useResetSecondFactors();
  const failure = remove.error ?? setDisabled.error ?? resetTwoFactor.error;
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
          {failure === null ? null : (
            <Alert variant="destructive" title="User not changed" description={messageOf(failure)} />
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
                titleClassName={user.disabled ? 'text-foreground/60' : undefined}
                description={summaryOf(user)}
                meta={badgesOf(user)}
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
                      hint="Set password"
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<KeyRound />}
                      onClick={() => setDialog({ kind: 'password', user })}
                    />
                    <Button
                      aria-label={
                        user.hasPassword ? `Make a reset link for ${user.username}` : `Invite ${user.username}`
                      }
                      hint={user.hasPassword ? 'Reset link' : 'Invite link'}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Link2 />}
                      onClick={() => setDialog({ kind: 'link', user })}
                    />
                    <Button
                      aria-label={`${user.username}'s sessions`}
                      hint="Sessions"
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<MonitorSmartphone />}
                      onClick={() => setDialog({ kind: 'sessions', user })}
                    />
                    {user.upstreamLinks.length > 0 ? (
                      <Button
                        aria-label={`${user.username}'s linked accounts`}
                        hint="Linked accounts"
                        variant="outline"
                        size="icon-sm"
                        iconSlot={<ShieldCheck />}
                        onClick={() => setDialog({ kind: 'linked', user })}
                      />
                    ) : null}
                    {hasTwoFactor(user) ? (
                      <ConfirmButton
                        aria-label={`Reset ${user.username}'s two-factor sign-in`}
                        hint="Reset two-factor"
                        variant="destructive-outline"
                        size="icon-sm"
                        iconSlot={<ShieldOff />}
                        title={`Reset ${user.username}'s two-factor sign-in?`}
                        description="Their authenticator app, passkeys and recovery codes are removed, as for a lost phone. They sign in with their password alone until they add one again."
                        confirmLabel="Reset"
                        onConfirm={() => resetTwoFactor.mutate(user.id)}
                      />
                    ) : null}
                    {user.disabled ? (
                      <Button
                        aria-label={`Enable ${user.username}`}
                        hint="Enable"
                        variant="outline"
                        size="icon-sm"
                        iconSlot={<UserRoundCheck />}
                        onClick={() => setDisabled.mutate({ id: user.id, disabled: false })}
                      />
                    ) : (
                      <ConfirmButton
                        aria-label={`Disable ${user.username}`}
                        hint="Disable"
                        variant="destructive-outline"
                        size="icon-sm"
                        iconSlot={<Ban />}
                        title={`Disable ${user.username}?`}
                        description="They are signed out of every browser and application at once, and cannot sign in until enabled again."
                        confirmLabel="Disable"
                        onConfirm={() => setDisabled.mutate({ id: user.id, disabled: true })}
                      />
                    )}
                    <ConfirmButton
                      aria-label={`Delete ${user.username}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Delete ${user.username}?`}
                      description="They can no longer sign in to any client, and their sessions and tokens end at once."
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
              onInvited={(user) => setDialog({ kind: 'link', user })}
            />
          ) : null}
          {dialog.kind === 'password' ? (
            <PasswordDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          ) : null}
          {dialog.kind === 'link' ? (
            <PasswordLinkDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          ) : null}
          {dialog.kind === 'linked' ? (
            <LinkedAccountsDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          ) : null}
          {dialog.kind === 'sessions' ? (
            <SessionsDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          ) : null}
        </>
      }
    />
  );
}
