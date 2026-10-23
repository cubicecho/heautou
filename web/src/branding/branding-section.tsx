import { BRANDING_DEFAULTS } from '@server/core/defaults.ts';
import { useState } from 'react';
import { InputField, useAppForm } from '@/components/app-form';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FilePickerButton } from '@/components/ui/file-picker';
import type { PickedFile } from '@/components/ui/file-picker-base';
import { FormElement } from '@/components/ui/form-element';
import { Trash2 } from '@/components/ui/icons';
import { ImageUp } from '@/core/app-icons';
import { useBranding, useSetBrandingLogo, useSetBrandingName } from '@/core/branding';
import { messageOf } from '@/core/errors';
import { formatBytes } from '@/lib/format';

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
export function BrandingSection() {
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
          {branding.isError && <QueryError error={branding.error} onRetry={branding.refetch} what="the branding" />}
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
                {logoUrl !== null && (
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
          {tooBig !== null && <Alert variant="destructive" title="Logo not used" description={tooBig} />}
          {failure !== null && (
            <Alert variant="destructive" title="Branding not saved" description={messageOf(failure)} />
          )}
        </div>
      }
    />
  );
}
