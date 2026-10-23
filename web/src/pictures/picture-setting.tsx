import { useState } from 'react';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FilePickerButton } from '@/components/ui/file-picker';
import type { PickedFile } from '@/components/ui/file-picker-base';
import { Trash2 } from '@/components/ui/icons';
import { ImageUp } from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import { PICTURE_TYPES, type PictureUpload } from '@/core/pictures';
import { formatBytes } from '@/lib/format';

interface PictureSettingProps {
  /** Whose picture, as the alt text and the buttons name them: "Your" or "ada's". */
  owner: string;
  /** Whether the server has a bucket to keep pictures in. */
  isEnabled: boolean;
  /** The largest upload, in bytes. */
  maxBytes: number;
  /** The current picture, or null for none. */
  url: string | null;
  /** Whether an upload or a removal is under way. */
  isPending: boolean;
  /** Why the last upload or removal failed, or null. */
  error: Error | null;
  /** Uploads a picked picture. */
  onUpload: (picture: PictureUpload) => void;
  /** Removes the picture. */
  onRemove: () => void;
}

/**
 * A user's profile picture: the picture, a button to upload or replace it and one to remove it. Apps get it as the
 * `picture` claim. When the server has no bucket it says pictures are off instead.
 *
 * @param props - The picture, the limits and what to do with a pick.
 * @returns The row, and an alert when something failed.
 */
export function PictureSetting({
  owner,
  isEnabled,
  maxBytes,
  url,
  isPending,
  error,
  onUpload,
  onRemove,
}: PictureSettingProps) {
  const [tooBig, setTooBig] = useState<string | null>(null);

  const pick = ([file]: PickedFile[]) => {
    if (file?.blob === undefined) {
      return;
    }
    if (file.size > maxBytes) {
      setTooBig(`${file.name} is ${formatBytes(file.size)}. Use an image under ${formatBytes(maxBytes)}.`);
      return;
    }
    setTooBig(null);
    onUpload({ blob: file.blob, type: file.type });
  };

  if (isEnabled === false) {
    return (
      <SettingRow
        title="Profile picture"
        description="Pictures are off: the server has no S3 bucket to keep them in. The operator sets S3_ENDPOINT and the rest to turn them on."
      />
    );
  }
  return (
    <div className="grid gap-2">
      <SettingRow
        title="Profile picture"
        description={`PNG, JPEG or WebP, up to ${formatBytes(maxBytes)}. It is cropped to a square, and apps that show an avatar get it.`}
        actionSlot={
          <div className="flex items-center gap-2">
            {url !== null && (
              <>
                <img src={url} alt={`${owner} avatar`} className="size-10 rounded-full object-cover" />
                <Button
                  aria-label={`Remove ${owner.toLowerCase()} profile picture`}
                  hint="Remove picture"
                  variant="outline"
                  size="icon-sm"
                  iconSlot={<Trash2 />}
                  disabled={isPending}
                  onClick={onRemove}
                />
              </>
            )}
            <FilePickerButton
              label={url === null ? 'Upload picture' : 'Replace picture'}
              accept={PICTURE_TYPES}
              read="none"
              variant="outline"
              size="sm"
              iconSlot={<ImageUp />}
              onPickMany={pick}
            />
          </div>
        }
      />
      {tooBig !== null && <Alert variant="destructive" title="Picture not used" description={tooBig} />}
      {error !== null && <Alert variant="destructive" title="Picture not changed" description={messageOf(error)} />}
    </div>
  );
}
