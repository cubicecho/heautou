import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from '@simplewebauthn/browser';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { InputField, useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { KeyRound } from '@/components/ui/icons';
import { BrandIcon, useBrandName } from '@/core/brand';
import { messageOf } from '@/core/lists';

export const Route = createFileRoute('/login/$uid')({ component: LoginPage });

const PASSWORD_FORM_ID = 'login-form';
const CODE_FORM_ID = 'second-factor-form';

const choiceSchema = z.object({ totp: z.boolean(), passkey: z.boolean(), recoveryCode: z.boolean() });
const detailsSchema = z.object({
  clientName: z.string(),
  passkeysAvailable: z.boolean(),
  /** The providers users may sign in through instead. */
  upstreams: z.array(z.object({ id: z.string(), name: z.string() })),
  /** A sign-in that came back from one of them and still needs a second factor here. */
  secondFactor: choiceSchema.extend({ provider: z.string() }).nullable(),
});
/** Where the server says why a sign-in through a provider did not work: `/login/:uid?error=`. */
const ERROR_PARAM = 'error';
/** The login POST's reply: where to go next, or which second factors to ask for. */
const loginSchema = z.union([z.object({ redirectTo: z.string() }), z.object({ secondFactor: choiceSchema })]);
const resultSchema = z.object({ redirectTo: z.string() });
const failureSchema = z.object({ error: z.string(), restart: z.boolean().optional() });
const passkeyOptionsSchema = z.object({
  options: z.custom<PublicKeyCredentialRequestOptionsJSON>(
    (value) => typeof value === 'object' && value !== null && 'challenge' in value,
  ),
});

/** The second factors the page may ask for. */
type SecondFactorChoice = z.infer<typeof choiceSchema>;

/** A refusal from an interaction route: what to show, and whether the sign-in has to start again. */
class SignInRefusal extends Error {
  readonly restart: boolean;

  /**
   * @param message - What to show.
   * @param restart - Whether the sign-in has to start again from the password.
   */
  constructor(message: string, restart: boolean) {
    super(message);
    this.restart = restart;
  }
}

/**
 * POSTs JSON to an interaction route and reads the reply.
 *
 * @typeParam T - The reply's shape.
 * @param url - The route.
 * @param body - What to send.
 * @param schema - The reply's shape.
 * @returns The reply.
 * @throws SignInRefusal with the server's message when it refuses.
 */
async function post<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return schema.parse(reply);
  }
  const failure = failureSchema.safeParse(reply);
  throw failure.success
    ? new SignInRefusal(failure.data.error, failure.data.restart === true)
    : new SignInRefusal(`The server answered ${response.status}.`, false);
}

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
  const base = `/interaction/${encodeURIComponent(uid)}`;
  const [failure, setFailure] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get(ERROR_PARAM),
  );
  const [secondFactor, setSecondFactor] = useState<SecondFactorChoice | null>(null);
  const [isUsingPasskey, setUsingPasskey] = useState(false);

  const details = useQuery({
    queryKey: ['interaction', uid],
    queryFn: async () => {
      const response = await fetch(`${base}/details`);
      const reply: unknown = await response.json().catch(() => null);
      if (response.ok === false) {
        throw new Error(failureSchema.safeParse(reply).data?.error ?? `The server answered ${response.status}.`);
      }
      return detailsSchema.parse(reply);
    },
    retry: false,
  });

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
      const { options } = await post(`${base}/passkey/options`, {}, passkeyOptionsSchema);
      const response = await startAuthentication({ optionsJSON: options });
      const { redirectTo } = await post(`${base}/passkey`, { response }, resultSchema);
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
        const reply = await post(`${base}/login`, value, loginSchema);
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
        const { redirectTo } = await post(`${base}/second-factor`, value, resultSchema);
        window.location.assign(redirectTo);
      } catch (error) {
        formApi.reset();
        refused(error);
      }
    },
  });

  const brandName = useBrandName();
  const upstreams = details.data?.upstreams ?? [];
  const canUsePasskeys = details.data?.passkeysAvailable === true && browserSupportsWebAuthn();
  const isAskingCode = secondFactor !== null && (secondFactor.totp || secondFactor.recoveryCode);
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
      {failureAlert}
      {upstreams.length === 0 ? null : (
        <div className="grid gap-2 border-t pt-4">
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
      {isAskingCode ? (
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
      ) : null}
      {failureAlert}
    </FormElement>
  );

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
            {canUsePasskeys ? passkeyButton : null}
            <passwordForm.AppForm>
              <passwordForm.SubmitButton content="Sign in" />
            </passwordForm.AppForm>
          </>
        ) : (
          <>
            {secondFactor.passkey && canUsePasskeys ? passkeyButton : null}
            {isAskingCode ? (
              <codeForm.AppForm>
                <codeForm.SubmitButton content="Continue" />
              </codeForm.AppForm>
            ) : null}
          </>
        )
      }
    />
  );
}
