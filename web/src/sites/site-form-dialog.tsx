import type { ProtectedSiteFieldsFragment } from '@/__generated__/graphql';
import { ComboboxField, InputField, SwitchField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useGroupOptions } from '@/core/admin';
import { messageOf } from '@/core/lists';
import { useCreateProtectedSite, useUpdateProtectedSite } from '@/core/protected-sites';

/** A host as the server takes it: a DNS name, no scheme, port or path. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

interface SiteFormDialogProps {
  /** The site to edit, or null to add one. */
  site: ProtectedSiteFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the saved site, so the page can open it. */
  onSaved: (site: ProtectedSiteFieldsFragment) => void;
}

/**
 * Adds a protected site or changes one.
 */
export function SiteFormDialog({ site, open, onOpenChange, onSaved }: SiteFormDialogProps) {
  const isEdit = site !== null;
  const groupOptions = useGroupOptions();
  const create = useCreateProtectedSite();
  const update = useUpdateProtectedSite();
  const failure = isEdit ? update.error : create.error;

  const form = useAppForm({
    defaultValues: {
      name: site?.name ?? '',
      host: site?.host ?? '',
      pathPrefix: site?.pathPrefix ?? '',
      allowedGroups: site?.allowedGroups ?? [],
      requireSecondFactor: site?.requireSecondFactor ?? false,
    },
    onSubmit: async ({ value }) => {
      const input = {
        name: value.name.trim(),
        host: value.host.trim(),
        pathPrefix: value.pathPrefix.trim(),
        allowedGroups: value.allowedGroups,
        requireSecondFactor: value.requireSecondFactor,
      };
      const saved = isEdit ? await update.mutateAsync({ id: site.id, input }) : await create.mutateAsync(input);
      onSaved(saved);
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${site.name}` : 'New protected site'}
      description="A site behind your reverse proxy that only signed-in users may reach."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            placeholder="Sonarr"
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the site a name.') }}
          />
          <InputField
            form={form}
            name="host"
            label="Host"
            required
            placeholder="sonarr.home.lan"
            description="The host the proxy is asked about, without https:// or a port."
            validators={{
              onChange: ({ value }) =>
                HOST_PATTERN.test(value.trim()) ? undefined : 'A host name such as sonarr.home.lan.',
            }}
          />
          <InputField
            form={form}
            name="pathPrefix"
            label="Path prefix"
            placeholder="/admin"
            description="Optional. Only paths under it, such as /admin and /admin/users. Leave blank for the whole host."
          />
          <ComboboxField
            form={form}
            name="allowedGroups"
            label="Allowed groups"
            description="Only users in one of these groups may reach it. Leave empty to let every user in."
            multiple
            freeText
            options={groupOptions}
            placeholder="Every user"
          />
          <SwitchField
            form={form}
            name="requireSecondFactor"
            label="Require a second factor"
            description="A user who signed in with a password alone is asked to sign in again with their authenticator app or passkey. One with no second factor is turned away."
          />
          {failure === null ? null : <Alert variant="destructive" title="Not saved" description={messageOf(failure)} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content={isEdit ? 'Save changes' : 'Add site'} />
          </form.AppForm>
        </>
      )}
    />
  );
}
