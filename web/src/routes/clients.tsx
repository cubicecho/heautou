import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ClientAuthMethod, type ClientFieldsFragment, ClientSource } from '@/__generated__/graphql';
import { AUTH_METHODS } from '@/clients/auth-methods';
import { ClientFormDialog } from '@/clients/client-form-dialog';
import { PairDialog } from '@/clients/pair-dialog';
import { PresetPanel } from '@/clients/preset-panel';
import { presetById } from '@/clients/presets';
import { maskSecret, SecretToggle } from '@/clients/secret';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { DisclosureRow } from '@/components/disclosure-row';
import { List } from '@/components/list';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryState } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Pencil, Plug, Plus, RefreshCw, Trash2 } from '@/components/ui/icons';
import { AppWindow } from '@/core/app-icons';
import { useClients, useDeleteClient, useRotateClientSecret } from '@/core/clients';
import { messageOf } from '@/core/errors';
import { useProviderInfo } from '@/core/provider';
import type { SlotNode } from '@/lib/utils';
import { durationText } from '@/token-lifetimes/durations';

export const Route = createFileRoute('/clients')({ component: ClientsPage });

/** Which dialog is up: none, a new client, pairing an app, or one client's edit. */
type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'pair' } | { kind: 'edit'; client: ClientFieldsFragment };

/** The clients one paired app registered (its sign-in client, its device client), shown together. */
interface AppGroup {
  /** The app's id, which its clients share. */
  id: string;
  /** What to call it: its sign-in client's name, or its first client's. */
  name: string;
  /** The app's address, or null when it gave none. */
  uri: string | null;
  /** Its clients, in the order the list has them. */
  clients: ClientFieldsFragment[];
}

/**
 * Splits the clients into the paired apps they belong to and the rest, keeping their order.
 *
 * @param clients - Every client.
 * @returns The apps, in the order their first client comes, and the clients that belong to none.
 */
function groupByApp(clients: readonly ClientFieldsFragment[]): {
  apps: AppGroup[];
  others: ClientFieldsFragment[];
} {
  const apps = new Map<string, AppGroup>();
  const others: ClientFieldsFragment[] = [];
  for (const client of clients) {
    const app = client.app ?? null;
    if (app === null) {
      others.push(client);
      continue;
    }
    const group = apps.get(app.id) ?? { id: app.id, name: client.name, uri: app.uri ?? null, clients: [] };
    group.clients.push(client);
    apps.set(app.id, group);
  }
  for (const group of apps.values()) {
    const signIn = group.clients.find((client) => client.redirectUris.length > 0);
    group.name = signIn?.name ?? group.name;
  }
  return { apps: [...apps.values()], others };
}

/**
 * What a paired app's heading says under its name: where it is, and the APIs its clients may get tokens to.
 *
 * @param app - The app.
 * @returns The line.
 */
function appDescription(app: AppGroup): string {
  const apis = [...new Map(app.clients.flatMap((client) => client.apis).map((api) => [api.identifier, api])).values()];
  const where = app.uri ?? 'Paired app';
  return apis.length === 0
    ? `${where}. Its clients may get tokens to no API.`
    : `${where}. Its clients may get tokens to ${apis.map((api) => api.name).join(', ')} only.`;
}

/** The claim groups are released in unless a client names another. */
const DEFAULT_GROUPS_CLAIM = 'groups';

/** The scope an app adds only when it wants refresh tokens, left out of the scopes the setup suggests. */
const REFRESH_SCOPE = 'offline_access';

/**
 * The lifetimes a client was given, by token.
 *
 * @param client - The client, whose own lifetimes are null where it has the server's.
 * @returns Each token's lifetime, or null when it has the server's for all three.
 */
function lifetimesText(client: ClientFieldsFragment): string | null {
  const { accessTokenSeconds, idTokenSeconds, refreshTokenSeconds } = client;
  const isAllDefault = [accessTokenSeconds, idTokenSeconds, refreshTokenSeconds].every((seconds) => seconds === null);
  if (isAllDefault) {
    return null;
  }
  return [
    { label: 'access', seconds: accessTokenSeconds },
    { label: 'ID', seconds: idTokenSeconds },
    { label: 'refresh', seconds: refreshTokenSeconds },
  ]
    .map(({ label, seconds }) => `${label} ${seconds === null ? 'default' : durationText(seconds)}`)
    .join(', ');
}

/**
 * The URIs a client may be sent back to, as one row's value.
 *
 * @param props - The URIs.
 * @param props.uris - One or more URIs.
 */
function UriListValue({ uris }: { uris: readonly string[] }) {
  return <span className="whitespace-pre-line break-all font-mono">{uris.join('\n')}</span>;
}

/**
 * The client's ID and secret, as the rows of whichever panel shows them first, with copy and rotate.
 *
 * @param client - The client.
 * @param isSecretShown - Whether the secret is shown rather than masked.
 * @param onSecretShownChange - Shows or hides it.
 * @returns The two rows, and why the last rotation failed.
 */
