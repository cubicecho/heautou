import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { FormElement } from '@/components/ui/form-element';
import { Spinner } from '@/components/ui/spinner';
import { usePasswordLink, useSetPasswordWithLink } from '@/core/account';
import { BrandIcon, useBrandName } from '@/core/brand';
import { messageOf } from '@/core/errors';
import { signInAfterReset } from '@/core/mail';
import { fragmentParam } from '@/core/url-fragment';
import { PasswordStrengthMeter } from '@/passwords/strength-meter';
import { passwordProblem } from '@/users/user-form-dialog';

export const Route = createFileRoute('/set-password')({ component: SetPasswordPage });

/** The fragment parameter (`fragmentParam`) holding the link's token. */
const TOKEN_PARAM = 'token';

const FORM_ID = 'set-password-form';

/**
 * Where an invite or a reset link opens: the user chooses a password, then signs in with it.
 */
function SetPasswordPage() {
  const [token] = useState(() => fragmentParam(TOKEN_PARAM));
  const link = usePasswordLink(token);
  const setPassword = useSetPasswordWithLink();
  const brandName = useBrandName();

  const form = useAppForm({
    defaultValues: { password: '', confirm: '' },
    onSubmit: async ({ value }) => {
      if (token === null) {
        return;
      }
      const { redirectTo } = await setPassword.mutateAsync({ token, password: value.password });
      window.location.assign(await signInAfterReset(redirectTo));
    },
  });

  const isDead = token === null || link.isError;
  const who = link.data;
  const title =
    who === undefined ? 'Choose a password' : who.isInvite ? `Welcome, ${who.username}` : 'Choose a new password';

  return (
    <CenteredLayout
      level={1}
      iconSlot={<BrandIcon className="size-5" />}
      title={title}
      description={
        who?.isInvite === true
          ? `Choose a password for your ${brandName} account. You sign in with it next.`
          : `Choose a new password for your ${brandName} account.`
      }
      wrapperSlot={
        isDead || who === undefined
          ? undefined
          : (parts, { className }) => (
              <form.AppForm>
                <FormElement id={FORM_ID} onSubmit={() => form.handleSubmit()} className={className}>
                  {parts}
                </FormElement>
              </form.AppForm>
            )
      }
      contentSlot={
        isDead ? (
          <Alert
            variant="destructive"
            title="This link does not work"
            description={
              token === null
                ? 'The link is missing its token. Copy the whole link you were sent.'
                : messageOf(link.error)
            }
          />
        ) : who === undefined ? (
          <Spinner />
        ) : (
          <div className="grid gap-4">
            {/* Lets a password manager save the password under the right account. */}
            <input type="text" name="username" value={who.username} autoComplete="username" readOnly hidden />
            <PasswordField
              form={form}
              name="password"
              label="Password"
              required
              autoComplete="new-password"
              autoFocus
              validators={{ onChange: ({ value }) => passwordProblem(value) }}
            />
            <form.Subscribe selector={(state) => state.values.password}>
              {(password) => <PasswordStrengthMeter password={password} owner={[who.username]} />}
            </form.Subscribe>
            <PasswordField
              form={form}
              name="confirm"
              label="Type it again"
              required
              autoComplete="new-password"
              validators={{
                onChange: ({ value, fieldApi }) =>
                  value === fieldApi.form.getFieldValue('password') ? undefined : 'The two passwords differ.',
              }}
            />
            {setPassword.error !== null && (
              <Alert variant="destructive" title="Password not set" description={messageOf(setPassword.error)} />
            )}
          </div>
        )
      }
      footerActionsSlot={isDead || who === undefined ? undefined : <form.SubmitButton content="Set password" />}
    />
  );
}
