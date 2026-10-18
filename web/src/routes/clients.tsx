import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { ClientFieldsFragment } from '@/__generated__/graphql';
import { AUTH_METHODS } from '@/clients/auth-methods';
import { ClientFormDialog } from '@/clients/client-form-dialog';
import { durationText } from '@/clients/durations';
import { PairDialog } from '@/clients/pair-dialog';
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
import { Pencil, Plug, Plus, RefreshCw, Trash2 } from '@/components/ui/icons';
import { useClients, useDeleteClient, useRotateClientSecret } from '@/core/admin';
import { AppWindow } from '@/core/app-icons';
import { messageOf } from '@/core/lists';

export const Route = createFileRoute('/clients')({ component: ClientsPage });

/** Which dialog is up: none, a new client, pairing an app, or one client's edit. */
type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'pair' } | { kind: 'edit'; client: ClientFieldsFragment };

/**
 * The URIs a client may be sent back to, one per line.
 *
 * @param uris - The URIs.
 * @returns The list, or a dash when there are none.
 */
function uriList(uris: readonly string[]) {
  return uris.length === 0 ? '—' : uris.join('\n');
}

/**
 * The lifetimes a client was given, by token.
 *
 * @param lifetimes - Its own lifetimes, null where it has the server's.
 * @returns Each token's lifetime, or "Server defaults" when it was given none.
 */
function lifetimesText(lifetimes: ClientFieldsFragment['tokenLifetimes']): string {
  const { accessTokenSeconds, idTokenSeconds, refreshTokenSeconds } = lifetimes;
  const named = [
    { label: 'access', seconds: accessTokenSeconds },
    { label: 'ID', seconds: idTokenSeconds },
    { label: 'refresh', seconds: refreshTokenSeconds },
  ].map(({ label, seconds }) => `${label} ${seconds === null ? 'default' : durationText(seconds)}`);
  const isAllDefault = [accessTokenSeconds, idTokenSeconds, refreshTokenSeconds].every((seconds) => seconds === null);
  return isAllDefault ? 'Server defaults' : named.join(', ');
}

/**
 * What an application is configured with: its ID, its secret, its URIs.
 *
 * @param props - The client.
 */
function ClientCredentials({ client }: { client: ClientFieldsFragment }) {
  const rotate = useRotateClientSecret();
  const secret = client.clientSecret;

  return (
    <div className="flex flex-col gap-4">
      {client.refusedRedirectUris.length === 0 ? null : (
        <Alert
          variant="warning"
          title="Redirect URIs no longer allowed"
          description={`The client still works, but cannot be saved until these use https: ${client.refusedRedirectUris.join(', ')}. Plain http can be allowed under Settings.`}
        />
      )}
      <DescriptionList
        contentSlot={[
          <PropertyRow
            key="id"
            label="Client ID"
            value={client.clientId}
            valueClassName="font-mono break-all"
            actionSlot={<CopyButton value={client.clientId} label="Copy client ID" />}
          />,
          <PropertyRow
            key="secret"
            label="Client secret"
            value={secret ?? 'None. A public client proves itself with PKCE.'}
            valueClassName={secret === null ? undefined : 'font-mono break-all'}
            actionSlot={
              secret === null ? undefined : (
                <>
                  <CopyButton value={secret} label="Copy client secret" />
                  <ConfirmButton
                    aria-label="Rotate client secret"
                    hint="Rotate secret"
                    variant="outline"
                    size="icon-sm"
                    iconSlot={<RefreshCw />}
                    title="Rotate this client's secret?"
                    description={`${client.name} stops being able to sign anyone in until it is given the new secret.`}
                    confirmLabel="Rotate"
                    onConfirm={() => rotate.mutate(client.clientId)}
                  />
                </>
              )
            }
          />,
          <PropertyRow key="method" label="Authentication" value={AUTH_METHODS[client.authMethod].label} />,
          <PropertyRow
            key="redirect"
            label="Redirect URIs"
            value={uriList(client.redirectUris)}
            valueClassName="font-mono break-all whitespace-pre-line"
          />,
          <PropertyRow
            key="logout"
            label="Post-logout URIs"
            value={uriList(client.postLogoutRedirectUris)}
            valueClassName="font-mono break-all whitespace-pre-line"
          />,
          <PropertyRow
            key="groups"
            label="Allowed groups"
            value={client.allowedGroups.length === 0 ? 'Every user' : client.allowedGroups.join(', ')}
          />,
          <PropertyRow key="claim" label="Groups claim" value={client.groupsClaim} valueClassName="font-mono" />,
          <PropertyRow
            key="credentials"
            label="Client credentials"
            value={client.allowClientCredentials ? 'Allowed' : 'Not allowed'}
          />,
          <PropertyRow key="lifetimes" label="Token lifetimes" value={lifetimesText(client.tokenLifetimes)} />,
        ]}
      />
      {rotate.error === null ? null : (
        <Alert variant="destructive" title="Secret not rotated" description={messageOf(rotate.error)} />
      )}
    </div>
  );
}

