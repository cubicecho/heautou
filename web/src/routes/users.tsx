import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { UserFieldsFragment } from '@/__generated__/graphql';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Ellipsis, KeyRound, Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import {
  Ban,
  ImageUp,
  Link2,
  MonitorSmartphone,
  ShieldCheck,
  ShieldOff,
  UserRoundCheck,
  UsersRound,
} from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import { useGroups } from '@/core/groups';
import { useProfilePictures } from '@/core/pictures';
import { useDeleteUser, useResetSecondFactors, useSetUserDisabled, useUsers } from '@/core/users';
import { UpstreamsSection } from '@/upstreams/upstreams-section';
import { LinkedAccountsDialog } from '@/users/linked-accounts-dialog';
import { PasswordDialog } from '@/users/password-dialog';
import { PasswordLinkDialog } from '@/users/password-link-dialog';
import { PictureDialog } from '@/users/picture-dialog';
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
  | { kind: 'linked'; user: UserFieldsFragment }
  | { kind: 'picture'; user: UserFieldsFragment };

/** A destructive action a menu row asked to confirm. */
interface Confirming {
  title: string;
  /** What is lost. */
  description: string;
  /** The verb on the destructive button. */
  confirmLabel: string;
  onConfirm: () => void;
}

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
 * The badges a user's row carries: whether they are an admin, disabled, or invited and not signed up yet, whether they
 * use a second factor, and the sign-in providers they have linked.
 *
 * @param user - The user.
 * @param adminGroup - The group that makes a user an admin, or undefined while it loads.
 * @returns The badges, or null for a user with none.
 */
