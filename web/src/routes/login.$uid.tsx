import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { InputField, useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { PasswordField } from '@/components/password-field';
import { Alert } from '@/components/ui/alert';
import { FormElement } from '@/components/ui/form-element';
import { ShieldCheck } from '@/core/app-icons';
import { jsonReply, postJson } from '@/core/json-reply';
import { messageOf } from '@/core/lists';

export const Route = createFileRoute('/login/$uid')({ component: LoginPage });

const FORM_ID = 'login-form';

const detailsSchema = z.object({ clientName: z.string() });
const resultSchema = z.object({ redirectTo: z.string() });

/**
 * The sign-in page the provider sends a browser to. It names the client asking and, once the
 * password matches, sends the browser back to the provider to finish.
 */
function LoginPage() {
  const { uid } = Route.useParams();
  const base = `/interaction/${encodeURIComponent(uid)}`;
  const [failure, setFailure] = useState<string | null>(null);

  const details = useQuery({
    queryKey: ['interaction', uid],
    queryFn: async () => jsonReply(await fetch(`${base}/details`), detailsSchema),
    retry: false,
  });

  const form = useAppForm({
    defaultValues: { username: '', password: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        const { redirectTo } = await jsonReply(await postJson(`${base}/login`, value), resultSchema);
        window.location.assign(redirectTo);
      } catch (error) {
        setFailure(messageOf(error));
      }
    },
  });

  const description =
    details.data === undefined ? 'Sign in to continue.' : `Sign in to continue to ${details.data.clientName}.`;

  return (
    <CenteredLayout
      level={1}
      iconSlot={<ShieldCheck />}
      title="Sign in"
      description={description}
      contentSlot={
        details.error === null ? (
          <FormElement id={FORM_ID} onSubmit={() => form.handleSubmit()} className="grid gap-4">
            <InputField
              form={form}
              name="username"
              label="Username"
              required
              autoComplete="username"
              autoFocus
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Enter your username.') }}
            />
            <PasswordField form={form} name="password" label="Password" required autoComplete="current-password" />
            {failure === null ? null : <Alert variant="destructive" title="Not signed in" description={failure} />}
          </FormElement>
        ) : (
          <Alert
            variant="destructive"
            title="This sign-in has expired"
            description={`${messageOf(details.error)} Go back to the application and start again.`}
          />
        )
      }
      footerActionsSlot={
        details.error === null ? (
          <form.AppForm>
            <form.SubmitButton content="Sign in" />
          </form.AppForm>
        ) : undefined
      }
    />
  );
}
