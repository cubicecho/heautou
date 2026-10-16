/** HTTP status codes this server sends or checks. */
export const HttpStatus = {
  Ok: 200,
  SeeOther: 303,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  PayloadTooLarge: 413,
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Milliseconds in a second. */
export const MS_PER_SECOND = 1000;
