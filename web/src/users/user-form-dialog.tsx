import type { UserFieldsFragment } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useCreateUser, useUpdateUser } from '@/core/admin';
import { commaListOf, messageOf } from '@/core/lists';

/** The shortest password the form takes. The server takes any; this is a typo guard. */
const MIN_PASSWORD_LENGTH = 8;

interface UserFormDialogProps {
  /** The user to edit, or null to add one. */
  user: UserFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Checks a new password is long enough.
 *
 * @param value - The password typed.
 * @returns The problem, or undefined when there is none.
 */
export function passwordProblem(value: string): string | undefined {
  return value.length >= MIN_PASSWORD_LENGTH ? undefined : `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
}

/**
 * Adds a user or changes one's details. A new user is given a password here; an existing one's is
 * changed in its own dialog.
 *
 * @param props - The user and the dialog's open state.
 */
export function UserFormDialog({ user, open, onOpenChange }: UserFormDialogProps) {
  const isEdit = user !== null;
  const create = useCreateUser();
  const update = useUpdateUser();
  const failure = isEdit ? update.error : create.error;

  const form = useAppForm({
    defaultValues: {
      username: user?.username ?? '',
      password: '',
      name: user?.name ?? '',
      email: user?.email ?? '',
      groups: user?.groups.join(', ') ?? '',
    },
    onSubmit: async ({ value }) => {
      const input = {
        username: value.username.trim(),
        name: value.name.trim(),
        email: value.email.trim(),
        groups: commaListOf(value.groups),
      };
      if (isEdit) {
        await update.mutateAsync({ id: user.id, input });
      } else {
        await create.mutateAsync({ ...input, password: value.password });
      }
      onOpenChange(false);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${user.username}` : 'New user'}
      description="Someone who can sign in to the clients. Name, email and groups go into their tokens."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <InputField
            form={form}
            name="username"
            label="Username"
            required
            autoComplete="off"
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the user a username.') }}
          />
          {isEdit ? null : (
            <PasswordField
              form={form}
              name="password"
              label="Password"
              required
              autoComplete="new-password"
              validators={{ onChange: ({ value }) => passwordProblem(value) }}
            />
          )}
          <InputField form={form} name="name" label="Full name" autoComplete="off" />
          <InputField form={form} name="email" label="Email" type="email" autoComplete="off" />
          <InputField
            form={form}
            name="groups"
            label="Groups"
            description="Comma-separated. Released under the groups scope, for apps that map groups to roles."
            placeholder="admins, family"
          />
          {failure === null ? null : <Alert variant="destructive" title="Not saved" description={messageOf(failure)} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content={isEdit ? 'Save changes' : 'Create user'} />
          </form.AppForm>
        </>
      )}
    />
  );
}
