/** HTTP status codes this server sends or checks. */
export const HttpStatus = {
  Ok: 200,
  Created: 201,
  NoContent: 204,
  NotModified: 304,
  Found: 302,
  SeeOther: 303,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  PayloadTooLarge: 413,
  UnsupportedMediaType: 415,
  TooManyRequests: 429,
  BadGateway: 502,
  ServiceUnavailable: 503,
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Milliseconds in a second. */
export const MS_PER_SECOND = 1000;
/** Bytes in a kilobyte, for sizes shown to people. */
export const BYTES_PER_KB = 1024;
/** Bytes in a megabyte, for sizes shown to people. */
export const BYTES_PER_MB = 1_048_576;
/** Owner read and write only, for a file holding keys, secrets or sessions. */
export const FILE_MODE = 0o600;
/** Owner only, for a directory made here. One that already exists is left as it is. */
export const DIR_MODE = 0o700;
