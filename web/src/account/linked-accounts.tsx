import { useEffect, useRef } from 'react';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAccountUpstreams, useFinishLink, useStartLink, useUnlink } from '@/core/account';
import { Link2 } from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import { formatAgo, joinStats } from '@/lib/format';

/** Where a provider sends the browser back with the account to link: `/account?upstreamLink=`. */
const TICKET_PARAM = 'upstreamLink';

/**
 * Links the account a provider just sent the browser back with, once, and takes the ticket out of the address bar.
 *
 * @returns The mutation, to show how it went.
 */
function useLinkOnReturn() {
  const finish = useFinishLink();
  const isSent = useRef(false);
  const { mutate } = finish;
  useEffect(() => {
    const url = new URL(window.location.href);
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket === null || isSent.current) {
      return;
    }
    isSent.current = true;
    url.searchParams.delete(TICKET_PARAM);
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    mutate(ticket);
  }, [mutate]);
  return finish;
}

/**
 * The accounts elsewhere, such as Google or GitHub, the signed-in user can sign in with. Shown only when the operator
 * added a provider.
 */
export function LinkedAccountsSection() {
  const upstreams = useAccountUpstreams();
  const start = useStartLink();
  const unlink = useUnlink();
  const finished = useLinkOnReturn();
  const providers = upstreams.data?.providers ?? [];
  const linkedCount = providers.filter((provider) => provider.link !== null).length;
  const isLastWayIn = upstreams.data?.hasPassword === false && linkedCount <= 1;
  const failure = start.error ?? unlink.error ?? finished.error;

  if (upstreams.isSuccess && providers.length === 0 && finished.isIdle) {
    return null;
  }
  return (
    <Section
      title="Linked accounts"
      description="Accounts elsewhere you can sign in with instead of your password. Each one is linked to you alone."
      contentSlot={
        upstreams.isError ? (
          <QueryError error={upstreams.error} onRetry={upstreams.refetch} what="your linked accounts" />
        ) : upstreams.isPending ? (
          <Spinner />
        ) : (
          <div className="grid gap-2">
            {finished.isSuccess && (
              <Alert
                variant="info"
                description={`Linked ${finished.data.label} at ${finished.data.provider}. You can sign in with it now.`}
              />
            )}
            <List
              label="Linked accounts"
              contentSlot={providers.map((provider) => (
                <ListItem
                  key={provider.id}
                  title={provider.name}
                  description={
                    provider.link === null
                      ? 'Not linked'
                      : joinStats(
                          provider.link.label,
                          provider.link.lastUsedAt === null
                            ? 'not used yet'
                            : `last used ${formatAgo(provider.link.lastUsedAt)}`,
                        )
                  }
                  actionSlot={
                    provider.link === null ? (
                      <Button
                        variant="outline"
                        size="sm"
                        iconSlot={<Link2 />}
                        content="Link"
                        loading={start.isPending && start.variables === provider.id}
                        onClick={() => start.mutate(provider.id)}
                      />
                    ) : (
                      <ConfirmButton
                        variant="outline"
                        size="sm"
                        content="Unlink"
                        disabled={isLastWayIn || unlink.isPending}
                        hint={isLastWayIn ? 'You have no password, so this is your only way in.' : undefined}
                        title={`Unlink ${provider.name}?`}
                        description={`You can no longer sign in as ${provider.link.label} there. You can link it again later.`}
                        confirmLabel="Unlink"
                        onConfirm={() => unlink.mutate(provider.id)}
                      />
                    )
                  }
                />
              ))}
            />
            {failure !== null && <Alert variant="destructive" title="Not linked" description={messageOf(failure)} />}
          </div>
        )
      }
    />
  );
}