function badgesOf(user: UserFieldsFragment, adminGroup: string | undefined) {
  const isAdmin = adminGroup !== undefined && user.groups.includes(adminGroup);
  const admin = isAdmin ? <Badge variant="secondary">Admin</Badge> : null;
  const state = user.disabled ? (
    <Badge variant="destructive">Disabled</Badge>
  ) : user.hasPassword ? null : (
    <Badge variant="outline">Invited</Badge>
  );
  const twoFactor = hasTwoFactor(user) ? <Badge variant="outline">Two-factor</Badge> : null;
  const linked =
    user.upstreamLinks.length === 0 ? null : (
      <Badge variant="outline">{user.upstreamLinks.map((link) => link.provider.name).join(', ')}</Badge>
    );
  return admin === null && state === null && twoFactor === null && linked === null ? null : (
    <>
      {admin}
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
  const pictures = useProfilePictures().data;
  const failure = remove.error ?? setDisabled.error ?? resetTwoFactor.error;
  const users = query.data ?? [];
  const [dialog, setDialog] = useState<Dialog>({ kind: 'closed' });
  // Kept after the dialog closes, so its words stay put while it fades out.
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [isConfirmOpen, setConfirmOpen] = useState(false);
  /** Opens the confirm for a destructive row. */
  const askToConfirm = (next: Confirming): void => {
    setConfirming(next);
    setConfirmOpen(true);
  };
  const adminGroup = useGroups().data?.find((group) => group.isProtected)?.name;
  const close = (open: boolean) => {
    if (open === false) {
      setDialog({ kind: 'closed' });
    }
  };
  const isFormOpen = dialog.kind === 'new' || dialog.kind === 'edit';
  const isSettingPassword = dialog.kind === 'password';
  const isShowingLink = dialog.kind === 'link';
  const isShowingLinked = dialog.kind === 'linked';
  const isSettingPicture = dialog.kind === 'picture' && pictures !== undefined;
  const isShowingSessions = dialog.kind === 'sessions';

  return (
    <PageLayout
      title="Users"
      description="The people who can sign in to your clients, and the other accounts they may sign in with."
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
          {failure !== null && (
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
                leadingSlot={
                  user.pictureUrl ? (
                    <img src={user.pictureUrl} alt="" className="size-8 rounded-full object-cover" />
                  ) : undefined
                }
                description={summaryOf(user)}
                meta={badgesOf(user, adminGroup)}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${user.username}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setDialog({ kind: 'edit', user })}
                    />
                    <Menu>
                      <MenuTrigger asChild>
                        <Button
                          aria-label={`More for ${user.username}`}
                          variant="outline"
                          size="icon-sm"
                          iconSlot={<Ellipsis />}
                        />
                      </MenuTrigger>
                      <MenuContent align="end" aria-label={`More for ${user.username}`}>
                        <MenuItem
                          iconSlot={<KeyRound />}
                          label="Set password"
                          onSelect={() => setDialog({ kind: 'password', user })}
                        />
                        <MenuItem
                          iconSlot={<Link2 />}
                          label={user.hasPassword ? 'Reset link' : 'Invite link'}
                          onSelect={() => setDialog({ kind: 'link', user })}
                        />
                        {pictures?.isEnabled && (
                          <MenuItem
                            iconSlot={<ImageUp />}
                            label="Picture"
                            onSelect={() => setDialog({ kind: 'picture', user })}
                          />
                        )}
                        <MenuItem
                          iconSlot={<MonitorSmartphone />}
                          label="Sessions"
                          onSelect={() => setDialog({ kind: 'sessions', user })}
                        />
                        {user.upstreamLinks.length > 0 && (
                          <MenuItem
                            iconSlot={<ShieldCheck />}
                            label="Linked accounts"
                            onSelect={() => setDialog({ kind: 'linked', user })}
                          />
                        )}
                        {user.disabled && (
                          <MenuItem
                            iconSlot={<UserRoundCheck />}
                            label="Enable"
                            onSelect={() => setDisabled.mutate({ id: user.id, disabled: false })}
                          />
                        )}
                        <MenuSeparator />
                        {hasTwoFactor(user) && (
                          <MenuItem
                            iconSlot={<ShieldOff />}
                            label="Reset two-factor"
                            destructive
                            onSelect={() =>
                              askToConfirm({
                                title: `Reset ${user.username}'s two-factor sign-in?`,
                                description:
                                  'Their authenticator app, passkeys and recovery codes are removed, as for a lost phone. They sign in with their password alone until they add one again.',
                                confirmLabel: 'Reset',
                                onConfirm: () => resetTwoFactor.mutate(user.id),
                              })
                            }
                          />
                        )}
                        {user.disabled === false && (
                          <MenuItem
                            iconSlot={<Ban />}
                            label="Disable"
                            destructive
                            onSelect={() =>
                              askToConfirm({
                                title: `Disable ${user.username}?`,
                                description:
                                  'They are signed out of every browser and application at once, and cannot sign in until enabled again.',
                                confirmLabel: 'Disable',
                                onConfirm: () => setDisabled.mutate({ id: user.id, disabled: true }),
                              })
                            }
                          />
                        )}
                        <MenuItem
                          iconSlot={<Trash2 />}
                          label="Delete"
                          destructive
                          onSelect={() =>
                            askToConfirm({
                              title: `Delete ${user.username}?`,
                              description:
                                'They can no longer sign in to any client, and their sessions and tokens end at once.',
                              confirmLabel: 'Delete',
                              onConfirm: () => remove.mutate(user.id),
                            })
                          }
                        />
                      </MenuContent>
                    </Menu>
                  </>
                }
              />
            ))}
          />
          <UpstreamsSection />
          <ConfirmDialog
            open={isConfirmOpen}
            onOpenChange={setConfirmOpen}
            title={confirming?.title}
            description={confirming?.description}
            confirmLabel={confirming?.confirmLabel}
            onConfirm={() => confirming?.onConfirm()}
          />
          {isFormOpen && (
            <UserFormDialog
              key={dialog.kind === 'edit' ? dialog.user.id : 'new'}
              user={dialog.kind === 'edit' ? dialog.user : null}
              open
              onOpenChange={close}
              onInvited={(user) => setDialog({ kind: 'link', user })}
            />
          )}
          {isSettingPassword && <PasswordDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />}
          {isShowingLink && <PasswordLinkDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />}
          {isShowingLinked && (
            <LinkedAccountsDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />
          )}
          {isSettingPicture && (
            <PictureDialog
              key={dialog.user.id}
              user={dialog.user}
              isEnabled={pictures.isEnabled}
              maxBytes={pictures.maxBytes}
              open
              onOpenChange={close}
            />
          )}
          {isShowingSessions && <SessionsDialog key={dialog.user.id} user={dialog.user} open onOpenChange={close} />}
        </>
      }
    />
  );
}
