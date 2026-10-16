/** HTTP status codes this server sends or checks. */
export const HttpStatus = {
  Ok: 200,
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
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Milliseconds in a second. */
export const MS_PER_SECOND = 1000;
/** Bytes in a kilobyte, for sizes shown to people. */
export const BYTES_PER_KB = 1024;
