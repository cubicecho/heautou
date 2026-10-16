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
import { ShieldCheck } from '@/core/app-icons';
import { jsonReply, postJson } from '@/core/json-reply';
import { messageOf } from '@/core/lists';

export const Route = createFileRoute('/setup')({ component: SetupPage });

const FORM_ID = 'setup-form';
const SETUP_URL = '/admin/setup';
const ADMIN_LOGIN = '/admin/login';

const statusSchema = z.object({ needed: z.boolean() });
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
 * Makes the first admin. The server logs a link here, with a token, on every boot until there is one. A user
 * that exists already is made an admin when their password is typed.
 */
function SetupPage() {
  const [token] = useState(tokenFromLink);
  const [failure, setFailure] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ['setup'],
    queryFn: async () => jsonReply(await fetch(SETUP_URL), statusSchema),
    retry: false,
  });

  const form = useAppForm({
    defaultValues: { username: '', password: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        const { redirectTo } = await jsonReply(await postJson(SETUP_URL, { ...value, token }), resultSchema);
        window.location.assign(redirectTo);
      } catch (error) {
        setFailure(messageOf(error));
      }
    },
  });

  const isDone = status.data?.needed === false;
  const canSetUp = token !== null && isDone === false;

  const content = isDone ? (
    <Alert title="Heautou has an admin" description="Sign in with that account to manage clients and users." />
  ) : token === null ? (
    <Alert
      variant="destructive"
      title="Open the link from the server log"
      description="Heautou prints a setup link with a token each time it starts while it has no admin. Read it with `docker compose logs heautou`."
    />
  ) : (
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
      {failure === null ? null : <Alert variant="destructive" title="No admin made" description={failure} />}
    </FormElement>
  );

  return (
    <CenteredLayout
      level={1}
      iconSlot={<ShieldCheck />}
      title="Set up Heautou"
      description="Make the first admin. They can sign in to this page and add clients and users."
      contentSlot={content}
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
