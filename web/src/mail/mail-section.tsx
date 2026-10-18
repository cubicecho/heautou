import type { MailSettingsFieldsFragment } from '@/__generated__/graphql';
import { InputField, NumberField, SwitchField, useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { FieldRow } from '@/components/field-row';
import { PasswordField } from '@/components/password-field';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { FormElement } from '@/components/ui/form-element';
import { Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Send } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { useMail, useRemoveMailServer, useSendTestEmail, useSetMailOptions, useSetMailServer } from '@/core/mail';

/** The optional emails, each a switch under the server. */
const OPTIONS = [
  {
    key: 'forgotPassword',
    title: 'Forgot password link',
    description:
      'Shows “Forgot password?” on the sign-in page. It emails a reset link to the address of the username or address typed, and answers the same whether or not one matches.',
  },
  {
    key: 'notifyPasswordChanged',
    title: 'Tell users when their password changes',
    description: 'On the account page, by an admin, or with a reset link.',
  },
  {
    key: 'notifyFactorAdded',
    title: 'Tell users when a second factor is added',
    description: 'An authenticator app or a passkey.',
  },
  {
    key: 'notifyFactorRemoved',
    title: 'Tell users when a second factor is removed',
    description: 'By them, or by an admin resetting their two-factor sign-in.',
  },
] as const;

/** The port a new server starts on: submission with STARTTLS. */
const SUBMISSION_PORT = 587;
/** Highest TCP port. */
const MAX_PORT = 65_535;

/**
 * The SMTP server form, for a server saved under Settings or none yet.
 *
 * @param props - The current settings.
 * @param props.mail - What the server answered.
 * @returns The form.
 */
function ServerForm({ mail }: { mail: MailSettingsFieldsFragment }) {
  const save = useSetMailServer();
  const remove = useRemoveMailServer();
  const server = mail.server;
  const form = useAppForm({
    defaultValues: {
      host: server?.host ?? '',
      port: (server?.port ?? SUBMISSION_PORT) as number | null,
      secure: server?.secure ?? false,
      user: server?.user ?? '',
      password: '',
      from: server?.from ?? '',
    },
    onSubmit: async ({ value, formApi }) => {
      const saved = await save.mutateAsync({
        host: value.host.trim(),
        port: value.port,
        secure: value.secure,
        user: value.user.trim(),
        password: value.password === '' ? null : value.password,
        from: value.from.trim(),
      });
      formApi.reset({ ...value, password: '', port: saved.server?.port ?? value.port });
    },
  });

  return (
    <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
      <FieldRow
        contentSlot={
          <>
            <InputField
              form={form}
              name="host"
              label="SMTP server"
              required
              placeholder="mail.example.home"
              autoComplete="off"
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Name the SMTP server.') }}
            />
            <NumberField
              form={form}
              name="port"
              label="Port"
              integer
              min={1}
              max={MAX_PORT}
              validators={{
                onChange: ({ value }) =>
                  value === null || (value >= 1 && value <= MAX_PORT) ? undefined : `A port is 1 to ${MAX_PORT}.`,
              }}
            />
          </>
        }
      />
      <SwitchField
        form={form}
        name="secure"
        label="TLS from the start (SMTPS)"
        description="Usually port 465. Off, the connection is upgraded with STARTTLS when the server offers it."
      />
      <FieldRow
        contentSlot={
          <>
            <InputField form={form} name="user" label="User" autoComplete="off" placeholder="None" />
            <PasswordField
              form={form}
              name="password"
              label="Password"
              autoComplete="new-password"
              placeholder={server?.hasPassword ? 'Saved. Leave blank to keep it.' : undefined}
            />
          </>
        }
      />
      <InputField
        form={form}
        name="from"
        label="Send as"
        required
        placeholder="Heautou <auth@example.home>"
        description="The sender every email shows. Your SMTP server may only accept its own addresses."
        validators={{ onChange: ({ value }) => (value.includes('@') ? undefined : 'Give an address to send from.') }}
      />
      {save.error === null ? null : (
        <Alert variant="destructive" title="Server not saved" description={messageOf(save.error)} />
      )}
      {remove.error === null ? null : (
        <Alert variant="destructive" title="Server not removed" description={messageOf(remove.error)} />
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {mail.source === 'SETTINGS' ? (
          <ConfirmButton
            variant="outline"
            iconSlot={<Trash2 />}
            content="Remove server"
            title="Remove the SMTP server?"
            description="No more email is sent: links go back to being copied by hand, and the forgot-password link is hidden."
            confirmLabel="Remove"
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        ) : null}
        <form.AppForm>
          <form.SubmitButton requireChanges={server !== null} content="Save server" />
        </form.AppForm>
      </div>
    </FormElement>
  );
}

/**
 * Sends a test email, to the admin's own address unless another is typed.
 *
 * @returns The form and what came of it.
 */
function TestEmail() {
  const send = useSendTestEmail();
  const form = useAppForm({
    defaultValues: { to: '' },
    onSubmit: async ({ value }) => {
      await send.mutateAsync(value.to.trim() === '' ? null : value.to.trim());
    },
  });
  return (
    <div className="grid gap-2">
      <FormElement onSubmit={() => form.handleSubmit()} className="flex flex-wrap items-end gap-2">
        <InputField
          form={form}
          name="to"
          label="Send a test email"
          type="email"
          placeholder="Your own address"
          className="min-w-48 flex-1"
        />
        <form.AppForm>
          <form.SubmitButton variant="outline" iconSlot={<Send />} content="Send test email" />
        </form.AppForm>
      </FormElement>
      {send.data === undefined ? null : (
        <Alert variant="info" title="Test email sent" description={`It went to ${send.data}. Check that inbox.`} />
      )}
      {send.error === null ? null : (
        <Alert variant="destructive" title="Test email not sent" description={messageOf(send.error)} />
      )}
    </div>
  );
}

/**
 * Email: the SMTP server (from the environment, or saved here), a test, and the optional emails.
 *
 * @returns The section.
 */
export function MailSection() {
  const mail = useMail();
  const setOptions = useSetMailOptions();
  const current = mail.data;
  const isLocked = current?.source === 'ENV';

  return (
    <Section
      title="Email"
      description="Lets invite and reset links be sent by email, and the optional emails below. Without a server, links are copied by hand as before."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {mail.isError ? <QueryError error={mail.error} onRetry={mail.refetch} what="the email settings" /> : null}
          {current === undefined ? null : isLocked ? (
            <>
              <Alert
                variant="info"
                title="Set by the environment"
                description="SMTP_URL or SMTP_HOST sets the server, so it cannot be changed here. Change it there and restart."
              />
              <DescriptionList
                contentSlot={[
                  <PropertyRow
                    key="host"
                    label="SMTP server"
                    value={`${current.server?.host}:${current.server?.port}${current.server?.secure ? ' (TLS)' : ''}`}
                  />,
                  <PropertyRow key="user" label="User" value={current.server?.user || 'None'} />,
                  <PropertyRow key="from" label="Send as" value={current.server?.from ?? ''} />,
                ]}
              />
            </>
          ) : (
            <ServerForm mail={current} />
          )}
          {current?.isConfigured ? <TestEmail /> : null}
          {OPTIONS.map((option) => (
            <SettingRow
              key={option.key}
              title={option.title}
              description={option.description}
              actionSlot={({ titleId }) => (
                <Switch
                  aria-labelledby={titleId}
                  checked={current?.[option.key] ?? false}
                  disabled={current?.isConfigured !== true || setOptions.isPending}
                  hint={current?.isConfigured ? undefined : 'Set up a server first'}
                  onCheckedChange={(checked) => setOptions.mutate({ [option.key]: checked })}
                />
              )}
            />
          ))}
          {setOptions.error === null ? null : (
            <Alert variant="destructive" title="Setting not saved" description={messageOf(setOptions.error)} />
          )}
        </div>
      }
    />
  );
}
