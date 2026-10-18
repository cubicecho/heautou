import type { UserFieldsFragment } from '@/__generated__/graphql';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { useUsers } from '@/core/admin';
import { useRemoveUserPicture, useSetUserPicture } from '@/core/pictures';
import { PictureSetting } from '@/pictures/picture-setting';

interface PictureDialogProps {
  user: UserFieldsFragment;
  /** Whether the server has a bucket to keep pictures in. */
  isEnabled: boolean;
  /** The largest upload, in bytes. */
  maxBytes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sets or removes a user's profile picture, as an admin.
 *
 * @param props - The user, the limits and the dialog's open state.
 * @returns The dialog.
 */
export function PictureDialog({ user, isEnabled, maxBytes, open, onOpenChange }: PictureDialogProps) {
  const set = useSetUserPicture();
  const remove = useRemoveUserPicture();
  // The list is read again after a change, so the dialog follows it rather than the row it opened from.
  const current = useUsers().data?.find((each) => each.id === user.id) ?? user;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${user.username}'s picture`}
      description="Apps that show an avatar get it as the picture claim."
      contentSlot={
        <PictureSetting
          owner={`${user.username}'s`}
          isEnabled={isEnabled}
          maxBytes={maxBytes}
          url={current.pictureUrl ?? null}
          isPending={set.isPending || remove.isPending}
          error={set.error ?? remove.error}
          onUpload={(picture) => {
            remove.reset();
            set.mutate({ id: user.id, picture });
          }}
          onRemove={() => {
            set.reset();
            remove.mutate(user.id);
          }}
        />
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Close" />}
    />
  );
}
