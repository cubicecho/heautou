import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { PasswordField } from '@/components/password-field';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { KeyRound, Plus, Trash2 } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { ShieldCheck } from '@/core/app-icons';
import { QR_CODE_DEFAULTS } from '@/core/defaults';
import { messageOf } from '@/core/errors';
import {
  type PasskeyInfo,
  useAddPasskey,
  useConfirmTotp,
  useFactors,
  useNewRecoveryCodes,
  useRemovePasskey,
  useRemoveTotp,
  useStartTotp,
} from '@/core/factors';
import { QUERY_KEYS } from '@/core/query-keys';
import { formatAgo, formatDate, joinStats } from '@/lib/format';

/** What a new passkey is called until the user names it. */
const DEFAULT_PASSKEY_NAME = 'Passkey';

/** Which dialog is up on the section. */
type Dialog =
  | { kind: 'closed' }
  | { kind: 'totp' }
  | { kind: 'passkey' }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'remove-totp' }
  | { kind: 'new-codes' }
  | { kind: 'remove-passkey'; passkey: PasskeyInfo };

interface RecoveryCodesDialogProps {
  codes: string[];
  onClose: () => void;
}

/**
 * Shows recovery codes the one time they can be seen.
 *
 * @param props - The codes, and what to do once they are saved.
 */
function RecoveryCodesDialog({ codes, onClose }: RecoveryCodesDialogProps) {
  const text = codes.join('\n');
  return (
    <DialogLayout
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Save your recovery codes"
      description="Each one signs you in once if you lose your phone or passkey. They are shown only now: keep them somewhere safe, such as a password manager."
      contentSlot={
        <CodeBlock
          content={text}
          title="Recovery codes"
          actionSlot={<CopyButton value={text} label="Copy the recovery codes" />}
        />
      }
      footerActionsSlot={<Button content="I saved them" onClick={onClose} />}
    />
  );
}

interface TotpSetupDialogProps {
  onOpenChange: (open: boolean) => void;
  /** Called with the first recovery codes when turning the app on made them. */
  onCodes: (codes: string[]) => void;
}

/**
 * Sets up an authenticator app: shows a QR code and the key, then checks a code from the app.
 *
 * @param props - What to do when it closes or makes recovery codes.
 */
function TotpSetupDialog({ onOpenChange, onCodes }: TotpSetupDialogProps) {
  const start = useStartTotp();
  const confirm = useConfirmTotp();
  const { mutate } = start;
  useEffect(() => {
    mutate();
  }, [mutate]);
  const uri = start.data?.uri;
  const qr = useQuery({
    queryKey: [...QUERY_KEYS.totpQr, uri],
    queryFn: async () =>
      (await import('qrcode')).toDataURL(uri ?? '', { width: QR_CODE_DEFAULTS.sizePixels, margin: 1 }),
    enabled: uri !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const form = useAppForm({
    defaultValues: { code: '' },
    onSubmit: async ({ value }) => {
      const codes = await confirm.mutateAsync(value.code);
      if (codes === null) {
        onOpenChange(false);
        return;
      }
      onCodes(codes);
    },
  });

  return (
    <DialogLayout
      open
      onOpenChange={onOpenChange}
      title="Set up an authenticator app"
      description="Scan the code with an app such as Aegis, 2FAS, Google Authenticator or a password manager, then type the code it shows."
      contentSlot={
        start.error === null ? (
          <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
            {qr.data === undefined ? (
              <Spinner />
            ) : (
              <img
                src={qr.data}
                width={QR_CODE_DEFAULTS.sizePixels}
                height={QR_CODE_DEFAULTS.sizePixels}
                alt="QR code for your authenticator app"
                className="justify-self-center rounded-md"
              />
            )}
            {start.data === undefined ? null : (
              <CodeBlock
                content={start.data.secret}
                title="Or type this key"
                wrap
                actionSlot={<CopyButton value={start.data.secret} label="Copy the key" />}
              />
            )}
            <InputField
              form={form}
              name="code"
              label="Code from the app"
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Type the code the app shows.') }}
            />
            {confirm.error === null ? null : (
              <Alert variant="destructive" title="Not turned on" description={messageOf(confirm.error)} />
            )}
          </FormElement>
        ) : (
          <Alert variant="destructive" title="Could not start" description={messageOf(start.error)} />
        )
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content="Turn on" />
          </form.AppForm>
        </>
      )}
    />
  );
}

interface AddPasskeyDialogProps {
  onOpenChange: (open: boolean) => void;
  /** Called with the first recovery codes when adding the passkey made them. */
  onCodes: (codes: string[]) => void;
}

/**
 * Names a passkey and lets the browser make it.
 *
 * @param props - What to do when it closes or makes recovery codes.
 */
function AddPasskeyDialog({ onOpenChange, onCodes }: AddPasskeyDialogProps) {
  const add = useAddPasskey();
  const form = useAppForm({
    defaultValues: { name: DEFAULT_PASSKEY_NAME },
    onSubmit: async ({ value }) => {
      const codes = await add.mutateAsync(value.name.trim());
      if (codes === null) {
        onOpenChange(false);
        return;
      }
      onCodes(codes);
    },
  });

  return (
    <DialogLayout
      open
      onOpenChange={onOpenChange}
      title="Add a passkey"
      description="Your browser or password manager makes the passkey and asks for your fingerprint, face or PIN to use it."
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            description="So you can tell it apart, such as the device or the password manager it is in."
            validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give it a name.') }}
          />
          {add.error === null ? null : (
            <Alert variant="destructive" title="Passkey not added" description={messageOf(add.error)} />
          )}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton content="Add passkey" />
          </form.AppForm>
        </>
      )}
    />
  );
}

