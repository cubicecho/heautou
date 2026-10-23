import type { UserFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { messageOf } from '@/core/errors';
import { useSetUserPassword } from '@/core/users';
import { PasswordStrengthMeter } from '@/passwords/strength-meter';
import { passwordProblem } from '@/users/user-form-dialog';

interface PasswordDialogProps {
  user: UserFieldsFragment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Gives a user a new password.
 *
 * @param props - The user and the dialog's open state.
 */
export function PasswordDialog({ user, open, onOpenChange }: PasswordDialogProps) {
  const setPassword = useSetUserPassword();
  const form = useAppForm({
    defaultValues: { password: '' },
    onSubmit: async ({ value }) => {
      await setPassword.mutateAsync({ id: user.id, password: value.password });
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Set ${user.username}'s password`}
      description="The old password stops working. Sessions already signed in stay signed in."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <PasswordField
            form={form}
            name="password"
            label="New password"
            required
            autoComplete="new-password"
            validators={{ onChange: ({ value }) => passwordProblem(value) }}
          />
          <form.Subscribe selector={(state) => state.values.password}>
            {(password) => <PasswordStrengthMeter password={password} owner={[user.username, user.name, user.email]} />}
          </form.Subscribe>
          {setPassword.error === null ? null : (
            <Alert variant="destructive" title="Password not set" description={messageOf(setPassword.error)} />
          )}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content="Set password" />
          </form.AppForm>
        </>
      )}
    />
  );
}
