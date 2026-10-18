// Profile pictures: checked by their bytes, scaled to a square PNG, kept in the bucket, served at /users/:id/picture.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { PublicUser, UserStore } from '../store/users.ts';
import { PROFILE_DEFAULTS } from './defaults.ts';
import { badInput, errorMessage, notFound } from './errors.ts';
import type { ObjectStorage, StoredObject } from './object-storage.ts';
import { BYTES_PER_MB } from './wire.ts';

/** The image types an upload may be. */
export const PictureType = { Png: 'image/png', Jpeg: 'image/jpeg', Webp: 'image/webp' } as const;
export type PictureType = (typeof PictureType)[keyof typeof PictureType];

/** What every picture is stored and served as: every app can show it, and it keeps transparency. */
export const STORED_PICTURE_TYPE = PictureType.Png;

/** The public path of a user's picture. The claim is this under the issuer's base, with `?v=`. */
export const PICTURE_ROUTE = '/users/:id/picture';

/** What an upload over `PROFILE_DEFAULTS.maxPictureBytes` is told. */
export const PICTURE_TOO_LARGE = `picture: use an image under ${PROFILE_DEFAULTS.maxPictureBytes / BYTES_PER_MB} MB.`;
/** How many hex characters of the picture's SHA-256 make its version. */
const VERSION_LENGTH = 16;
/** The PNG signature. */
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** Every JPEG starts with a start-of-image marker and then another marker. */
const JPEG_SIGNATURE = Buffer.from('ffd8ff', 'hex');
/** A WebP file is a RIFF container: `RIFF`, four bytes of size, then `WEBP`. */
const RIFF = Buffer.from('RIFF', 'ascii');
const WEBP = Buffer.from('WEBP', 'ascii');
const WEBP_FORM_OFFSET = 8;
/** What sharp calls each type it may decode. */
const SHARP_FORMAT: Record<PictureType, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
const TYPE_MESSAGE = 'picture: use a PNG, JPEG or WebP image.';

/**
 * Reads an image's type from its first bytes, whatever it was called.
 *
 * @param bytes - The file.
 * @returns Its type, or null when it is none of PNG, JPEG and WebP.
 */
export function sniffPictureType(bytes: Buffer): PictureType | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return PictureType.Png;
  }
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return PictureType.Jpeg;
  }
  const isRiff = bytes.subarray(0, RIFF.length).equals(RIFF);
  const isWebp = bytes.subarray(WEBP_FORM_OFFSET, WEBP_FORM_OFFSET + WEBP.length).equals(WEBP);
  return isRiff && isWebp ? PictureType.Webp : null;
}

/**
 * Checks an upload and makes the picture that is kept of it: the middle square, scaled to
 * `PROFILE_DEFAULTS.pictureSidePx`, turned the way its EXIF says, and encoded again as PNG, which drops every bit of
 * metadata (location, camera, comments) and anything hidden after the image.
 *
 * @param bytes - The upload.
 * @param declaredType - The `Content-Type` it was sent with.
 * @returns The PNG.
 * @throws BAD_USER_INPUT for a file over `PROFILE_DEFAULTS.maxPictureBytes`, a type other than PNG, JPEG or WebP,
 * bytes that don't match the declared type, or bytes that don't decode.
 */
