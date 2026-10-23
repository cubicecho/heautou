import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { UpstreamFieldsFragment } from '@/__generated__/graphql';
import { BackupSection } from '@/backup/backup-section';
import { InputField, useAppForm } from '@/components/app-form';
import { Combobox } from '@/components/combobox';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FilePickerButton } from '@/components/ui/file-picker';
import type { PickedFile } from '@/components/ui/file-picker-base';
import { FormElement } from '@/components/ui/form-element';
import { Pencil, Plus, RefreshCw, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import {
  useBranding,
  useDeleteUpstream,
  useHttpRedirects,
  useKeys,
  usePasswordRules,
  useRotateKeys,
  useSetBrandingLogo,
  useSetBrandingName,
  useSetHttpRedirects,
  useSetPasswordRules,
  useUpstreams,
} from '@/core/admin';
import { ImageUp } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { formatAgo, formatBytes, formatDateTime, joinStats } from '@/lib/format';
import { MailSection } from '@/mail/mail-section';
import { UpstreamFormDialog } from '@/upstreams/upstream-form-dialog';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

/** The image types the server takes for a logo. */
const LOGO_TYPES = 'image/png,image/jpeg,image/webp,image/svg+xml';
/** The largest logo the server takes, in bytes: `BRANDING_DEFAULTS.maxLogoBytes`. */
const MAX_LOGO_BYTES = 262_144;
/** How many bytes go to `String.fromCharCode` at once, well under the engines' argument limits. */
const CHUNK_BYTES = 0x8000;

/**
 * Encodes a picked image as a data URL, the form `setBrandingLogo` takes.
 *
 * @param file - The image, read as bytes.
 * @returns The data URL.
 */
function dataUrlOf(file: PickedFile): string {
  const bytes = file.bytes ?? new Uint8Array();
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK_BYTES));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}

/**
 * The name and logo the sign-in pages and the sidebar show.
 */
function BrandingSection() {
  const branding = useBranding();
  const setName = useSetBrandingName();
  const setLogo = useSetBrandingLogo();
  const [tooBig, setTooBig] = useState<string | null>(null);
  const logoUrl = branding.data?.logoUrl ?? null;
  const failure = setName.error ?? setLogo.error;

  const form = useAppForm({
    defaultValues: { name: branding.data?.name ?? '' },
    onSubmit: async ({ value, formApi }) => {
      const saved = await setName.mutateAsync(value.name.trim());
      formApi.reset({ name: saved.name });
    },
  });

  const pick = ([file]: PickedFile[]) => {
    if (file === undefined) {
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setTooBig(`${file.name} is ${formatBytes(file.size)}. Use an image under ${formatBytes(MAX_LOGO_BYTES)}.`);
      return;
    }
    setTooBig(null);
    setLogo.mutate(dataUrlOf(file));
  };

  return (
    <Section
      title="Branding"
      description="What the sign-in page and the sidebar call this provider."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {branding.isError ? (
            <QueryError error={branding.error} onRetry={branding.refetch} what="the branding" />
          ) : null}
          <FormElement onSubmit={() => form.handleSubmit()} className="flex flex-wrap items-end gap-2">
            <InputField
              form={form}
              name="name"
              label="Name"
              className="min-w-48 flex-1"
              autoComplete="off"
              validators={{ onChange: ({ value }) => (value.trim() ? undefined : 'Give the provider a name.') }}
            />
            <form.AppForm>
              <form.SubmitButton variant="outline" content="Save name" />
            </form.AppForm>
          </FormElement>
          <SettingRow
            title="Logo"
            description="PNG, JPEG, WebP or SVG, up to 256 KB. Shown beside the name; square looks best."
            actionSlot={
              <div className="flex items-center gap-2">
                {logoUrl === null ? null : (
                  <>
                    <img src={logoUrl} alt="The current logo" className="size-8 rounded object-contain" />
                    <Button
                      aria-label="Remove the logo"
                      hint="Remove logo"
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      disabled={setLogo.isPending}
                      onClick={() => setLogo.mutate(null)}
                    />
                  </>
                )}
                <FilePickerButton
                  label={logoUrl === null ? 'Upload logo' : 'Replace logo'}
                  accept={LOGO_TYPES}
                  read="bytes"
                  variant="outline"
                  size="sm"
                  iconSlot={<ImageUp />}
                  onPickMany={pick}
                />
              </div>
            }
          />
          {tooBig === null ? null : <Alert variant="destructive" title="Logo not used" description={tooBig} />}
          {failure === null ? null : (
            <Alert variant="destructive" title="Branding not saved" description={messageOf(failure)} />
          )}
        </div>
      }
    />
  );
}

