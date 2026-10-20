import type { ClientFieldsFragment, TokenLifetimeDefaultsQuery } from '@/__generated__/graphql';
import { AUTH_METHOD_OPTIONS, AUTH_METHODS, authMethodOf } from '@/clients/auth-methods';
import { durationText, secondsIn } from '@/clients/durations';
import { BLANK_PRESET, PRESET_OPTIONS, PresetLinks, SitePresetGuide } from '@/clients/preset-panel';
import { baseUrlFrom, presetById, presetFields, sitePresetById } from '@/clients/presets';
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
      preset: BLANK_PRESET,
      baseUrl: '',
      clientId: '',
      name: client?.name ?? '',
      authMethod: client?.authMethod ?? 'CLIENT_SECRET_BASIC',
      redirectUris: client?.redirectUris.join('\n') ?? '',
      postLogoutRedirectUris: client?.postLogoutRedirectUris.join('\n') ?? '',
      allowedGroups: client?.allowedGroups ?? [],
      groupsClaim: client?.groupsClaim ?? DEFAULT_GROUPS_CLAIM,
      allowClientCredentials: client?.allowClientCredentials ?? false,
      allowDeviceFlow: client?.allowDeviceFlow ?? false,
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
        allowDeviceFlow: value.allowDeviceFlow,
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
        : await create.mutateAsync({
            ...input,
            clientId: value.clientId.trim() || null,
            preset: presetById(value.preset)?.id ?? null,
          });
      onSaved(saved);
      onOpenChange(false);
    },
  });

  /** Fills the fields from the chosen preset once the app's address is a URL. */
  const applyPreset = (): void => {
    const preset = presetById(form.getFieldValue('preset'));
    const baseUrl = baseUrlFrom(form.getFieldValue('baseUrl'));
    if (preset === undefined || baseUrl === null) {
      return;
    }
    const fields = presetFields(preset, baseUrl);
    form.setFieldValue('name', fields.name);
    form.setFieldValue('authMethod', fields.authMethod);
    form.setFieldValue('redirectUris', fields.redirectUris.join('\n'));
    form.setFieldValue('postLogoutRedirectUris', fields.postLogoutRedirectUris.join('\n'));
    form.setFieldValue('groupsClaim', fields.groupsClaim);
    form.setFieldValue('backchannelLogoutUri', fields.backchannelLogoutUri);
    if (form.getFieldValue('clientId').trim() === '') {
      form.setFieldValue('clientId', preset.id);
    }
    form.validateField('redirectUris', 'change');
  };

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
            <SelectField
              form={form}
              name="preset"
              label="Start from"
              description="Fills in the fields below for a common app. Change anything before saving."
              options={PRESET_OPTIONS}
              searchable
              searchPlaceholder="Find an app"
              listeners={{ onChange: applyPreset }}
            />
          )}
          <form.Subscribe selector={(state) => state.values.preset}>
            {(presetId) => {
              const site = isEdit ? undefined : sitePresetById(presetId);
              if (site !== undefined) {
                return <SitePresetGuide preset={site} />;
              }
              const preset = isEdit ? undefined : presetById(presetId);
              return preset === undefined ? null : (
                <>
                  <InputField
                    form={form}
                    name="baseUrl"
                    label={`${preset.name}'s address`}
                    required
                    description={<PresetLinks preset={preset} />}
                    placeholder={preset.baseUrlExample}
                    listeners={{ onChange: applyPreset }}
                    validators={{
                      // Still registered after another preset is chosen, so it checks only for the one shown.
                      onChange: ({ value, fieldApi }) =>
                        presetById(fieldApi.form.getFieldValue('preset')) !== undefined && baseUrlFrom(value) === null
                          ? `Give the address you open it at, such as ${preset.baseUrlExample}.`
                          : undefined,
                    }}
                  />
                </>
              );
            }}
          </form.Subscribe>
          <form.Subscribe selector={(state) => sitePresetById(state.values.preset) === undefined}>
            {(isClient) =>
              isClient ? (
                <>
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
                    description="One per line. The application's callback, matched exactly. Not needed for a client that only uses client credentials or the device flow."
                    placeholder="https://grafana.example.com/login/generic_oauth"
                    validators={{
                      onChange: ({ value, fieldApi }) =>
                        linesOf(value).length > 0 ||
                        fieldApi.form.getFieldValue('allowClientCredentials') ||
                        fieldApi.form.getFieldValue('allowDeviceFlow')
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
                  <SwitchField
                    form={form}
                    name="allowDeviceFlow"
                    label="Allow the device flow"
                    description="Lets a device with no browser of its own, such as Home Assistant or a TV, show a code that a user confirms at /device after signing in. It is given refresh tokens."
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
                </>
              ) : null
            }
          </form.Subscribe>
          {failure === null ? null : <Alert variant="destructive" title="Not saved" description={messageOf(failure)} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.Subscribe selector={(state) => sitePresetById(state.values.preset) !== undefined}>
              {(isSite) => <form.SubmitButton content={isEdit ? 'Save changes' : 'Create client'} disabled={isSite} />}
            </form.Subscribe>
          </form.AppForm>
        </>
      )}
    />
  );
}