interface PasswordConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  /** Whether the action takes something away, which draws its button in the destructive colour. */
  isDestructive: boolean;
  onOpenChange: (open: boolean) => void;
  /** Does the action with the password typed. Throws what to show when it fails. */
  onConfirm: (password: string) => Promise<void>;
}

/**
 * Asks for the user's password before a second factor is taken away or replaced.
 *
 * @param props - What is being done, and how.
 */
function PasswordConfirmDialog(props: PasswordConfirmDialogProps) {
  const { title, description, confirmLabel, isDestructive, onOpenChange, onConfirm } = props;
  const [failure, setFailure] = useState<string | null>(null);
  const form = useAppForm({
    defaultValues: { password: '' },
    onSubmit: async ({ value }) => {
      setFailure(null);
      try {
        await onConfirm(value.password);
      } catch (error) {
        setFailure(messageOf(error));
      }
    },
  });

  return (
    <DialogLayout
      open
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      contentSlot={
        <FormElement onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <PasswordField
            form={form}
            name="password"
            label="Your password"
            required
            autoComplete="current-password"
            autoFocus
          />
          {failure === null ? null : <Alert variant="destructive" description={failure} />}
        </FormElement>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.AppForm>
            <form.SubmitButton variant={isDestructive ? 'destructive' : 'default'} content={confirmLabel} />
          </form.AppForm>
        </>
      )}
    />
  );
}

/**
 * The account page's second factors: an authenticator app, passkeys and recovery codes. With one set up, every
 * sign-in asks for it after the password.
 */
