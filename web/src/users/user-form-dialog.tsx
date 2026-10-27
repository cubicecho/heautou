import type { UserFieldsFragment } from '@/__generated__/graphql';
import { ComboboxField, InputField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { PasswordField } from '@/components/password-field';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { claimsOf, claimsProblem, claimsText } from '@/core/claims';
import { useGroupOptions } from '@/core/groups';
import { SaveFailure } from '@/core/save-failure';
import { useCreateUser, useUpdateUser } from '@/core/users';
import { PasswordStrengthMeter } from '@/passwords/strength-meter';

/** The shortest password the form takes. The server takes any; this is a typo guard. */
const MIN_PASSWORD_LENGTH = 8;
const CLAIM_ROWS = 3;

interface UserFormDialogProps {
  /** The user to edit, or null to add one. */
  user: UserFieldsFragment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a user added without a password, so the page can hand out their invite link. */
  onInvited: (user: UserFieldsFragment) => void;
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
 * Adds a user or changes one's details. A new user is given a password here, or none, to be invited with a link;
 * an existing one's is changed in its own dialog.
 *
 * @param props - The user and the dialog's open state.
 */
export function UserFormDialog({ user, open, onOpenChange, onInvited }: UserFormDialogProps) {
  const isEdit = user !== null;
  const isNew = isEdit === false;
  const groupOptions = useGroupOptions();
  const create = useCreateUser();
  const update = useUpdateUser();
  const failure = isEdit ? update.error : create.error;

  const form = useAppForm({
    defaultValues: {
      username: user?.username ?? '',
      password: '',
      name: user?.name ?? '',
      email: user?.email ?? '',
      groups: user?.groups ?? [],
      claims: claimsText(user?.claims ?? {}),
    },
    onSubmit: async ({ value }) => {
      const input = {
        username: value.username.trim(),
        name: value.name.trim(),
        email: value.email.trim(),
        groups: value.groups,
        claims: claimsOf(value.claims),
      };
      if (isEdit) {
        await update.mutateAsync({ id: user.id, input });
        onOpenChange(false);
        return;
      }
      const created = await create.mutateAsync({ ...input, password: value.password || null });
      onOpenChange(false);
      if (created.hasPassword === false) {
        onInvited(created);
      }
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${user.username}` : 'New user'}
      description="Someone who can sign in to the clients. Name, email, groups and claims go into their tokens."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <div className="grid gap-4">
          <InputField
            form={form}
            name="username"
            label="Username"
            required
            autoComplete="off"
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the user a username.') }}
          />
          {isNew && (
            <PasswordField
              form={form}
              name="password"
              label="Password"
              description="Leave blank to invite them: you get a link they open to set their own."
              autoComplete="new-password"
              validators={{ onChange: ({ value }) => (value === '' ? undefined : passwordProblem(value)) }}
            />
          )}
          {isNew && (
            <form.Subscribe selector={(state) => state.values}>
              {({ password, username, name, email }) => (
                <PasswordStrengthMeter password={password} owner={[username, name, email]} />
              )}
            </form.Subscribe>
          )}
          <InputField form={form} name="name" label="Full name" autoComplete="off" />
          <InputField form={form} name="email" label="Email" type="email" autoComplete="off" />
          <ComboboxField
            form={form}
            name="groups"
            label="Groups"
            description="Released under the groups scope, for apps that map groups to roles. Type to add a new one. heautou-admin makes them an admin here."
            multiple
            freeText
            options={groupOptions}
            placeholder="No groups"
          />
          <TextareaField
            form={form}
            name="claims"
            label="Custom claims"
            rows={CLAIM_ROWS}
            description="One per line as name=value. Released with the profile scope."
            placeholder="quota=50GB"
            validators={{ onChange: ({ value }) => claimsProblem(value) }}
          />
          <SaveFailure error={failure} />
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Create user'} />
        </>
      )}
    />
  );
}
