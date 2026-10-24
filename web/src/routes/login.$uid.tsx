import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldSeparator } from '@/components/ui/field';
import { FormElement } from '@/components/ui/form-element';
import { KeyRound } from '@/components/ui/icons';
import { BrandIcon, useBrandName } from '@/core/brand';
import { messageOf } from '@/core/errors';
import { redirectReplySchema } from '@/core/json-reply';
import { useForgotPasswordAvailable } from '@/core/mail';
import {
  interactionPath,
  loginReplySchema,
  passkeyOptionsReplySchema,
  post,
  type SecondFactorChoice,
  SignInRefusal,
  useSignInDetails,
} from '@/core/sign-in';
import { ForgotPassword } from '@/mail/forgot-password';

export const Route = createFileRoute('/login/$uid')({ component: LoginPage });

const PASSWORD_FORM_ID = 'login-form';
const CODE_FORM_ID = 'second-factor-form';

/** Where the server says why a sign-in through a provider did not work: `/login/:uid?error=`. */
const ERROR_PARAM = 'error';

/**
 * Says what the second-factor step asks for.
 *
 * @param choice - The factors the user has.
 * @returns A sentence.
 */
function secondFactorPrompt(choice: SecondFactorChoice): string {
  if (choice.totp) {
    return choice.passkey
      ? 'Type the code from your authenticator app, or use your passkey.'
      : 'Type the code from your authenticator app.';
  }
  return choice.passkey ? 'Use your passkey to finish signing in.' : 'Type one of your recovery codes.';
}

/**
 * The sign-in page the provider sends a browser to. It names the client asking, takes the password, then a second
 * factor for a user who has one, and sends the browser back to the provider to finish. A passkey can also sign in on
 * its own, with no username.
 */
