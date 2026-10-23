import type { UserFieldsFragment } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { DialogLayout } from '@/components/dialog-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useUnlinkUserUpstream, useUsers } from '@/core/admin';
import { messageOf } from '@/core/lists';
import { formatAgo, joinStats } from '@/lib/format';

interface LinkedAccountsDialogProps {
  user: UserFieldsFragment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The accounts elsewhere a user signs in with, each of which an admin can unlink, as for an account they lost.
 *
 * @param props - The user and the dialog's open state.
 */
export function LinkedAccountsDialog({ user, open, onOpenChange }: LinkedAccountsDialogProps) {
  const unlink = useUnlinkUserUpstream();
  // The list is read again after an unlink, so the dialog follows it rather than the row it opened from.
  const current = useUsers().data?.find((each) => each.id === user.id) ?? user;
  const links = current.upstreamLinks;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${user.username}'s linked accounts`}
      description="Accounts at sign-in providers that sign in as this user."
      contentSlot={
        <div className="grid gap-4">
          {links.length === 0 ? <EmptyState compact title="Nothing is linked." /> : null}
          <List
            label="Linked accounts"
            contentSlot={links.map((link) => (
              <ListItem
                key={link.providerId}
                title={link.provider.name}
                description={joinStats(
                  link.label,
                  link.lastUsedAt === null ? 'not used yet' : `last used ${formatAgo(link.lastUsedAt)}`,
                )}
                actionSlot={
                  <ConfirmButton
                    variant="destructive-outline"
                    size="sm"
                    content="Unlink"
                    disabled={unlink.isPending}
                    title={`Unlink ${link.label}?`}
                    description={
                      current.hasPassword
                        ? `It no longer signs in as ${user.username}.`
                        : `It no longer signs in as ${user.username}, who has no password: send them a password link to get back in.`
                    }
                    confirmLabel="Unlink"
                    onConfirm={() => unlink.mutate({ id: user.id, providerId: link.providerId })}
                  />
                }
              />
            ))}
          />
          {unlink.error === null ? null : (
            <Alert variant="destructive" title="Not unlinked" description={messageOf(unlink.error)} />
          )}
        </div>
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Close" />}
    />
  );
}
