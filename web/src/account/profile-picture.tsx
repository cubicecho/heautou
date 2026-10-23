import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Spinner } from '@/components/ui/spinner';
import { useAccountPicture, useRemoveAccountPicture, useSetAccountPicture } from '@/core/pictures';
import { PictureSetting } from '@/pictures/picture-setting';

/**
 * The signed-in user's profile picture, which apps get as the `picture` claim. While pictures are off it is shown
 * only to an admin, who can turn them on; anyone else has nothing to do with it.
 *
 * @param props - Who is looking.
 * @param props.isAdmin - Whether the signed-in user is an admin.
 * @returns The section, or nothing.
 */
export function ProfilePictureSection({ isAdmin }: { isAdmin: boolean }) {
  const picture = useAccountPicture();
  const set = useSetAccountPicture();
  const remove = useRemoveAccountPicture();
  const data = picture.data;
  const isHidden = data?.isEnabled === false && isAdmin === false;
  if (isHidden) {
    return null;
  }

  return (
    <Section
      title="Picture"
      contentSlot={
        picture.isError ? (
          <QueryError error={picture.error} onRetry={picture.refetch} what="your picture" />
        ) : data === undefined ? (
          <Spinner />
        ) : (
          <PictureSetting
            owner="Your"
            isEnabled={data.isEnabled}
            maxBytes={data.maxBytes}
            url={data.url}
            isPending={set.isPending || remove.isPending}
            error={set.error ?? remove.error}
            onUpload={(upload) => {
              remove.reset();
              set.mutate(upload);
            }}
            onRemove={() => {
              set.reset();
              remove.mutate();
            }}
          />
        )
      }
    />
  );
}
