import type { ClientFieldsFragment } from '@/__generated__/graphql';
import { AUTH_METHOD_OPTIONS, AUTH_METHODS, authMethodOf } from '@/clients/auth-methods';
import { InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useCreateClient, useUpdateClient } from '@/core/admin';
import { linesOf, messageOf } from '@/core/lists';

const URI_ROWS = 3;

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
  const create = useCreateClient();
  const update = useUpdateClient();
  const failure = isEdit ? update.error : create.error;

  const form = useAppForm({
    defaultValues: {
      clientId: '',
      name: client?.name ?? '',
      authMethod: client?.authMethod ?? 'CLIENT_SECRET_BASIC',
      redirectUris: client?.redirectUris.join('\n') ?? '',
      postLogoutRedirectUris: client?.postLogoutRedirectUris.join('\n') ?? '',
    },
    onSubmit: async ({ value }) => {
      const input = {
        name: value.name.trim(),
        authMethod: authMethodOf(value.authMethod),
        redirectUris: linesOf(value.redirectUris),
        postLogoutRedirectUris: linesOf(value.postLogoutRedirectUris),
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
            required
            rows={URI_ROWS}
            description="One per line. The application's callback, matched exactly."
            placeholder="https://grafana.example.com/login/generic_oauth"
            validators={{
              onChange: ({ value }) => (linesOf(value).length > 0 ? undefined : 'Add at least one redirect URI.'),
            }}
          />
          <TextareaField
            form={form}
            name="postLogoutRedirectUris"
            label="Post-logout redirect URIs"
            rows={URI_ROWS}
            description="One per line. Where the application may send users after signing out. Optional."
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
