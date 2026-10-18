import type { ClientFieldsFragment, TokenLifetimeDefaultsQuery } from '@/__generated__/graphql';
import { AUTH_METHOD_OPTIONS, AUTH_METHODS, authMethodOf } from '@/clients/auth-methods';
import { durationText, secondsIn } from '@/clients/durations';
import { ComboboxField, InputField, SelectField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useCreateClient, useGroupOptions, useTokenLifetimeDefaults, useUpdateClient } from '@/core/admin';
import { linesOf, messageOf } from '@/core/lists';

const URI_ROWS = 3;
/** The claim groups are released in unless the application reads another. */
const DEFAULT_GROUPS_CLAIM = 'groups';

/** The server's lifetimes and the bounds on a client's own, in seconds. */
type LifetimeDefaults = TokenLifetimeDefaultsQuery['tokenLifetimeDefaults'];

/**
 * Writes a client's lifetime into its field.
 *
 * @param seconds - The client's own lifetime, or null for the server's.
 * @returns The field's text: blank for the server's.
 */
function lifetimeText(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? '' : durationText(seconds);
}

/**
 * Checks a typed lifetime.
 *
 * @param text - What was typed.
 * @param defaults - The bounds, or undefined while they load (the server checks them again).
 * @returns What is wrong with it, or undefined.
 */
function lifetimeProblem(text: string, defaults: LifetimeDefaults | undefined): string | undefined {
  const seconds = secondsIn(text);
  if (seconds === undefined) {
    return 'Write it as 15m, 1h, 1h 30m or 30d.';
  }
  const isOutOfBounds =
    seconds !== null && defaults !== undefined && (seconds < defaults.minSeconds || seconds > defaults.maxSeconds);
  return isOutOfBounds && defaults !== undefined
    ? `Between ${durationText(defaults.minSeconds)} and ${durationText(defaults.maxSeconds)}.`
    : undefined;
}

/**
 * Says what a blank lifetime field gives.
 *
 * @param seconds - The server's lifetime, or undefined while it loads.
 * @returns The placeholder.
 */
function defaultPlaceholder(seconds: number | undefined): string {
  return seconds === undefined ? 'Default' : `Default: ${durationText(seconds)}`;
}

interface ClientFormDialogProps {
  /** The client to edit, or null to add one. */
  client: ClientFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the saved client, so the page can show its credentials. */
  onSaved: (client: ClientFieldsFragment) => void;
}

/**
 * Adds a client or changes one.
 *
 * @param props - The client and the dialog's open state.
 */
