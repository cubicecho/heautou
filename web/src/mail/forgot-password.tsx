import { InputField, useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { BrandIcon, useBrandName } from '@/core/brand';
import { messageOf } from '@/core/errors';
import { useForgotPassword } from '@/core/mail';

const FORM_ID = 'forgot-password-form';

interface ForgotPasswordProps {
  /** The sign-in it is asked from; the emailed link comes back to it while it is still open. */
  uid: string;
  /** Goes back to the password. */
  onBack: () => void;
}

/**
 * Asks for a password reset link by email, by username or email address. The page says the same thing whether or
 * not an account matched, as the server does.
 *
 * @param props - The sign-in and the way back to it.
 */
export function ForgotPassword({ uid, onBack }: ForgotPasswordProps) {
  const ask = useForgotPassword(uid);
  const brandName = useBrandName();
  const form = useAppForm({
    defaultValues: { identifier: '' },
    onSubmit: async ({ value }) => {
      await ask.mutateAsync(value.identifier.trim());
    },
  });
  const isSent = ask.isSuccess;
  const isAsking = isSent === false;

  return (
    <CenteredLayout
      level={1}
      iconSlot={<BrandIcon className="size-5" />}
      title="Reset your password"
      description={
        isSent
          ? 'If an account matches, a link to choose a new password is on its way to its email address. It works once.'
          : `Type the username or email address of your ${brandName} account. We email a link to choose a new password.`
      }
      contentSlot={
        isSent ? (
          <Alert
            variant="info"
            title="Check your email"
            description="Open the link on this device to come back to this sign-in. No email? Check the spelling, or ask an admin for a link."
          />
        ) : (
          <FormElement id={FORM_ID} onSubmit={() => form.handleSubmit()} className="grid gap-4">
            <InputField
              form={form}
              name="identifier"
              label="Username or email address"
              required
              autoComplete="username"
              autoFocus
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Type your username or address.') }}
            />
            {ask.error !== null && (
              <Alert variant="destructive" title="No link sent" description={messageOf(ask.error)} />
            )}
          </FormElement>
        )
      }
      footerActionsSlot={
        <>
          <Button variant="outline" onClick={onBack} content="Back to sign in" />
          {isAsking && (
            <form.AppForm>
              <form.SubmitButton content="Send link" />
            </form.AppForm>
          )}
        </>
      }
    />
  );
}