export function TwoFactorSection() {
  const factors = useFactors();
  const removeTotp = useRemoveTotp();
  const newCodes = useNewRecoveryCodes();
  const removePasskey = useRemovePasskey();
  const [dialog, setDialog] = useState<Dialog>({ kind: 'closed' });
  const close = (open: boolean): void => {
    if (open === false) {
      setDialog({ kind: 'closed' });
    }
  };
  const showCodes = (codes: string[]): void => setDialog({ kind: 'codes', codes });
  const data = factors.data;
  const canAddPasskey = data?.passkeysAvailable === true && browserSupportsWebAuthn();
  const hasFactor = data !== undefined && (data.hasTotp || data.passkeys.length > 0);
  // Each dialog is drawn only while it is up, so it starts fresh every time.
  const dialogs = (
    <>
      {dialog.kind === 'totp' ? <TotpSetupDialog onOpenChange={close} onCodes={showCodes} /> : null}
      {dialog.kind === 'passkey' ? <AddPasskeyDialog onOpenChange={close} onCodes={showCodes} /> : null}
      {dialog.kind === 'codes' ? (
        <RecoveryCodesDialog codes={dialog.codes} onClose={() => setDialog({ kind: 'closed' })} />
      ) : null}
      {dialog.kind === 'remove-totp' ? (
        <PasswordConfirmDialog
          title="Remove the authenticator app?"
          description="Signing in stops asking for its code. Your passkeys keep working."
          confirmLabel="Remove"
          isDestructive
          onOpenChange={close}
          onConfirm={async (password) => {
            await removeTotp.mutateAsync(password);
            setDialog({ kind: 'closed' });
          }}
        />
      ) : null}
      {dialog.kind === 'new-codes' ? (
        <PasswordConfirmDialog
          title="Make new recovery codes?"
          description="Your old codes stop working."
          confirmLabel="Make new codes"
          isDestructive={false}
          onOpenChange={close}
          onConfirm={async (password) => showCodes(await newCodes.mutateAsync(password))}
        />
      ) : null}
      {dialog.kind === 'remove-passkey' ? (
        <PasswordConfirmDialog
          title={`Remove ${dialog.passkey.name}?`}
          description="It can no longer sign you in. Remove it from your device or password manager too."
          confirmLabel="Remove"
          isDestructive
          onOpenChange={close}
          onConfirm={async (password) => {
            await removePasskey.mutateAsync({ id: dialog.passkey.id, password });
            setDialog({ kind: 'closed' });
          }}
        />
      ) : null}
    </>
  );

  return (
    <Section
      title="Two-factor sign-in"
      description="With an authenticator app or a passkey set up, signing in asks for it after your password. A passkey can also sign you in on its own."
      contentSlot={
        <>
          {factors.isError ? (
            <QueryError error={factors.error} onRetry={factors.refetch} what="your second factors" />
          ) : data === undefined ? (
            <Spinner />
          ) : (
            <div className="grid gap-3">
              <List
                label="Second factors"
                contentSlot={[
                  <ListItem
                    key="totp"
                    leadingSlot={<ShieldCheck className="size-4 text-foreground/60" />}
                    title="Authenticator app"
                    description={data.hasTotp ? 'On. Signing in asks for its code.' : 'Not set up.'}
                    actionSlot={
                      data.hasTotp ? (
                        <Button
                          variant="destructive-outline"
                          size="sm"
                          content="Remove"
                          onClick={() => setDialog({ kind: 'remove-totp' })}
                        />
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          content="Set up"
                          onClick={() => setDialog({ kind: 'totp' })}
                        />
                      )
                    }
                  />,
                  ...data.passkeys.map((passkey) => (
                    <ListItem
                      key={passkey.id}
                      leadingSlot={<KeyRound className="size-4 text-foreground/60" />}
                      title={passkey.name}
                      description={joinStats(
                        `Added ${formatDate(passkey.createdAt)}`,
                        passkey.lastUsedAt === null ? 'never used' : `used ${formatAgo(passkey.lastUsedAt)}`,
                      )}
                      actionSlot={
                        <Button
                          aria-label={`Remove ${passkey.name}`}
                          variant="destructive-outline"
                          size="icon-sm"
                          iconSlot={<Trash2 />}
                          onClick={() => setDialog({ kind: 'remove-passkey', passkey })}
                        />
                      }
                    />
                  )),
                  ...(hasFactor
                    ? [
                        <ListItem
                          key="codes"
                          title="Recovery codes"
                          description={`${data.recoveryCodesLeft} left. Each signs you in once without your phone or passkey.`}
                          actionSlot={
                            <Button
                              variant="outline"
                              size="sm"
                              content="Make new"
                              onClick={() => setDialog({ kind: 'new-codes' })}
                            />
                          }
                        />,
                      ]
                    : []),
                ]}
              />
              {canAddPasskey ? (
                <Button
                  variant="outline"
                  iconSlot={<Plus />}
                  content="Add a passkey"
                  className="justify-self-start"
                  onClick={() => setDialog({ kind: 'passkey' })}
                />
              ) : (
                <Alert
                  variant="info"
                  description={
                    data.passkeysAvailable
                      ? 'This browser can’t use passkeys.'
                      : 'Passkeys need this site to be served over https. Ask your admin to put it behind a TLS proxy to use them.'
                  }
                />
              )}
            </div>
          )}
          {dialogs}
        </>
      }
    />
  );
}