/** Which provider the dialog is open on: none, a new one, or one to edit. */
type UpstreamDialog = { kind: 'closed' } | { kind: 'open'; upstream: UpstreamFieldsFragment | null };

/**
 * The providers users may sign in through instead of with a password.
 */
function UpstreamsSection() {
  const upstreams = useUpstreams();
  const remove = useDeleteUpstream();
  const [dialog, setDialog] = useState<UpstreamDialog>({ kind: 'closed' });
  const list = upstreams.data ?? [];

  return (
    <Section
      title="Sign-in providers"
      description="Accounts elsewhere, such as Google or GitHub, that users may sign in with. Each user links theirs from their account page."
      surface="card"
      actionSlot={
        <Button
          variant="outline"
          size="sm"
          iconSlot={<Plus />}
          content="Add provider"
          onClick={() => setDialog({ kind: 'open', upstream: null })}
        />
      }
      contentSlot={
        <div className="grid gap-2">
          {upstreams.isError ? (
            <QueryError error={upstreams.error} onRetry={upstreams.refetch} what="the sign-in providers" />
          ) : null}
          {upstreams.isSuccess && list.length === 0 ? (
            <EmptyState compact title="Users sign in with a password or a passkey only." />
          ) : null}
          <List
            label="Sign-in providers"
            contentSlot={list.map((upstream) => (
              <ListItem
                key={upstream.id}
                title={upstream.name}
                description={joinStats(
                  upstream.kind === 'GITHUB' ? 'GitHub' : upstream.issuer,
                  upstream.unknownIdentity === 'CREATE' ? 'makes users' : 'linked accounts only',
                  upstream.countsAsBothFactors && 'counts as both factors',
                )}
                meta={`${upstream.linksAggregate.count} linked`}
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${upstream.name}`}
                      hint="Edit"
                      variant="ghost"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setDialog({ kind: 'open', upstream })}
                    />
                    <ConfirmButton
                      aria-label={`Remove ${upstream.name}`}
                      hint="Remove"
                      variant="ghost"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Remove ${upstream.name}?`}
                      description={`Its ${upstream.linksAggregate.count} linked accounts are unlinked. Users who only sign in through it need a password link to get back in.`}
                      confirmLabel="Remove"
                      onConfirm={() => remove.mutate(upstream.id)}
                    />
                  </>
                }
              />
            ))}
          />
          {remove.error === null ? null : (
            <Alert variant="destructive" title="Provider not removed" description={messageOf(remove.error)} />
          )}
          {dialog.kind === 'open' ? (
            <UpstreamFormDialog
              upstream={dialog.upstream}
              open
              onOpenChange={(open) => (open ? undefined : setDialog({ kind: 'closed' }))}
            />
          ) : null}
        </div>
      }
    />
  );
}

/**
 * The keys tokens are signed with, and rotating them.
 */
function KeysSection() {
  const keys = useKeys();
  const rotate = useRotateKeys();
  const rotatedAt = keys.data?.rotatedAt ?? null;

  return (
    <Section
      title="Signing keys"
      description="Tokens are signed with the current key. The previous one stays published so tokens it signed still verify."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {keys.isError ? <QueryError error={keys.error} onRetry={keys.refetch} what="the keys" /> : null}
          <SettingRow
            title="Rotate keys"
            description={
              rotatedAt === null
                ? 'They are rotated at boot every 90 days.'
                : `Last made ${formatAgo(rotatedAt)} (${formatDateTime(rotatedAt)}). They are rotated at boot every 90 days.`
            }
            actionSlot={
              <ConfirmButton
                variant="outline"
                size="sm"
                iconSlot={<RefreshCw />}
                content="Rotate now"
                disabled={rotate.isPending}
                title="Rotate the signing keys?"
                description="New tokens are signed with a new key. Tokens signed with keys older than the previous one stop verifying, so those users sign in again."
                confirmLabel="Rotate"
                onConfirm={() => rotate.mutate()}
              />
            }
          />
          <DescriptionList
            contentSlot={(keys.data?.signingKeys ?? []).map((key) => (
              <PropertyRow
                key={key.kid}
                label={key.isCurrent ? 'Current' : 'Previous'}
                value={key.kid}
                valueClassName="font-mono break-all"
                actionSlot={key.isCurrent ? <Badge variant="positive">Signing</Badge> : undefined}
              />
            ))}
          />
          {rotate.error === null ? null : (
            <Alert variant="destructive" title="Keys not rotated" description={messageOf(rotate.error)} />
          )}
        </div>
      }
    />
  );
}

