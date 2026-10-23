import type { UserFieldsFragment } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { DialogLayout } from '@/components/dialog-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageOf } from '@/core/errors';
import { useUnlinkUserUpstream } from '@/core/upstreams';
import { useUsers } from '@/core/users';
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
  const hasNoLinks = links.length === 0;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${user.username}'s linked accounts`}
      description="Accounts at sign-in providers that sign in as this user."
      contentSlot={
        <div className="grid gap-4">
          {hasNoLinks && <EmptyState compact title="Nothing is linked." />}
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
          {unlink.error !== null && (
            <Alert variant="destructive" title="Not unlinked" description={messageOf(unlink.error)} />
          )}
        </div>
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Close" />}
    />
  );
}
