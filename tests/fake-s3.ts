import { createHash } from 'node:crypto';
import type { S3Config } from '../server/core/config.ts';
import { createObjectStorage, type ObjectStorage } from '../server/core/object-storage.ts';
import { HttpStatus } from '../server/core/wire.ts';

/** The bucket the fake store holds. */
export const FAKE_S3: S3Config = Object.freeze({
  endpoint: 'http://s3.test:9000',
  bucket: 'heautou',
  region: 'us-east-1',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
});

/** One request the fake store was sent. */
export interface FakeS3Request {
  method: string;
  path: string;
  headers: Headers;
}

/** An S3-compatible store in memory, answering path-style requests to `FAKE_S3`'s one bucket. */
export interface FakeS3 {
  /** Objects by key, with their media type. */
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Every request, in order. */
  requests: FakeS3Request[];
  /**
   * Makes every request fail as an unreachable host does, or answer again.
   *
   * @param isDown - Whether the store is down.
   */
  setDown: (isDown: boolean) => void;
  /** The fetch to hand `createObjectStorage`. */
  fetch: typeof globalThis.fetch;
  /** A bucket on this store, through the real client. */
  storage: ObjectStorage;
}

/**
 * Hashes a payload as the client signs it.
 *
 * @param body - The payload.
 * @returns The SHA-256, in hex.
 */
function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Makes an empty fake store. It refuses unsigned requests and payloads whose hash doesn't match the signed one, as
 * S3 does, and keys outside its bucket with 404.
 *
 * @returns The store.
 */
export function createFakeS3(): FakeS3 {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: FakeS3Request[] = [];
  const bucketPath = `/${FAKE_S3.bucket}`;
  let down = false;
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    if (down) {
      throw new TypeError('fetch failed');
    }
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({ method, path: url.pathname, headers });
    const authorization = headers.get('authorization') ?? '';
    const isSigned = authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${FAKE_S3.accessKeyId}/`);
    if (url.origin !== FAKE_S3.endpoint || isSigned === false) {
      return new Response('AccessDenied', { status: HttpStatus.Forbidden });
    }
    const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    if (headers.get('x-amz-content-sha256') !== sha256(body)) {
      return new Response('XAmzContentSHA256Mismatch', { status: HttpStatus.BadRequest });
    }
    if (url.pathname === bucketPath && method === 'HEAD') {
      return new Response(null, { status: HttpStatus.Ok });
    }
    const isInBucket = url.pathname.startsWith(`${bucketPath}/`);
    if (isInBucket === false) {
      return new Response('NoSuchBucket', { status: HttpStatus.NotFound });
    }
    const key = decodeURIComponent(url.pathname.slice(bucketPath.length + 1));
    if (method === 'PUT') {
      objects.set(key, { body, contentType: headers.get('content-type') ?? 'application/octet-stream' });
      return new Response(null, { status: HttpStatus.Ok });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: HttpStatus.NoContent });
    }
    const found = objects.get(key);
    if (found === undefined) {
      return new Response('NoSuchKey', { status: HttpStatus.NotFound });
    }
    return new Response(new Uint8Array(found.body), {
      status: HttpStatus.Ok,
      headers: { 'content-type': found.contentType, 'content-length': String(found.body.length) },
    });
  };
  return {
    objects,
    requests,
    setDown: (isDown) => {
      down = isDown;
    },
    fetch,
    storage: createObjectStorage(FAKE_S3, fetch),
  };
}
