import type { UserFieldsFragment } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { DialogLayout } from '@/components/dialog-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { X } from '@/components/ui/icons';
import { LogOut } from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import { useEndUserSession, useSignOutUser, useUserSessions } from '@/core/users';
import { formatAgo, formatDateTime, joinStats } from '@/lib/format';

interface SessionsDialogProps {
  user: UserFieldsFragment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The browsers signed in as a user, each of which can be ended, and a way to end them all.
 *
 * @param props - The user and the dialog's open state.
 */
export function SessionsDialog({ user, open, onOpenChange }: SessionsDialogProps) {
  const query = useUserSessions(user.id);
  const end = useEndUserSession();
  const signOut = useSignOutUser();
  const sessions = query.data ?? [];
  const failure = end.error ?? signOut.error;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${user.username}'s sessions`}
      description="Each browser signed in as them. Ending one also ends the tokens it gave applications."
      size="lg"
      contentSlot={
        <div className="grid gap-4">
          <QueryState
            query={query}
            what="the sessions"
            count={sessions.length}
            emptySlot={<EmptyState compact title="Not signed in anywhere." />}
          />
          <List
            label="Sessions"
            contentSlot={sessions.map((session) => (
              <ListItem
                key={session.id}
                title={session.clientNames.length === 0 ? 'No applications yet' : session.clientNames.join(', ')}
                description={joinStats(
                  session.signedInAt && `Signed in ${formatAgo(session.signedInAt)}`,
                  session.expiresAt && `ends ${formatDateTime(session.expiresAt)}`,
                )}
                actionSlot={
                  <Button
                    aria-label="End this session"
                    hint="End session"
                    variant="outline"
                    size="icon-sm"
                    iconSlot={<X />}
                    disabled={end.isPending}
                    onClick={() => end.mutate({ id: user.id, sessionId: session.id })}
                  />
                }
              />
            ))}
          />
          {failure !== null && <Alert variant="destructive" title="Not signed out" description={messageOf(failure)} />}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <ConfirmButton
            variant="destructive-outline"
            iconSlot={<LogOut />}
            content="Sign out everywhere"
            title={`Sign ${user.username} out everywhere?`}
            description="Every browser and application signed in as them has to sign in again."
            confirmLabel="Sign out"
            disabled={sessions.length === 0}
            onConfirm={() => signOut.mutate(user.id)}
          />
          <Button variant="outline" onClick={close} content="Done" />
        </>
      )}
    />
  );
}
