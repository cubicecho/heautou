import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { RefreshCw } from '@/components/ui/icons';
import { messageOf } from '@/core/errors';
import { useKeys, useRotateKeys } from '@/core/keys';
import { formatAgo, formatDateTime } from '@/lib/format';

/**
 * The keys tokens are signed with, and rotating them.
 */
export function KeysSection() {
  const keys = useKeys();
  const rotate = useRotateKeys();
  const rotatedAt = keys.data?.rotatedAt ?? null;

  return (
    <Section
      title="Signing keys"
      description="Tokens are signed with the current key. The previous one stays published so tokens it signed still verify."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {keys.isError ? <QueryError error={keys.error} onRetry={keys.refetch} what="the keys" /> : null}
          <SettingRow
            title="Rotate keys"
            description={
              rotatedAt === null
                ? 'They are rotated at boot every 90 days.'
                : `Last made ${formatAgo(rotatedAt)} (${formatDateTime(rotatedAt)}). They are rotated at boot every 90 days.`
            }
            actionSlot={
              <ConfirmButton
                variant="outline"
                size="sm"
                iconSlot={<RefreshCw />}
                content="Rotate now"
                disabled={rotate.isPending}
                title="Rotate the signing keys?"
                description="New tokens are signed with a new key. Tokens signed with keys older than the previous one stop verifying, so those users sign in again."
                confirmLabel="Rotate"
                onConfirm={() => rotate.mutate()}
              />
            }
          />
          <DescriptionList
            contentSlot={(keys.data?.signingKeys ?? []).map((key) => (
              <PropertyRow
                key={key.kid}
                label={key.isCurrent ? 'Current' : 'Previous'}
                value={key.kid}
                valueClassName="font-mono break-all"
                actionSlot={key.isCurrent ? <Badge variant="positive">Signing</Badge> : undefined}
              />
            ))}
          />
          {rotate.error === null ? null : (
            <Alert variant="destructive" title="Keys not rotated" description={messageOf(rotate.error)} />
          )}
        </div>
      }
    />
  );
}