export function ClientFormDialog({ client, open, onOpenChange, onSaved }: ClientFormDialogProps) {
  const isEdit = client !== null;
  const groupOptions = useGroupOptions();
  const create = useCreateClient();
  const update = useUpdateClient();
  const failure = isEdit ? update.error : create.error;
  const lifetimes = useTokenLifetimeDefaults().data;
  const ownLifetimes = client?.tokenLifetimes;

  const form = useAppForm({
    defaultValues: {
      clientId: '',
      name: client?.name ?? '',
      authMethod: client?.authMethod ?? 'CLIENT_SECRET_BASIC',
      redirectUris: client?.redirectUris.join('\n') ?? '',
      postLogoutRedirectUris: client?.postLogoutRedirectUris.join('\n') ?? '',
      allowedGroups: client?.allowedGroups ?? [],
      groupsClaim: client?.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      allowClientCredentials: client?.allowClientCredentials ?? false,
      accessToken: lifetimeText(ownLifetimes?.accessTokenSeconds),
      idToken: lifetimeText(ownLifetimes?.idTokenSeconds),
      refreshToken: lifetimeText(ownLifetimes?.refreshTokenSeconds),
      backchannelLogoutUri: client?.backchannelLogoutUri ?? '',
      backchannelLogoutSessionRequired: client?.backchannelLogoutSessionRequired ?? true,
    },
    onSubmit: async ({ value }) => {
      const input = {
        name: value.name.trim(),
        authMethod: authMethodOf(value.authMethod),
        redirectUris: linesOf(value.redirectUris),
        postLogoutRedirectUris: linesOf(value.postLogoutRedirectUris),
        allowedGroups: value.allowedGroups,
        groupsClaim: value.groupsClaim.trim() || DEFAULT_GROUPS_CLAIM,
        allowClientCredentials: value.allowClientCredentials,
        tokenLifetimes: {
          accessTokenSeconds: secondsIn(value.accessToken) ?? null,
          idTokenSeconds: secondsIn(value.idToken) ?? null,
          refreshTokenSeconds: secondsIn(value.refreshToken) ?? null,
        },
        // Blank removes it: null would keep what is saved.
        backchannelLogoutUri: value.backchannelLogoutUri.trim(),
        backchannelLogoutSessionRequired: value.backchannelLogoutSessionRequired,
      };
      const saved = isEdit
        ? await update.mutateAsync({ clientId: client.clientId, input })
        : await create.mutateAsync({ ...input, clientId: value.clientId.trim() || null });
      onSaved(saved);
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${client.name}` : 'New client'}
      description="An application that signs its users in through this provider."
      size="lg"
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          {isEdit ? null : (
            <InputField
              form={form}
              name="clientId"
              label="Client ID"
              description="Leave blank for a random one. Letters, digits, dots, dashes and underscores."
              placeholder="grafana"
            />
          )}
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            placeholder="Grafana"
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the client a name.') }}
          />
          <SelectField
            form={form}
            name="authMethod"
            label="Client authentication"
            options={AUTH_METHOD_OPTIONS}
            description={AUTH_METHODS[authMethodOf(form.state.values.authMethod)].description}
          />
          <TextareaField
            form={form}
            name="redirectUris"
            label="Redirect URIs"
            rows={URI_ROWS}
            description="One per line. The application's callback, matched exactly. Not needed for a client that only uses client credentials."
            placeholder="https://grafana.example.com/login/generic_oauth"
            validators={{
              onChange: ({ value, fieldApi }) =>
                linesOf(value).length > 0 || fieldApi.form.getFieldValue('allowClientCredentials')
                  ? undefined
                  : 'Add at least one redirect URI.',
            }}
          />
          <TextareaField
            form={form}
            name="postLogoutRedirectUris"
            label="Post-logout redirect URIs"
            rows={URI_ROWS}
            description="One per line. Where the application may send users after signing out. Optional."
          />
          <InputField
            form={form}
            name="backchannelLogoutUri"
            label="Back-channel logout URI"
            description="Optional. This provider posts a logout token here when a user signs out or an admin ends their sessions, so the application ends its own session too."
            placeholder="https://app.example.com/oidc/backchannel-logout"
          />
          <SwitchField
            form={form}
            name="backchannelLogoutSessionRequired"
            label="Send the session ID"
            description="Puts the session ID (sid) in the logout token and the ID tokens, for an application that ends sessions by it."
          />
          <ComboboxField
            form={form}
            name="allowedGroups"
            label="Allowed groups"
            description="Only users in one of these groups may sign in to it. Leave empty to let every user in."
            multiple
            freeText
            options={groupOptions}
            placeholder="Every user"
          />
          <InputField
            form={form}
            name="groupsClaim"
            label="Groups claim"
            description="The claim the user's groups are released in. Change it for an application that reads roles from another name."
            placeholder={DEFAULT_GROUPS_CLAIM}
          />
          <SwitchField
            form={form}
            name="allowClientCredentials"
            label="Allow client credentials"
            description="Lets the application get tokens for itself, with no user, for a backup job or a service calling an API."
            // Whether redirect URIs are needed turns on this switch, so they are checked again when it moves.
            listeners={{ onChange: ({ fieldApi }) => fieldApi.form.validateField('redirectUris', 'change') }}
          />
          <Section
            title="Token lifetimes"
            description="How long the tokens this application is given stay valid, as 15m, 1h or 30d. Leave a field blank for the server's default."
            contentSlot={
              <FieldRow
                perRow={3}
                contentSlot={
                  <>
                    <InputField
                      form={form}
                      name="accessToken"
                      label="Access token"
                      placeholder={defaultPlaceholder(lifetimes?.accessTokenSeconds)}
                      description={
                        lifetimes === undefined
                          ? undefined
                          : `With client credentials the default is ${durationText(lifetimes.clientCredentialsSeconds)}.`
                      }
                      validators={{ onChange: ({ value }) => lifetimeProblem(value, lifetimes) }}
                    />
                    <InputField
                      form={form}
                      name="idToken"
                      label="ID token"
                      placeholder={defaultPlaceholder(lifetimes?.idTokenSeconds)}
                      validators={{ onChange: ({ value }) => lifetimeProblem(value, lifetimes) }}
                    />
                    <InputField
                      form={form}
                      name="refreshToken"
                      label="Refresh token"
                      placeholder={defaultPlaceholder(lifetimes?.refreshTokenSeconds)}
                      validators={{ onChange: ({ value }) => lifetimeProblem(value, lifetimes) }}
                    />
                  </>
                }
              />
            }
          />
          {failure === null ? null : <Alert variant="destructive" title="Not saved" description={messageOf(failure)} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content={isEdit ? 'Save changes' : 'Create client'} />
          </form.AppForm>
        </>
      )}
    />
  );
}
