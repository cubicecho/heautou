import sharp from 'sharp';
import { PROFILE_DEFAULTS } from '../../server/core/defaults.ts';
import { createObjectStorage, ObjectStorageError } from '../../server/core/object-storage.ts';
import { PictureType, processPicture, sniffPictureType } from '../../server/core/pictures.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { createFakeS3, FAKE_S3 } from '../fake-s3.ts';

/** A wide picture, so the square crop shows. */
const WIDTH = 640;
const HEIGHT = 480;

/**
 * Makes a test image.
 *
 * @param format - What to encode it as.
 * @returns Its bytes.
 */
function image(format: 'png' | 'jpeg' | 'webp' | 'gif'): Promise<Buffer> {
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#3366cc' } })
    .toFormat(format)
    .toBuffer();
}

describe('profile picture uploads', () => {
  it('reads the type from the bytes', async () => {
    expect(sniffPictureType(await image('png'))).toBe(PictureType.Png);
    expect(sniffPictureType(await image('jpeg'))).toBe(PictureType.Jpeg);
    expect(sniffPictureType(await image('webp'))).toBe(PictureType.Webp);
    expect(sniffPictureType(await image('gif'))).toBeNull();
    expect(sniffPictureType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it.each([
    ['png', PictureType.Png],
    ['jpeg', PictureType.Jpeg],
    ['webp', PictureType.Webp],
  ] as const)('scales a %s to a square PNG', async (format, type) => {
    const picture = await processPicture(await image(format), type);
    const { format: stored, width, height } = await sharp(picture).metadata();
    expect({ stored, width, height }).toEqual({
      stored: 'png',
      width: PROFILE_DEFAULTS.pictureSidePx,
      height: PROFILE_DEFAULTS.pictureSidePx,
    });
  });

  it('drops the metadata', async () => {
    const tagged = await sharp(await image('jpeg'))
      .withExif({ IFD0: { Copyright: 'secret place' } })
      .jpeg()
      .toBuffer();
    expect(tagged.includes('secret place')).toBe(true);
    const picture = await processPicture(tagged, PictureType.Jpeg);
    expect(picture.includes('secret place')).toBe(false);
    expect((await sharp(picture).metadata()).exif).toBeUndefined();
  });

  it('refuses a type it does not take, whatever it is called', async () => {
    await expect(processPicture(await image('gif'), 'image/gif')).rejects.toThrow('PNG, JPEG or WebP');
    await expect(processPicture(await image('gif'), PictureType.Png)).rejects.toThrow('PNG, JPEG or WebP');
    await expect(processPicture(Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toThrow('PNG, JPEG or WebP');
  });

  it('refuses bytes that are not what they were sent as', async () => {
    await expect(processPicture(await image('jpeg'), PictureType.Png)).rejects.toThrow('PNG, JPEG or WebP');
  });

  it('refuses a PNG header with no image behind it', async () => {
    const fake = Buffer.concat([(await image('png')).subarray(0, 8), Buffer.from('<script>alert(1)</script>')]);
    expect(sniffPictureType(fake)).toBe(PictureType.Png);
    await expect(processPicture(fake, PictureType.Png)).rejects.toThrow('not a readable image');
  });

  it('refuses a file over the size limit before decoding it', async () => {
    const big = Buffer.concat([await image('png'), Buffer.alloc(PROFILE_DEFAULTS.maxPictureBytes)]);
    await expect(processPicture(big, PictureType.Png)).rejects.toThrow('MB');
  });
});

describe('the S3 client', () => {
  it('signs path-style requests and round-trips an object', async () => {
    const s3 = createFakeS3();
    await s3.storage.put('pictures/a/1', Buffer.from('bytes'), 'image/png');
    expect(s3.requests[0]).toMatchObject({ method: 'PUT', path: '/heautou/pictures/a/1' });
    expect(s3.requests[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[^,]*x-amz-content-sha256/,
    );
    const got = await s3.storage.get('pictures/a/1');
    expect(got?.contentType).toBe('image/png');
    expect(Buffer.from(await new Response(got?.body).arrayBuffer()).toString()).toBe('bytes');
    await s3.storage.remove('pictures/a/1');
    expect(await s3.storage.get('pictures/a/1')).toBeNull();
    // Removing what is not there is not an error.
    await s3.storage.remove('pictures/a/1');
  });

  it('says what is wrong with the bucket', async () => {
    const s3 = createFakeS3();
    await expect(s3.storage.check()).resolves.toBeUndefined();
    const wrongKey = createObjectStorage({ ...FAKE_S3, accessKeyId: 'nobody' }, s3.fetch);
    await expect(wrongKey.check()).rejects.toThrow('refused the access key');
    const noBucket = createObjectStorage(FAKE_S3, async () => new Response(null, { status: HttpStatus.NotFound }));
    await expect(noBucket.check()).rejects.toThrow('no such bucket');
    s3.setDown(true);
    const failure = await s3.storage.check().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ObjectStorageError);
    expect(failure).toMatchObject({ status: null, message: expect.stringContaining('could not be reached') });
  });
});
