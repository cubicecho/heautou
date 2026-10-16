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
import { messageOf } from '@/core/lists';

export const Route = createFileRoute('/login/$uid')({ component: LoginPage });

const FORM_ID = 'login-form';

const detailsSchema = z.object({ clientName: z.string() });
const resultSchema = z.object({ redirectTo: z.string() });
const errorSchema = z.object({ error: z.string() });

/**
 * Reads a JSON reply from an interaction route, turning its `{error}` into a thrown Error.
 *
 * @param response - The reply.
 * @param schema - What a successful reply holds.
 * @returns The parsed body.
 */
async function interactionReply<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return schema.parse(body);
  }
  const failure = errorSchema.safeParse(body);
  throw new Error(failure.success ? failure.data.error : `The provider answered ${response.status}.`);
}

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
    queryFn: async () => interactionReply(await fetch(`${base}/details`), detailsSchema),
    retry: false,
  });

  const form = useAppForm({
    defaultValues: { username: '', password: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        const response = await fetch(`${base}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        });
        const { redirectTo } = await interactionReply(response, resultSchema);
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