/**
 * The clients, each opening onto its credentials, with add, edit and delete.
 */
function ClientsPage() {
  const query = useClients();
  const remove = useDeleteClient();
  const clients = query.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ kind: 'closed' });
  const isFormOpen = editing.kind === 'new' || editing.kind === 'edit';
  const close = (next: boolean): void => {
    if (next === false) {
      setEditing({ kind: 'closed' });
    }
  };

  return (
    <PageLayout
      title="Clients"
      description="The applications that sign their users in here. Open one for the values to configure it with."
      actionSlot={
        <>
          <Button
            variant="outline"
            size="sm"
            iconSlot={<Plug />}
            content="Pair an app"
            onClick={() => setEditing({ kind: 'pair' })}
          />
          <Button
            variant="info"
            size="sm"
            iconSlot={<Plus />}
            content="New client"
            onClick={() => setEditing({ kind: 'new' })}
          />
        </>
      }
      contentClassName="gap-4"
      contentSlot={
        <>
          {remove.error === null ? null : (
            <Alert variant="destructive" title="Client not deleted" description={messageOf(remove.error)} />
          )}
          <QueryState
            query={query}
            what="the clients"
            count={clients.length}
            emptySlot={
              <EmptyState
                iconSlot={<AppWindow />}
                title="No clients yet"
                description="Add one for each application that should sign in through this provider, or pair an app that can register itself."
                actionSlot={
                  <>
                    <Button
                      variant="outline"
                      iconSlot={<Plug />}
                      content="Pair an app"
                      onClick={() => setEditing({ kind: 'pair' })}
                    />
                    <Button
                      variant="info"
                      iconSlot={<Plus />}
                      content="New client"
                      onClick={() => setEditing({ kind: 'new' })}
                    />
                  </>
                }
              />
            }
          />
          <List
            label="Clients"
            contentSlot={clients.map((client) => (
              <DisclosureRow
                key={client.clientId}
                open={openId === client.clientId}
                onOpenChange={(next) => setOpenId(next ? client.clientId : null)}
                title={client.name}
                badgesSlot={
                  <>
                    <Badge variant="outline">{client.authMethod === 'NONE' ? 'Public' : 'Confidential'}</Badge>
                    {client.allowedGroups.length === 0 ? null : <Badge variant="secondary">Limited</Badge>}
                    {client.source === 'PAIRED' ? <Badge variant="secondary">Paired</Badge> : null}
                    {client.refusedRedirectUris.length === 0 ? null : <Badge variant="warning">http redirect</Badge>}
                  </>
                }
                meta={<span className="font-mono text-foreground/60 text-xs">{client.clientId}</span>}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${client.name}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setEditing({ kind: 'edit', client })}
                    />
                    <ConfirmButton
                      aria-label={`Delete ${client.name}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Delete ${client.name}?`}
                      description="The application can no longer sign anyone in, and the tokens it holds stop working."
                      onConfirm={() => remove.mutate(client.clientId)}
                    />
                  </>
                }
                contentSlot={<ClientCredentials client={client} />}
              />
            ))}
          />
          {isFormOpen ? (
            <ClientFormDialog
              key={editing.kind === 'edit' ? editing.client.clientId : 'new'}
              client={editing.kind === 'edit' ? editing.client : null}
              open={isFormOpen}
              onOpenChange={close}
              onSaved={(saved) => setOpenId(saved.clientId)}
            />
          ) : null}
          {editing.kind === 'pair' ? (
            <PairDialog open onOpenChange={close} onPaired={(paired) => setOpenId(paired.clientId)} />
          ) : null}
        </>
      }
    />
  );
}
