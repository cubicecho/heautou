import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { InputField, useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { BrandIcon } from '@/core/brand';
import { jsonReply, postJson } from '@/core/json-reply';
import { messageOf } from '@/core/lists';
import { PasswordStrengthMeter } from '@/passwords/strength-meter';

export const Route = createFileRoute('/setup')({ component: SetupPage });

const FORM_ID = 'setup-form';
const SETUP_URL = '/admin/setup';
const ADMIN_LOGIN = '/admin/login';

const statusSchema = z.object({ needed: z.boolean(), tokenRequired: z.boolean() });
/** How the operator reads the token, in the quick start's setup. */
const LOG_HINT = 'Find it in the server log: docker compose logs heautou | grep setup.';
const resultSchema = z.object({ redirectTo: z.string() });

/**
 * Reads the setup token from the link's fragment, which never reaches the server's logs or a proxy's.
 *
 * @returns The token, or null when the link had none.
 */
function tokenFromLink(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('token');
}

/**
 * Makes the first admin, where the app sends a browser while there is none. For a few minutes after boot a new
 * account needs nothing else; after that, or to make an existing user the admin with their password, it needs the
 * token the server logs, which arrives in this page's link or is pasted in.
 */
function SetupPage() {
  const [linkToken] = useState(tokenFromLink);
  const [failure, setFailure] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['setup'],
    queryFn: async () => jsonReply(await fetch(SETUP_URL), statusSchema),
    retry: false,
  });

  const form = useAppForm({
    defaultValues: { username: '', password: '', token: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        const body = { ...value, token: linkToken ?? value.token };
        const { redirectTo } = await jsonReply(await postJson(SETUP_URL, body), resultSchema);
        window.location.assign(redirectTo);
      } catch (error) {
        setFailure(messageOf(error));
      }
    },
  });

  const isDone = status.data?.needed === false;
  const asksForToken = linkToken === null && status.data?.tokenRequired === true;
  const canSetUp = status.data?.needed === true;

  const setupForm = (
    <FormElement id={FORM_ID} onSubmit={() => form.handleSubmit()} className="grid gap-4">
      <InputField
        form={form}
        name="username"
        label="Username"
        required
        autoComplete="username"
        autoFocus
        validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Enter a username.') }}
      />
      <PasswordField form={form} name="password" label="Password" required autoComplete="new-password" />
      <form.Subscribe selector={(state) => state.values}>
        {({ password, username }) => <PasswordStrengthMeter password={password} owner={[username]} />}
      </form.Subscribe>
      {asksForToken ? (
        <InputField
          form={form}
          name="token"
          label="Setup token"
          description={`Setup without a token has closed. ${LOG_HINT}`}
          required
          autoComplete="off"
          validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Paste the setup token.') }}
        />
      ) : null}
      {failure === null ? null : <Alert variant="destructive" title="No admin made" description={failure} />}
    </FormElement>
  );
  const done = (
    <Alert title="Heautou has an admin" description="Sign in with that account to manage clients and users." />
  );
  const content = isDone ? done : setupForm;
  const description =
    linkToken === null && asksForToken === false
      ? `Make the first admin account. To make an existing user the admin instead, open the setup link. ${LOG_HINT}`
      : 'Make the first admin, or type an existing user’s username and password to make them the admin.';

  return (
    <CenteredLayout
      level={1}
      iconSlot={<BrandIcon className="size-5" />}
      title="Set up Heautou"
      description={description}
      contentSlot={
        status.error === null ? (
          content
        ) : (
          <Alert variant="destructive" title="Can’t reach Heautou" description={messageOf(status.error)} />
        )
      }
      footerActionsSlot={
        canSetUp ? (
          <form.AppForm>
            <form.SubmitButton content="Make admin" />
          </form.AppForm>
        ) : isDone ? (
          <Button content="Sign in" onClick={() => window.location.assign(ADMIN_LOGIN)} />
        ) : undefined
      }
    />
  );
}
