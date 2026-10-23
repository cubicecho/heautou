import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useRenameGroup } from '@/core/groups';
import { messageOf } from '@/core/lists';

interface RenameGroupDialogProps {
  /** The group's current name. */
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renames a group in every user and client. A name another group has merges the two.
 *
 * @param props - The group and the dialog's open state.
 */
export function RenameGroupDialog({ name, open, onOpenChange }: RenameGroupDialogProps) {
  const rename = useRenameGroup();
  const form = useAppForm({
    defaultValues: { newName: name },
    onSubmit: async ({ value }) => {
      await rename.mutateAsync({ name, newName: value.newName.trim() });
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Rename ${name}`}
      description="Every user and client with the group gets the new name. Applications see it in the next tokens they get."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <InputField
            form={form}
            name="newName"
            label="Name"
            required
            autoComplete="off"
            description="Naming it after a group that exists merges the two."
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the group a name.') }}
          />
          {rename.error === null ? null : (
            <Alert variant="destructive" title="Not renamed" description={messageOf(rename.error)} />
          )}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content="Rename" />
          </form.AppForm>
        </>
      )}
    />
  );
}
