import { BRANDING_DEFAULTS } from '@server/core/defaults.ts';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { BackupSection } from '@/backup/backup-section';
import { InputField, useAppForm } from '@/components/app-form';
import { Combobox } from '@/components/combobox';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
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
import { RefreshCw, Trash2 } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ImageUp } from '@/core/app-icons';
import { useBranding, useSetBrandingLogo, useSetBrandingName } from '@/core/branding';
import { useKeys, useRotateKeys } from '@/core/keys';
import { messageOf } from '@/core/lists';
import { useHttpRedirects, usePasswordRules, useSetHttpRedirects, useSetPasswordRules } from '@/core/settings';
import { formatAgo, formatBytes, formatDateTime } from '@/lib/format';
import type { SlotNode } from '@/lib/utils';
import { MailSection } from '@/mail/mail-section';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  validateSearch: (search) => settingsSearchSchema.parse(search),
});

/** The image types the server takes for a logo. */
const LOGO_TYPES = 'image/png,image/jpeg,image/webp,image/svg+xml';
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
    if (file.size > BRANDING_DEFAULTS.maxLogoBytes) {
      setTooBig(
        `${file.name} is ${formatBytes(file.size)}. Use an image under ${formatBytes(BRANDING_DEFAULTS.maxLogoBytes)}.`,
      );
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

/** The parts of the settings page, each a tab, in the order the tabs show them. */
const SETTINGS_SECTIONS = ['sign-in', 'email', 'branding', 'maintenance'] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** What each tab is called. */
const SECTION_LABELS = {
  'sign-in': 'Sign-in',
  email: 'Email',
  branding: 'Branding',
  maintenance: 'Keys and backup',
} as const satisfies Record<SettingsSection, string>;

/** The tab in the URL, so a link can open one. Left out, or one the page does not have, is the first. */
const settingsSearchSchema = z.object({ section: z.enum(SETTINGS_SECTIONS).optional().catch(undefined) });

/**
 * The branding tab, which waits for the saved name since the name field starts from it.
 */
function BrandingTab() {
  const branding = useBranding();
  return branding.isPending ? null : <BrandingSection />;
}

/** What each tab holds. */
const SECTION_CONTENT = {
  'sign-in': () => (
    <>
      <PasswordRulesSection />
      <RedirectUrisSection />
    </>
  ),
  email: () => <MailSection />,
  branding: () => <BrandingTab />,
  maintenance: () => (
    <>
      <KeysSection />
      <BackupSection />
    </>
  ),
} as const satisfies Record<SettingsSection, () => SlotNode>;

/**
 * The provider's own settings, in tabs: sign-in (password rules and redirect URIs), email, branding, and keys and
 * backups. Sign-in providers are on the Users page.
 */
function SettingsPage() {
  const { section = 'sign-in' } = Route.useSearch();
  const Content = SECTION_CONTENT[section];
  return (
    <Tabs value={section} className="h-full">
      <PageLayout
        title="Settings"
        description="How this provider checks passwords and redirect URIs, sends email, presents itself, signs tokens and backs up its data."
        width="prose"
        headerContentSlot={
          <TabsList aria-label="Settings">
            {SETTINGS_SECTIONS.map((each) => (
              <TabsTrigger key={each} value={each} linkSlot={<Link to="/settings" search={{ section: each }} />}>
                {SECTION_LABELS[each]}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        contentClassName="gap-6"
        contentSlot={
          <TabsContent value={section} className="flex flex-col gap-6">
            <Content />
          </TabsContent>
        }
      />
    </Tabs>
  );
}