export async function processPicture(bytes: Buffer, declaredType: string): Promise<Buffer> {
  const { maxPictureBytes, maxInputPixels, pictureSidePx } = PROFILE_DEFAULTS;
  if (bytes.length > maxPictureBytes) {
    throw badInput(PICTURE_TOO_LARGE);
  }
  const sniffed = sniffPictureType(bytes);
  if (sniffed === null || sniffed !== declaredType) {
    throw badInput(TYPE_MESSAGE);
  }
  try {
    const image = sharp(bytes, { limitInputPixels: maxInputPixels, failOn: 'error' });
    const { format } = await image.metadata();
    if (format !== SHARP_FORMAT[sniffed]) {
      throw new Error(`decoded as ${format}`);
    }
    return await image
      .rotate()
      .resize(pictureSidePx, pictureSidePx, { fit: 'cover', position: 'attention' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (error) {
    console.warn(`[pictures] An upload did not decode: ${errorMessage(error)}`);
    throw badInput('picture: that file is not a readable image.');
  }
}

/**
 * Names a picture's version: a hash of its bytes, so a new picture gets a new URL and caches fetch it.
 *
 * @param picture - The stored picture.
 * @returns The version.
 */
function versionOf(picture: Buffer): string {
  return createHash('sha256').update(picture).digest('hex').slice(0, VERSION_LENGTH);
}

/** A user as far as their picture goes. */
type PictureOwner = Pick<PublicUser, 'id' | 'pictureVersion'>;

/**
 * Names one version of a user's picture in the bucket. Each version is its own object, so a picture being replaced
 * never serves the new bytes under the old version's ETag.
 *
 * @param userId - The user.
 * @param version - The picture's version.
 * @returns The key.
 */
function keyOf(userId: string, version: string): string {
  return `${PROFILE_DEFAULTS.keyPrefix}${userId}/${version}`;
}

/** Each user's profile picture, kept in the bucket; on only when S3 is configured. */
export interface ProfilePictures {
  /** Whether a bucket is configured. When it is not, pictures can't be set and none is released. */
  isEnabled: boolean;
  /**
   * The picture's URL, as the `picture` claim and the web app use it.
   *
   * @param user - The user.
   * @returns `<base>/users/<id>/picture?v=<version>`, or null when they have none or pictures are off.
   */
  urlOf: (user: PictureOwner) => string | null;
  /**
   * Checks an upload, scales it, stores it, records it on the user and deletes the picture it replaces.
   *
   * @param userId - Whose picture.
   * @param bytes - The upload.
   * @param declaredType - Its `Content-Type`.
   * @returns The user.
   * @throws BAD_USER_INPUT when pictures are off or the upload is refused, NOT_FOUND for an unknown user, and
   * ObjectStorageError when the bucket fails.
   */
  set: (userId: string, bytes: Buffer, declaredType: string) => Promise<PublicUser>;
  /**
   * Takes a user's picture away, and deletes it from the bucket. A bucket that fails is logged: the picture is not
   * served once the user has none.
   *
   * @param userId - Whose picture.
   * @returns The user.
   * @throws BAD_USER_INPUT when pictures are off, NOT_FOUND for an unknown user.
   */
  remove: (userId: string) => Promise<PublicUser>;
  /**
   * Deletes the picture of a user who was deleted. A bucket that fails is logged, never thrown.
   *
   * @param user - The deleted user.
   */
  discard: (user: PictureOwner) => Promise<void>;
  /**
   * Reads a user's current picture from the bucket.
   *
   * @param user - Whose picture.
   * @returns The picture, or null when they have none or pictures are off.
   * @throws ObjectStorageError when the bucket fails.
   */
  open: (user: PictureOwner) => Promise<StoredObject | null>;
}

/** What the pictures are kept with. */
export interface ProfilePictureDeps {
  /** The bucket, or null when S3 is not configured. */
  storage: ObjectStorage | null;
  users: UserStore;
  /** The issuer without `/oidc`, which picture URLs start with. */
  base: string;
}

/**
 * Builds the profile pictures over the bucket.
 *
 * @param deps - The bucket, the users and the public base URL.
 * @returns The pictures.
 */
export function createProfilePictures(deps: ProfilePictureDeps): ProfilePictures {
  const { storage, users, base } = deps;
  /**
   * Hands back the bucket, refusing when there is none.
   *
   * @returns The bucket.
   * @throws BAD_USER_INPUT when S3 is not configured.
   */
  const bucket = (): ObjectStorage => {
    if (storage === null) {
      throw badInput('Profile pictures are off: the server has no S3 bucket configured.');
    }
    return storage;
  };
  /**
   * Finds a user, refusing an unknown one.
   *
   * @param userId - The user.
   * @returns The user.
   * @throws NOT_FOUND when there is none.
   */
  const load = (userId: string): PublicUser => {
    const user = users.find(userId);
    if (user === null) {
      throw notFound(`No user has the ID "${userId}".`);
    }
    return user;
  };
  /**
   * Deletes one version of a picture, logging a bucket that fails rather than throwing.
   *
   * @param userId - Whose picture.
   * @param version - Which version, or null for none.
   */
  const deleteQuietly = async (userId: string, version: string | null): Promise<void> => {
    if (storage === null || version === null) {
      return;
    }
    try {
      await storage.remove(keyOf(userId, version));
    } catch (error) {
      console.error(`[pictures] A picture of user ${userId} is still in the bucket: ${errorMessage(error)}`);
    }
  };
  return {
    isEnabled: storage !== null,
    urlOf: (user) => {
      const hasPicture = storage !== null && user.pictureVersion !== null;
      return hasPicture
        ? `${base}${PICTURE_ROUTE.replace(':id', encodeURIComponent(user.id))}?v=${user.pictureVersion}`
        : null;
    },
    set: async (userId, bytes, declaredType) => {
      const store = bucket();
      const before = load(userId).pictureVersion;
      const picture = await processPicture(bytes, declaredType);
      const version = versionOf(picture);
      await store.put(keyOf(userId, version), picture, STORED_PICTURE_TYPE);
      const user = users.setPictureVersion(userId, version);
      if (before !== version) {
        await deleteQuietly(userId, before);
      }
      return user;
    },
    remove: async (userId) => {
      bucket();
      const before = load(userId).pictureVersion;
      const user = users.setPictureVersion(userId, null);
      await deleteQuietly(userId, before);
      return user;
    },
    discard: (user) => deleteQuietly(user.id, user.pictureVersion),
    open: async (user) =>
      storage === null || user.pictureVersion === null ? null : storage.get(keyOf(user.id, user.pictureVersion)),
  };
}
