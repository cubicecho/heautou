import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
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
import { useBranding, useKeys, useRotateKeys, useSetBrandingLogo, useSetBrandingName } from '@/core/admin';
import { ImageUp } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { formatAgo, formatBytes, formatDateTime } from '@/lib/format';

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
 * The provider's own settings: its branding and its keys.
 */
function SettingsPage() {
  const branding = useBranding();
  return (
    <PageLayout
      title="Settings"
      description="How the provider presents itself, and the keys it signs with."
      width="prose"
      contentClassName="gap-6"
      contentSlot={
        <>
          {/* The name field starts from the saved name, so it waits for it. */}
          {branding.isPending ? null : <BrandingSection />}
          <KeysSection />
        </>
      }
    />
  );
}