/**
 * Whether clients may be sent back to plain http redirect URIs.
 */
function RedirectUrisSection() {
  const setting = useHttpRedirects();
  const save = useSetHttpRedirects();
  const current = setting.data;
  const issuerNote = current?.isIssuerHttp
    ? 'Left alone it follows the issuer, which is plain http, so it is allowed.'
    : 'Left alone it follows the issuer, which is https, so it is refused.';

  return (
    <Section
      title="Redirect URIs"
      description="Where an application may be sent back to after a sign-in or sign-out. https is always allowed, and so is plain http on localhost."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {setting.isError ? (
            <QueryError error={setting.error} onRetry={setting.refetch} what="the redirect URI setting" />
          ) : null}
          <SettingRow
            title="Allow plain http"
            description={`Lets a client be saved with an http:// redirect URI on any host. Clients saved before it was turned off keep working, and are marked in the list. ${issuerNote}`}
            actionSlot={({ titleId }) => (
              <div className="flex items-center gap-2">
                {current?.isSet ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    content="Follow the issuer"
                    disabled={save.isPending}
                    onClick={() => save.mutate(null)}
                  />
                ) : null}
                <Switch
                  aria-labelledby={titleId}
                  checked={current?.isAllowed ?? false}
                  disabled={current === undefined || save.isPending}
                  onCheckedChange={(checked) => save.mutate(checked)}
                />
              </div>
            )}
          />
          {save.error === null ? null : (
            <Alert variant="destructive" title="Setting not saved" description={messageOf(save.error)} />
          )}
        </div>
      }
    />
  );
}

/** The minimum strengths an operator can pick, by zxcvbn score, in words. */
const MIN_SCORE_OPTIONS = [
  { value: '0', label: 'Any password (length only)' },
  { value: '1', label: 'Not trivially guessable' },
  { value: '2', label: 'Somewhat hard to guess' },
  { value: '3', label: 'Hard to guess (recommended)' },
  { value: '4', label: 'Very hard to guess' },
];

/**
 * What a new password must pass: how hard it is to guess, and whether it has leaked.
 */
function PasswordRulesSection() {
  const rules = usePasswordRules();
  const save = useSetPasswordRules();
  const current = rules.data;
  const isLocked = current === undefined || save.isPending;

  return (
    <Section
      title="Passwords"
      description="Checked whenever a password is set: by an admin, with an invite or reset link, on the account page or at setup. Passwords set before keep working."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {rules.isError ? <QueryError error={rules.error} onRetry={rules.refetch} what="the password rules" /> : null}
          <SettingRow
            title="Minimum strength"
            description="How hard to guess a new password must be, as zxcvbn rates it. The forms show a meter as it is typed."
            actionSlot={({ titleId }) => (
              <Combobox
                aria-labelledby={titleId}
                className="w-60"
                options={MIN_SCORE_OPTIONS}
                value={current === undefined ? '' : String(current.minScore)}
                disabled={isLocked}
                onValueChange={(value) => save.mutate({ minScore: Number(value) })}
              />
            )}
          />
          <SettingRow
            title="Refuse breached passwords"
            description="Looks each new password up in Have I Been Pwned. Only the first 5 characters of the password’s SHA-1 hash are sent to haveibeenpwned.com. If it cannot be reached, the password is accepted."
            actionSlot={({ titleId }) => (
              <Switch
                aria-labelledby={titleId}
                checked={current?.checkBreaches ?? false}
                disabled={isLocked}
                onCheckedChange={(checked) => save.mutate({ checkBreaches: checked })}
              />
            )}
          />
          {save.error === null ? null : (
            <Alert variant="destructive" title="Setting not saved" description={messageOf(save.error)} />
          )}
        </div>
      }
    />
  );
}

/**
 * The provider's own settings: its branding, its redirect URI rule, its password rules, its keys and backups.
 */
function SettingsPage() {
  const branding = useBranding();
  return (
    <PageLayout
      title="Settings"
      description="How the provider presents itself, where it sends applications back to, what passwords it takes, how it sends email, where else users may sign in, the keys it signs with, and backups of its data."
      width="prose"
      contentClassName="gap-6"
      contentSlot={
        <>
          {/* The name field starts from the saved name, so it waits for it. */}
          {branding.isPending ? null : <BrandingSection />}
          <RedirectUrisSection />
          <PasswordRulesSection />
          <MailSection />
          <UpstreamsSection />
          <KeysSection />
          <BackupSection />
        </>
      }
    />
  );
}