function LoginPage() {
  const { uid } = Route.useParams();
  const base = interactionPath(uid);
  const [failure, setFailure] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get(ERROR_PARAM),
  );
  const [secondFactor, setSecondFactor] = useState<SecondFactorChoice | null>(null);
  const [isUsingPasskey, setUsingPasskey] = useState(false);
  const [isForgotten, setForgotten] = useState(false);
  const canReset = useForgotPasswordAvailable(uid).data === true;

  const details = useSignInDetails(uid);

  const cameBackFrom = details.data?.secondFactor ?? null;
  useEffect(() => {
    if (cameBackFrom !== null) {
      setSecondFactor(cameBackFrom);
    }
  }, [cameBackFrom]);

  /**
   * Reports a refusal, going back to the password when the sign-in has to start again.
   *
   * @param error - What was thrown.
   */
  const refused = (error: unknown): void => {
    const isRestart = error instanceof SignInRefusal && error.restart;
    if (isRestart) {
      setSecondFactor(null);
    }
    setFailure(messageOf(error));
  };

  /** Signs in with a passkey: after the password, or on its own. */
  const signInWithPasskey = async (): Promise<void> => {
    setFailure(null);
    setUsingPasskey(true);
    try {
      const { options } = await post(`${base}/passkey/options`, {}, passkeyOptionsReplySchema);
      const response = await startAuthentication({ optionsJSON: options });
      const { redirectTo } = await post(`${base}/passkey`, { response }, redirectReplySchema);
      window.location.assign(redirectTo);
    } catch (error) {
      refused(error);
    } finally {
      setUsingPasskey(false);
    }
  };

  const passwordForm = useAppForm({
    defaultValues: { username: '', password: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        const reply = await post(`${base}/login`, value, loginReplySchema);
        if ('secondFactor' in reply) {
          setSecondFactor(reply.secondFactor);
          return;
        }
        window.location.assign(reply.redirectTo);
      } catch (error) {
        refused(error);
      }
    },
  });

  const codeForm = useAppForm({
    defaultValues: { code: '' },
    onSubmit: async ({ value, formApi }) => {
      setFailure(null);
      try {
        const { redirectTo } = await post(`${base}/second-factor`, value, redirectReplySchema);
        window.location.assign(redirectTo);
      } catch (error) {
        formApi.reset();
        refused(error);
      }
    },
  });

  const brandName = useBrandName();
  const upstreams = details.data?.upstreams ?? [];
  const hasUpstreams = upstreams.length > 0;
  const canUsePasskeys = details.data?.passkeysAvailable === true && browserSupportsWebAuthn();
  const isAskingCode = secondFactor !== null && (secondFactor.totp || secondFactor.recoveryCode);
  const canUseOwnPasskey = secondFactor?.passkey && canUsePasskeys;
  const description =
    secondFactor !== null
      ? cameBackFrom === null
        ? secondFactorPrompt(secondFactor)
        : `Signed in with ${cameBackFrom.provider}. ${secondFactorPrompt(secondFactor)}`
      : details.data === undefined
        ? `Sign in with your ${brandName} account to continue.`
        : `Sign in with your ${brandName} account to continue to ${details.data.clientName}.`;
  const failureAlert =
    failure === null ? null : <Alert variant="destructive" title="Not signed in" description={failure} />;
  const passkeyButton = (
    <Button
      variant="outline"
      iconSlot={<KeyRound />}
      content={secondFactor === null ? 'Sign in with a passkey' : 'Use your passkey'}
      loading={isUsingPasskey}
      onClick={() => {
        void signInWithPasskey();
      }}
    />
  );

  const passwordStep = (
    <FormElement id={PASSWORD_FORM_ID} onSubmit={() => passwordForm.handleSubmit()} className="grid gap-4">
      <InputField
        form={passwordForm}
        name="username"
        label="Username"
        required
        autoComplete="username webauthn"
        autoFocus
        validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Enter your username.') }}
      />
      <PasswordField form={passwordForm} name="password" label="Password" required autoComplete="current-password" />
      {canReset && (
        <Button
          variant="link"
          size="sm"
          className="justify-self-start px-0"
          content="Forgot password?"
          onClick={() => setForgotten(true)}
        />
      )}
      {failureAlert}
      {hasUpstreams && <FieldSeparator />}
      {hasUpstreams && (
        <div className="grid gap-2">
          {upstreams.map((upstream) => (
            <Button
              key={upstream.id}
              variant="outline"
              content={`Sign in with ${upstream.name}`}
              onClick={() => window.location.assign(`${base}/upstream/${encodeURIComponent(upstream.id)}`)}
            />
          ))}
        </div>
      )}
    </FormElement>
  );

  const secondFactorStep = (
    <FormElement id={CODE_FORM_ID} onSubmit={() => codeForm.handleSubmit()} className="grid gap-4">
      {isAskingCode && (
        <InputField
          form={codeForm}
          name="code"
          label={secondFactor?.totp ? 'Code' : 'Recovery code'}
          description={
            secondFactor?.totp && secondFactor.recoveryCode
              ? 'Lost your phone? Type a recovery code instead.'
              : undefined
          }
          required
          autoComplete="one-time-code"
          autoFocus
          validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Type the code.') }}
        />
      )}
      {failureAlert}
    </FormElement>
  );

  if (isForgotten && secondFactor === null) {
    return <ForgotPassword uid={uid} onBack={() => setForgotten(false)} />;
  }

  return (
    <CenteredLayout
      level={1}
      iconSlot={<BrandIcon className="size-5" />}
      title={secondFactor === null ? 'Sign in' : 'Confirm it’s you'}
      description={description}
      contentSlot={
        details.error === null ? (
          secondFactor === null ? (
            passwordStep
          ) : (
            secondFactorStep
          )
        ) : (
          <Alert
            variant="destructive"
            title="This sign-in has expired"
            description={`${messageOf(details.error)} Go back to the application and start again.`}
          />
        )
      }
      footerActionsSlot={
        details.error !== null ? undefined : secondFactor === null ? (
          <>
            {canUsePasskeys && passkeyButton}
            <passwordForm.AppForm>
              <passwordForm.SubmitButton content="Sign in" />
            </passwordForm.AppForm>
          </>
        ) : (
          <>
            {canUseOwnPasskey && passkeyButton}
            {isAskingCode && (
              <codeForm.AppForm>
                <codeForm.SubmitButton content="Continue" />
              </codeForm.AppForm>
            )}
          </>
        )
      }
    />
  );
}