function useCredentialRows(
  client: ClientFieldsFragment,
  isSecretShown: boolean,
  onSecretShownChange: (isShown: boolean) => void,
) {
  const rotate = useRotateClientSecret();
  const secret = client.clientSecret ?? null;
  const rows = [
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
      value={
        secret === null ? 'None. A public client proves itself with PKCE.' : maskSecret(secret, secret, isSecretShown)
      }
      valueClassName={secret === null ? undefined : 'font-mono break-all'}
      actionSlot={
        secret === null ? undefined : (
          <>
            <SecretToggle isShown={isSecretShown} onShownChange={onSecretShownChange} />
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
  ];
  return { rows, rotateError: rotate.error };
}

/**
 * What a client with no preset needs in its app: where the provider is, the credentials, and what to ask for.
 *
 * @param props - The client, and its ID and secret rows.
 */
function GenericSetup({ client, credentialRows }: { client: ClientFieldsFragment; credentialRows: SlotNode[] }) {
  const provider = useProviderInfo().data;
  const scopes = (provider?.scopes ?? []).filter((scope) => scope !== REFRESH_SCOPE).join(' ');
  const providerRows =
    provider === undefined
      ? []
      : [
          <PropertyRow
            key="discovery"
            label="Discovery URL"
            value={provider.discoveryUrl}
            valueClassName="font-mono break-all"
            hint="Also called the OpenID configuration or well-known URL."
            actionSlot={<CopyButton value={provider.discoveryUrl} label="Copy discovery URL" />}
          />,
          <PropertyRow
            key="issuer"
            label="Issuer"
            value={provider.issuer}
            valueClassName="font-mono break-all"
            hint="For an app that asks for the issuer or provider URL instead."
            actionSlot={<CopyButton value={provider.issuer} label="Copy issuer" />}
          />,
        ];
  const scopeRows =
    scopes === ''
      ? []
      : [
          <PropertyRow
            key="scopes"
            label="Scopes"
            value={scopes}
            valueClassName="font-mono"
            hint={`Add ${REFRESH_SCOPE} for refresh tokens.`}
            actionSlot={<CopyButton value={scopes} label="Copy scopes" />}
          />,
        ];
  const claimRows =
    client.groupsClaim === DEFAULT_GROUPS_CLAIM
      ? []
      : [
          <PropertyRow
            key="claim"
            label="Groups claim"
            value={client.groupsClaim}
            valueClassName="font-mono"
            hint="The user's groups arrive in this claim, for the app's role or policy mapping."
          />,
        ];

  return (
    <Section
      title="Configure the app"
      description="Set these on the app's OpenID Connect page. Most apps need only the discovery URL, the client ID and the secret."
      contentSlot={
        <DescriptionList
          contentSlot={[
            ...providerRows,
            ...credentialRows,
            <PropertyRow
              key="redirect"
              label={client.redirectUris.length > 1 ? 'Redirect URIs' : 'Redirect URI'}
              value={
                client.redirectUris.length === 0 ? (
                  'None. It signs no one in through a browser.'
                ) : (
                  <UriListValue uris={client.redirectUris} />
                )
              }
              hint="The app's callback, matched exactly."
            />,
            ...scopeRows,
            ...claimRows,
          ]}
        />
      }
    />
  );
}

/**
 * The facts about a client beyond its setup, leaving out the ones still at a new client's default.
 *
 * @param client - The client.
 * @returns The rows.
 */
function detailRows(client: ClientFieldsFragment) {
  const lifetimes = lifetimesText(client);
  const backchannelUri = client.backchannelLogoutUri ?? null;
  const rows = [
    <PropertyRow key="method" label="Authentication" value={AUTH_METHODS[client.authMethod].label} />,
    <PropertyRow
      key="groups"
      label="Allowed groups"
      value={client.allowedGroups.length === 0 ? 'Every user' : client.allowedGroups.join(', ')}
    />,
    client.postLogoutRedirectUris.length === 0 ? null : (
      <PropertyRow
        key="logout"
        label="Post-logout URIs"
        value={<UriListValue uris={client.postLogoutRedirectUris} />}
      />
    ),
    backchannelUri === null ? null : (
      <PropertyRow
        key="backchannel"
        label="Back-channel logout"
        value={backchannelUri}
        valueClassName="font-mono break-all"
        hint={client.backchannelLogoutSessionRequired ? undefined : 'Without the session ID.'}
      />
    ),
    client.allowClientCredentials ? <PropertyRow key="credentials" label="Client credentials" value="Allowed" /> : null,
    client.allowDeviceFlow ? <PropertyRow key="device" label="Device flow" value="Allowed" /> : null,
    client.apis.length === 0 ? null : (
      <PropertyRow
        key="apis"
        label="APIs"
        value={client.apis.map((api) => `${api.name} (${api.identifier})`).join('\n')}
        valueClassName="break-all whitespace-pre-line"
      />
    ),
    lifetimes === null ? null : <PropertyRow key="lifetimes" label="Token lifetimes" value={lifetimes} />,
  ];
  return rows.filter((row) => row !== null);
}

/**
 * What an application is configured with: how to set it up first, then the client's details.
 *
 * @param props - The client.
 */
function ClientDetail({ client }: { client: ClientFieldsFragment }) {
  const preset = presetById(client.preset);
  // One switch for the secret wherever the panel shows it: its row and the settings that hold it.
  const [isSecretShown, setSecretShown] = useState(false);
  const { rows: credentialRows, rotateError } = useCredentialRows(client, isSecretShown, setSecretShown);
  const hasPreset = preset !== undefined;
  const hasRefusedUris = client.refusedRedirectUris.length > 0;
  // A preset's panel holds the ID and secret inside its own settings, so the rows that copy and rotate them sit here.
  const presetCredentialRows = hasPreset
    ? [
        ...credentialRows,
        <PropertyRow key="redirect" label="Redirect URIs" value={<UriListValue uris={client.redirectUris} />} />,
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      {hasRefusedUris && (
        <Alert
          variant="warning"
          title="Redirect URIs no longer allowed"
          description={`The client still works, but cannot be saved until these use https: ${client.refusedRedirectUris.join(', ')}. Plain http can be allowed under Settings.`}
        />
      )}
      {rotateError !== null && (
        <Alert variant="destructive" title="Secret not rotated" description={messageOf(rotateError)} />
      )}
      {hasPreset ? (
        <PresetPanel
          client={client}
          preset={preset}
          isSecretShown={isSecretShown}
          onSecretShownChange={setSecretShown}
        />
      ) : (
        <GenericSetup client={client} credentialRows={credentialRows} />
      )}
      <Section
        title="Details"
        contentSlot={<DescriptionList contentSlot={[...presetCredentialRows, ...detailRows(client)]} />}
      />
    </div>
  );
}

/**
 * The badges after a client's name: what is out of the ordinary about it.
 *
 * @param client - The client.
 * @returns The badges.
 */
function clientBadges(client: ClientFieldsFragment) {
  const presetName = presetById(client.preset)?.name;
  // A preset badge that only repeats the name says nothing.
  const showsPreset = presetName !== undefined && presetName.toLowerCase() !== client.name.toLowerCase();
  const isPublic = client.authMethod === ClientAuthMethod.None;
  const isLimited = client.allowedGroups.length > 0;
  const isPaired = client.source === ClientSource.Paired;
  const hasOwnGroupsClaim = client.groupsClaim !== DEFAULT_GROUPS_CLAIM;
  const hasRefusedUris = client.refusedRedirectUris.length > 0;
  return (
    <>
      {isPublic && <Badge variant="outline">Public</Badge>}
      {isLimited && <Badge variant="secondary">Limited</Badge>}
      {isPaired && <Badge variant="secondary">Paired</Badge>}
      {showsPreset && <Badge variant="secondary">{presetName}</Badge>}
      {hasOwnGroupsClaim && <Badge variant="outline">groups as {client.groupsClaim}</Badge>}
      {hasRefusedUris && <Badge variant="warning">http redirect</Badge>}
    </>
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
  const isPairing = editing.kind === 'pair';
  const { apps, others } = groupByApp(clients);
  const hasNoApps = apps.length === 0;
  // Beside the apps, the rest get a section of their own; with no apps they are the whole list.
  const showsOtherClients = hasNoApps === false && others.length > 0;
  /**
   * One client's row, opening onto its credentials.
   *
   * @param client - The client.
   * @returns The row.
   */
  const clientRow = (client: ClientFieldsFragment) => (
    <DisclosureRow
      key={client.clientId}
      open={openId === client.clientId}
      onOpenChange={(next) => setOpenId(next ? client.clientId : null)}
      title={client.name}
      meta={clientBadges(client)}
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
      contentSlot={<ClientDetail client={client} />}
    />
  );
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
          {remove.error !== null && (
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
          {apps.map((app) => (
            <Section
              key={app.id}
              title={app.name}
              description={appDescription(app)}
              contentSlot={<List label={`${app.name} clients`} contentSlot={app.clients.map(clientRow)} />}
            />
          ))}
          {hasNoApps && <List label="Clients" contentSlot={others.map(clientRow)} />}
          {showsOtherClients && (
            <Section
              title="Other clients"
              contentSlot={<List label="Other clients" contentSlot={others.map(clientRow)} />}
            />
          )}
          {isFormOpen && (
            <ClientFormDialog
              key={editing.kind === 'edit' ? editing.client.clientId : 'new'}
              client={editing.kind === 'edit' ? editing.client : null}
              open={isFormOpen}
              onOpenChange={close}
              onSaved={(saved) => setOpenId(saved.clientId)}
            />
          )}
          {isPairing && <PairDialog open onOpenChange={close} onPaired={(paired) => setOpenId(paired.clientId)} />}
        </>
      }
    />
  );
}
