import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { ApiFieldsFragment } from '@/__generated__/graphql';
import { ApiFormDialog, TOKEN_FORMATS } from '@/apis/api-form-dialog';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { DisclosureRow } from '@/components/disclosure-row';
import { List } from '@/components/list';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { useApis, useDeleteApi } from '@/core/apis';
import { Server } from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import { useProviderInfo } from '@/core/provider';
import { durationText } from '@/token-lifetimes/durations';

export const Route = createFileRoute('/apis')({ component: ApisPage });

/** Which dialog is up: none, a new API, or one API's edit. */
type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; api: ApiFieldsFragment };

/** Where, under the issuer, an API checks each token format: the published signing keys, or introspection. */
const CHECK_PATHS = { JWT: '/jwks', OPAQUE: '/token/introspection' } as const;

/**
 * What an API is set up with, and what it checks its tokens against.
 *
 * @param props - The API.
 */
function ApiDetails({ api }: { api: ApiFieldsFragment }) {
  const provider = useProviderInfo().data;
  const isJwt = api.tokenFormat === 'JWT';
  const checkUrl = provider === undefined ? null : `${provider.issuer}${CHECK_PATHS[api.tokenFormat]}`;
  const clientNames = api.allowedClients.map((client) => client.name);

  return (
    <DescriptionList
      contentSlot={[
        <PropertyRow
          key="identifier"
          label="Identifier"
          hint="Apps send it as resource; its tokens carry it as aud."
          value={api.identifier}
          valueClassName="font-mono break-all"
          actionSlot={<CopyButton value={api.identifier} label="Copy identifier" />}
        />,
        <PropertyRow
          key="scopes"
          label="Scopes"
          value={api.scopes.length === 0 ? 'None' : api.scopes.join(' ')}
          valueClassName={api.scopes.length === 0 ? undefined : 'font-mono'}
        />,
        <PropertyRow key="format" label="Token format" value={TOKEN_FORMATS[api.tokenFormat].description} />,
        <PropertyRow
          key="check"
          label={isJwt ? 'JWKS' : 'Introspection'}
          hint={isJwt ? 'Where the API reads the keys its tokens are signed with.' : 'Where the API checks a token.'}
          value={checkUrl ?? '—'}
          valueClassName="font-mono break-all"
          actionSlot={checkUrl === null ? undefined : <CopyButton value={checkUrl} label="Copy URL" />}
        />,
        <PropertyRow
          key="lifetime"
          label="Access token lifetime"
          value={
            api.accessTokenSeconds === null ? "The app's own, or the server's" : durationText(api.accessTokenSeconds)
          }
        />,
        <PropertyRow
          key="clients"
          label="Allowed clients"
          value={clientNames.length === 0 ? 'None yet: no app can ask for it' : clientNames.join(', ')}
        />,
      ]}
    />
  );
}

/**
 * The APIs apps ask for access tokens to, each opening onto its settings, with add, edit and delete.
 */
function ApisPage() {
  const query = useApis();
  const remove = useDeleteApi();
  const apis = query.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ kind: 'closed' });
  const isFormOpen = editing.kind !== 'closed';
  const close = (next: boolean): void => {
    if (next === false) {
      setEditing({ kind: 'closed' });
    }
  };
  const newButton = (size?: 'sm') => (
    <Button
      variant="info"
      size={size}
      iconSlot={<Plus />}
      content="New API"
      onClick={() => setEditing({ kind: 'new' })}
    />
  );

  return (
    <PageLayout
      title="APIs"
      description="Services of your own that take access tokens from this provider. An app asks for a token to one with the resource parameter, and the token's audience is that API."
      actionSlot={newButton('sm')}
      contentClassName="gap-4"
      contentSlot={
        <>
          {remove.error !== null && (
            <Alert variant="destructive" title="API not deleted" description={messageOf(remove.error)} />
          )}
          <QueryState
            query={query}
            what="the APIs"
            count={apis.length}
            emptySlot={
              <EmptyState
                iconSlot={<Server />}
                title="No APIs yet"
                description="Add one for each service that should check the tokens apps send it. Until then, apps get tokens for the userinfo endpoint."
                actionSlot={newButton()}
              />
            }
          />
          <List
            label="APIs"
            contentSlot={apis.map((api) => (
              <DisclosureRow
                key={api.identifier}
                open={openId === api.identifier}
                onOpenChange={(next) => setOpenId(next ? api.identifier : null)}
                title={api.name}
                badgesSlot={
                  <>
                    <Badge variant="outline">{TOKEN_FORMATS[api.tokenFormat].label}</Badge>
                    {api.allowedClients.length === 0 && <Badge variant="warning">No clients</Badge>}
                  </>
                }
                meta={<span className="font-mono text-foreground/60 text-xs">{api.identifier}</span>}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${api.name}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setEditing({ kind: 'edit', api })}
                    />
                    <ConfirmButton
                      aria-label={`Delete ${api.name}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Delete ${api.name}?`}
                      description="Apps can no longer get tokens for it. Tokens already given keep working until they expire."
                      onConfirm={() => remove.mutate(api.identifier)}
                    />
                  </>
                }
                contentSlot={<ApiDetails api={api} />}
              />
            ))}
          />
          {isFormOpen && (
            <ApiFormDialog
              key={editing.kind === 'edit' ? editing.api.identifier : 'new'}
              api={editing.kind === 'edit' ? editing.api : null}
              open={isFormOpen}
              onOpenChange={close}
              onSaved={(saved) => setOpenId(saved.identifier)}
            />
          )}
        </>
      }
    />
  );
}
