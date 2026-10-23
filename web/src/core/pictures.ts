import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ProfilePicturesDocument } from '@/__generated__/graphql';
import { KEYS } from '@/core/admin';
import { request } from '@/core/gql';
import { jsonReply, postJson } from '@/core/json-reply';

/** The image types the server takes for a picture. It checks them again by their bytes. */
export const PICTURE_TYPES = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

const ACCOUNT_PICTURE = '/api/account/picture';
const ACCOUNT_PICTURE_KEY = ['account', 'picture'] as const;
const PICTURES_KEY = ['profilePictures'] as const;

const accountPictureSchema = z.object({ isEnabled: z.boolean(), maxBytes: z.number(), url: z.string().nullable() });
const pictureSchema = z.object({ url: z.string().nullable() });

/** A picture picked to upload: the file as the browser holds it, and its type. */
export interface PictureUpload {
  blob: Blob;
  type: string;
}

/**
 * Sends a picture as the request's body, with its own type.
 *
 * @param url - The route.
 * @param picture - The picture.
 * @returns The picture's new URL.
 */
async function postPicture(url: string, picture: PictureUpload) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': picture.type }, body: picture.blob });
  return jsonReply(response, pictureSchema);
}

/**
 * Names the routes for a user's picture.
 *
 * @param id - The user.
 * @returns The set route.
 */
function userPicturePath(id: string): string {
  return `/admin/users/${encodeURIComponent(id)}/picture`;
}

/**
 * Reads whether pictures are on, and the signed-in user's.
 *
 * @returns The query.
 */
export function useAccountPicture() {
  return useQuery({
    queryKey: ACCOUNT_PICTURE_KEY,
    queryFn: async () => jsonReply(await fetch(ACCOUNT_PICTURE), accountPictureSchema),
    retry: false,
  });
}

/**
 * Sets the signed-in user's picture.
 *
 * @returns The mutation.
 */
export function useSetAccountPicture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (picture: PictureUpload) => postPicture(ACCOUNT_PICTURE, picture),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNT_PICTURE_KEY }),
  });
}

/**
 * Removes the signed-in user's picture.
 *
 * @returns The mutation.
 */
export function useRemoveAccountPicture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => jsonReply(await postJson(`${ACCOUNT_PICTURE}/remove`, {}), pictureSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ACCOUNT_PICTURE_KEY }),
  });
}

/**
 * Reads whether pictures are on, for the users page.
 *
 * @returns The query.
 */
export function useProfilePictures() {
  return useQuery({
    queryKey: PICTURES_KEY,
    queryFn: async () => (await request(ProfilePicturesDocument)).profilePictures,
  });
}

/**
 * Sets a user's picture, as an admin.
 *
 * @returns The mutation.
 */
export function useSetUserPicture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, picture }: { id: string; picture: PictureUpload }) => postPicture(userPicturePath(id), picture),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEYS.users }),
  });
}

/**
 * Removes a user's picture, as an admin.
 *
 * @returns The mutation.
 */
export function useRemoveUserPicture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => jsonReply(await postJson(`${userPicturePath(id)}/remove`, {}), pictureSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEYS.users }),
  });
}
