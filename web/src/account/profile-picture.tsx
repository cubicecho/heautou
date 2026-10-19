import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Spinner } from '@/components/ui/spinner';
import { useAccountPicture, useRemoveAccountPicture, useSetAccountPicture } from '@/core/pictures';
import { PictureSetting } from '@/pictures/picture-setting';

/**
 * The signed-in user's profile picture, which apps get as the `picture` claim.
 *
 * @returns The section.
 */
export function ProfilePictureSection() {
  const picture = useAccountPicture();
  const set = useSetAccountPicture();
  const remove = useRemoveAccountPicture();
  const data = picture.data;

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
