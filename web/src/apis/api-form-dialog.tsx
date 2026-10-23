import type { ApiFieldsFragment, ApiLifetimeBoundsQuery, TokenFormat } from '@/__generated__/graphql';
import { durationText, secondsIn } from '@/clients/durations';
import { ComboboxField, InputField, SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useApiLifetimeBounds, useCreateApi, useUpdateApi } from '@/core/apis';
import { useClients } from '@/core/clients';
import { messageOf } from '@/core/lists';

/** What each token format is called, and what it means for the API. */
export const TOKEN_FORMATS: Record<TokenFormat, { label: string; description: string }> = {
  JWT: {
    label: 'JWT',
    description: "A signed token the API checks itself with this provider's published keys (the JWKS).",
  },
  OPAQUE: {
    label: 'Opaque',
    description: 'A random string the API checks by calling the introspection endpoint.',
  },
};

const TOKEN_FORMAT_OPTIONS = (['JWT', 'OPAQUE'] as const).map((value) => ({
  value,
  label: TOKEN_FORMATS[value].label,
}));

/**
 * Narrows the select's string to a token format.
 *
 * @param value - What the select holds.
 * @returns The format, JWT for anything else.
 */
function tokenFormatOf(value: string): TokenFormat {
  return TOKEN_FORMAT_OPTIONS.find((option) => option.value === value)?.value ?? 'JWT';
}

/** The bounds on an API's own lifetime, in seconds. */
type LifetimeBounds = ApiLifetimeBoundsQuery['apiLifetimeBounds'];

/**
 * Checks a typed identifier the way the server will.
 *
 * @param value - What was typed.
 * @returns What is wrong with it, or undefined.
 */
function identifierProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (URL.canParse(trimmed) === false) {
    return 'Use an absolute URI, such as https://photos-api.home.lan.';
  }
  return trimmed.includes('#') ? 'Leave the fragment (#…) out.' : undefined;
}

/**
 * Checks a typed lifetime.
 *
 * @param text - What was typed.
 * @param bounds - The bounds, or undefined while they load (the server checks them again).
 * @returns What is wrong with it, or undefined.
 */
function lifetimeProblem(text: string, bounds: LifetimeBounds | undefined): string | undefined {
  const seconds = secondsIn(text);
  if (seconds === undefined) {
    return 'Write it as 5m, 1h or 1h 30m.';
  }
  const isOutOfBounds =
    seconds !== null && bounds !== undefined && (seconds < bounds.minSeconds || seconds > bounds.maxSeconds);
  return isOutOfBounds && bounds !== undefined
    ? `Between ${durationText(bounds.minSeconds)} and ${durationText(bounds.maxSeconds)}.`
    : undefined;
}

interface ApiFormDialogProps {
  /** The API to edit, or null to add one. */
  api: ApiFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the saved API, so the page can open it. */
  onSaved: (api: ApiFieldsFragment) => void;
}

/** Adds an API or changes one. */
export function ApiFormDialog({ api, open, onOpenChange, onSaved }: ApiFormDialogProps) {
  const isEdit = api !== null;
  const create = useCreateApi();
  const update = useUpdateApi();
  const failure = isEdit ? update.error : create.error;
  const bounds = useApiLifetimeBounds().data;
  const ownSeconds = api?.accessTokenSeconds ?? null;
  const clientOptions = (useClients().data ?? []).map((client) => ({ value: client.clientId, label: client.name }));

  const form = useAppForm({
    defaultValues: {
      identifier: '',
      name: api?.name ?? '',
      scopes: api?.scopes ?? [],
      tokenFormat: api?.tokenFormat ?? 'JWT',
      accessToken: ownSeconds === null ? '' : durationText(ownSeconds),
      allowedClientIds: api?.allowedClients.map((client) => client.clientId) ?? [],
    },
    onSubmit: async ({ value }) => {
      const input = {
        name: value.name.trim(),
        scopes: value.scopes,
        tokenFormat: tokenFormatOf(value.tokenFormat),
        accessTokenSeconds: secondsIn(value.accessToken) ?? null,
        allowedClientIds: value.allowedClientIds,
      };
      const saved = isEdit
        ? await update.mutateAsync({ identifier: api.identifier, input })
        : await create.mutateAsync({ ...input, identifier: value.identifier.trim() });
      onSaved(saved);
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${api.name}` : 'New API'}
      description="A service of your own that takes access tokens from this provider. Apps ask for a token to it with the resource parameter."
      size="lg"
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          {isEdit ? null : (
            <InputField
              form={form}
              name="identifier"
              label="Identifier"
              required
              description="What apps send as resource, and the audience (aud) of its tokens. It can't be changed later."
              placeholder="https://photos-api.home.lan"
              validators={{ onChange: ({ value }) => identifierProblem(value) }}
            />
          )}
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            placeholder="Photos API"
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the API a name.') }}
          />
          <ComboboxField
            form={form}
            name="scopes"
            label="Scopes"
            description="The scopes it understands, such as photos:read. A token carries only those of the ones the app asked for."
            multiple
            freeText
            options={[]}
            placeholder="No scopes"
          />
          <SelectField
            form={form}
            name="tokenFormat"
            label="Token format"
            options={TOKEN_FORMAT_OPTIONS}
            description={TOKEN_FORMATS[tokenFormatOf(form.state.values.tokenFormat)].description}
          />
          <InputField
            form={form}
            name="accessToken"
            label="Access token lifetime"
            description="As 5m or 1h. Leave blank for the app's own access token lifetime, or the server's."
            placeholder="The app's or the server's"
            validators={{ onChange: ({ value }) => lifetimeProblem(value, bounds) }}
          />
          <ComboboxField
            form={form}
            name="allowedClientIds"
            label="Allowed clients"
            description="Only these clients may ask for tokens to it. Any other gets invalid_target."
            multiple
            options={clientOptions}
            placeholder="No client yet"
          />
          {failure === null ? null : <Alert variant="destructive" title="Not saved" description={messageOf(failure)} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Create API'} />
          </form.AppForm>
        </>
      )}
    />
  );
}
