// A small S3 client: GET, PUT, DELETE and HEAD on one bucket, addressed path-style, signed with SigV4 by aws4fetch.
import { createHash } from 'node:crypto';
import { AwsV4Signer } from 'aws4fetch';
import type { S3Config } from './config.ts';
import { OBJECT_STORAGE_DEFAULTS } from './defaults.ts';
import { errorMessage } from './errors.ts';
import { HttpStatus } from './wire.ts';

/** The header S3 reads the payload's SHA-256 from. Sent on every request, so the body is signed too. */
const CONTENT_SHA256 = 'x-amz-content-sha256';

/** An object as the bucket gives it back. */
export interface StoredObject {
  /** The bytes, as they arrive. Read it or cancel it. */
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** Its size in bytes, when the store said. */
  contentLength: number | null;
}

/** The bucket could not be reached, or refused a request. The message says which, for the operator. */
export class ObjectStorageError extends Error {
  /** The status the store answered, or null when it could not be reached. */
  readonly status: number | null;

  /**
   * Makes the error.
   *
   * @param message - What went wrong, for a person.
   * @param status - The store's status, or null when there was no answer.
   */
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ObjectStorageError';
    this.status = status;
  }
}

/** One bucket of an S3-compatible store. */
export interface ObjectStorage {
  /** The store and bucket, such as `http://rustfs:9000/heautou`, for log lines. */
  label: string;
  /**
   * Writes an object, replacing one of the same key.
   *
   * @param key - Its key in the bucket.
   * @param body - Its bytes.
   * @param contentType - Its media type.
   * @throws ObjectStorageError when the store can't be reached or refuses it.
   */
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /**
   * Reads an object.
   *
   * @param key - Its key in the bucket.
   * @returns The object, or null when there is none.
   * @throws ObjectStorageError when the store can't be reached or refuses it.
   */
  get: (key: string) => Promise<StoredObject | null>;
  /**
   * Deletes an object. One that is not there is not an error.
   *
   * @param key - Its key in the bucket.
   * @throws ObjectStorageError when the store can't be reached or refuses it.
   */
  remove: (key: string) => Promise<void>;
  /**
   * Checks the bucket is there and the keys may use it.
   *
   * @throws ObjectStorageError saying what is wrong.
   */
  check: () => Promise<void>;
}

/**
 * Hashes a request's payload as SigV4 wants it.
 *
 * @param body - The payload, or null for none.
 * @returns The SHA-256, in hex.
 */
function payloadHash(body: Buffer | null): string {
  return createHash('sha256')
    .update(body ?? Buffer.alloc(0))
    .digest('hex');
}

/**
 * Says what a refusal from the store means.
 *
 * @param label - The store and bucket.
 * @param status - Its answer.
 * @returns A sentence for the operator.
 */
function refusalMessage(label: string, status: number): string {
  if (status === HttpStatus.NotFound) {
    return `${label}: there is no such bucket. Make it, or fix S3_BUCKET.`;
  }
  const isDenied = status === HttpStatus.Forbidden || status === HttpStatus.Unauthorized;
  if (isDenied) {
    return `${label} refused the access key (${status}). Check S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_REGION, and that the key may use the bucket.`;
  }
  return `${label} answered ${status}.`;
}

/**
 * Opens one bucket of an S3-compatible store, such as RustFS, MinIO or Garage. Requests go to
 * `<endpoint>/<bucket>/<key>` (path-style, which those need) and are signed with SigV4.
 *
 * @param config - The endpoint, bucket, region and keys.
 * @param [send] - Makes the requests. Unset, the global `fetch`; tests pass a fake store.
 * @returns The bucket.
 */
export function createObjectStorage(config: S3Config, send: typeof globalThis.fetch = globalThis.fetch): ObjectStorage {
  const bucketUrl = `${config.endpoint}/${encodeURIComponent(config.bucket)}`;
  const label = bucketUrl;
  const objectUrl = (key: string): string => `${bucketUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;

  /**
   * Signs and sends one request.
   *
   * @param method - The HTTP method.
   * @param url - The bucket's or an object's URL.
   * @param [body] - The payload.
   * @param [headers] - More headers to sign.
   * @returns The store's answer, whatever its status.
   * @throws ObjectStorageError when the store can't be reached in `OBJECT_STORAGE_DEFAULTS.timeoutMs`.
   */
  const request = async (
    method: string,
    url: string,
    body: Buffer | null = null,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const signer = new AwsV4Signer({
      method,
      url,
      headers: { ...headers, [CONTENT_SHA256]: payloadHash(body) },
      body: body === null ? null : new Uint8Array(body),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
    });
    const signed = await signer.sign();
    try {
      return await send(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body ?? null,
        signal: AbortSignal.timeout(OBJECT_STORAGE_DEFAULTS.timeoutMs),
      });
    } catch (error) {
      // fetch says only "fetch failed"; its cause names the refused connection or the unknown host.
      const cause = error instanceof Error && error.cause !== undefined ? ` (${errorMessage(error.cause)})` : '';
      throw new ObjectStorageError(`${label} could not be reached: ${errorMessage(error)}${cause}`, null);
    }
  };

  /**
   * Throws for an answer that is not a success, after reading it so the connection is freed.
   *
   * @param response - The store's answer.
   * @throws ObjectStorageError for a status outside 2xx.
   */
  const expectOk = async (response: Response): Promise<void> => {
    if (response.ok) {
      return;
    }
    await response.body?.cancel();
    throw new ObjectStorageError(refusalMessage(label, response.status), response.status);
  };

  return {
    label,
    put: async (key, body, contentType) => {
      const response = await request('PUT', objectUrl(key), body, { 'content-type': contentType });
      await expectOk(response);
      await response.body?.cancel();
    },
    get: async (key) => {
      const response = await request('GET', objectUrl(key));
      if (response.status === HttpStatus.NotFound) {
        await response.body?.cancel();
        return null;
      }
      await expectOk(response);
      const { body } = response;
      if (body === null) {
        throw new ObjectStorageError(`${label} sent an object with no body.`, response.status);
      }
      const length = Number(response.headers.get('content-length'));
      return {
        body,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        contentLength: Number.isFinite(length) && length > 0 ? length : null,
      };
    },
    remove: async (key) => {
      const response = await request('DELETE', objectUrl(key));
      if (response.status === HttpStatus.NotFound) {
        await response.body?.cancel();
        return;
      }
      await expectOk(response);
      await response.body?.cancel();
    },
    check: async () => {
      const response = await request('HEAD', bucketUrl);
      await expectOk(response);
      await response.body?.cancel();
    },
  };
}
