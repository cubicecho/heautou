import type { ClientFieldsFragment } from '@/__generated__/graphql';
import { ComboboxField, InputField, useAppForm } from '@/components/app-form';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { Spinner } from '@/components/ui/spinner';
import { useCancelPairing, useGroupOptions, usePairing, useStartPairing } from '@/core/admin';
import { messageOf } from '@/core/lists';
import { formatDateTime } from '@/lib/format';

/** The claim groups are released in unless the application reads another. */
const DEFAULT_GROUPS_CLAIM = 'groups';
/** A paired client lets every user in unless groups are chosen. */
const EVERY_USER: string[] = [];

interface PairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the client an app registered as, so the page can open it. */
  onPaired: (client: ClientFieldsFragment) => void;
}

interface SetupUrlProps {
  /** The pairing's id. */
  id: string;
  /** The URL the app is given. */
  setupUrl: string;
  /** Called with the client once an app has registered. */
  onPaired: (client: ClientFieldsFragment) => void;
  /** Starts over with a new URL. */
  onRestart: () => void;
}

/**
 * The setup URL, watched until an app registers with it, expires or is cancelled.
 *
 * @param props - The pairing and what to do when it ends.
 */
function SetupUrl({ id, setupUrl, onPaired, onRestart }: SetupUrlProps) {
  const query = usePairing(id);
  const pairing = query.data;
  const client = pairing?.client ?? null;

  if (query.isPending) {
    return <Spinner />;
  }
  if (query.error !== null) {
    return <Alert variant="destructive" title="Pairing not found" description={messageOf(query.error)} />;
  }
  if (pairing === null || pairing === undefined) {
    return (
      <div className="grid gap-4">
        <Alert variant="warning" title="The setup URL has stopped working" description="It expired or was cancelled." />
        <Button variant="info" content="Make another" onClick={onRestart} className="justify-self-start" />
      </div>
    );
  }
  if (client !== null) {
    return (
      <div className="grid gap-4">
        <Alert
          variant="info"
          title={`Paired with ${client.name}`}
          description="It can sign its users in now. Open it in the list for its settings."
        />
        <DescriptionList
          contentSlot={[
            <PropertyRow key="id" label="Client ID" value={client.clientId} valueClassName="font-mono break-all" />,
            <PropertyRow
              key="redirect"
              label="Redirect URIs"
              value={client.redirectUris.length === 0 ? '—' : client.redirectUris.join('\n')}
              valueClassName="font-mono break-all whitespace-pre-line"
            />,
          ]}
        />
        <Button
          variant="outline"
          content="Show client"
          onClick={() => onPaired(client)}
          className="justify-self-start"
        />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <DescriptionList
        contentSlot={[
          <PropertyRow
            key="url"
            label="Setup URL"
            value={setupUrl}
            valueClassName="font-mono break-all"
            actionSlot={<CopyButton value={setupUrl} label="Copy setup URL" />}
          />,
          <PropertyRow key="expires" label="Works until" value={formatDateTime(pairing.expiresAt)} />,
        ]}
      />
      <div className="flex items-center gap-2 text-foreground/70 text-sm">
        <Spinner />
        <span>Waiting for the app to register…</span>
      </div>
      <Alert
        variant="info"
        description="Paste it into the app's sign-in setup. It works once, and anyone with it can add a client, so keep it to yourself."
      />
    </div>
  );
}

/**
 * Pairs an app: the admin picks what its client gets, then pastes the setup URL into the app, which registers
 * itself (OAuth 2.0 Dynamic Client Registration). Closing the dialog before then cancels the URL.
 *
 * @param props - The dialog's open state, and what to do once an app has paired.
 */
export function PairDialog({ open, onOpenChange, onPaired }: PairDialogProps) {
  const groupOptions = useGroupOptions();
  const start = useStartPairing();
  const cancel = useCancelPairing();
  const started = start.data;

  const form = useAppForm({
    defaultValues: { allowedGroups: EVERY_USER, groupsClaim: DEFAULT_GROUPS_CLAIM },
    onSubmit: async ({ value }) => {
      await start.mutateAsync({
        allowedGroups: value.allowedGroups,
        groupsClaim: value.groupsClaim.trim() || DEFAULT_GROUPS_CLAIM,
      });
    },
  });

  const cancelStarted = (): void => {
    if (started !== undefined) {
      cancel.mutate(started.pairing.id);
    }
  };

  return (
    <DialogLayout
      open={open}
      onOpenChange={(next) => {
        if (next === false) {
          cancelStarted();
        }
        onOpenChange(next);
      }}
      title="Pair an app"
      description="Makes a setup URL the app registers itself with. Nothing to copy into its config."
      size="lg"
      contentSlot={
        started === undefined ? (
          <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
            <ComboboxField
              form={form}
              name="allowedGroups"
              label="Allowed groups"
              description="Only users in one of these groups may sign in to the app. Leave empty to let every user in."
              multiple
              freeText
              options={groupOptions}
              placeholder="Every user"
            />
            <InputField
              form={form}
              name="groupsClaim"
              label="Groups claim"
              description="The claim the user's groups are released in. Change it for an app that reads roles from another name."
              placeholder={DEFAULT_GROUPS_CLAIM}
            />
            {start.error === null ? null : (
              <Alert variant="destructive" title="No setup URL made" description={messageOf(start.error)} />
            )}
          </FormElement>
        ) : (
          <SetupUrl
            key={started.pairing.id}
            id={started.pairing.id}
            setupUrl={started.setupUrl}
            onPaired={(client) => {
              onPaired(client);
              onOpenChange(false);
            }}
            onRestart={() => start.reset()}
          />
        )
      }
      footerActionsSlot={(close) =>
        started === undefined ? (
          <>
            <Button variant="outline" onClick={close} content="Cancel" />
            <form.AppForm>
              <form.SubmitButton content="Make setup URL" />
            </form.AppForm>
          </>
        ) : (
          <Button variant="outline" onClick={close} content="Close" />
        )
      }
    />
  );
}
