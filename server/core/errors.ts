import { GraphQLError } from 'graphql';

/** The `extensions.code` values clients branch on. */
export const ErrorCode = {
  NotFound: 'NOT_FOUND',
  BadUserInput: 'BAD_USER_INPUT',
  QueryTooComplex: 'QUERY_TOO_COMPLEX',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Makes an error factory for one code.
 *
 * @param code - The `extensions.code` value.
 * @returns A function from message to GraphQLError.
 */
const withCode =
  (code: ErrorCode) =>
  (message: string): GraphQLError =>
    new GraphQLError(message, { extensions: { code } });

/** Arguments the caller can fix. */
export const badInput = withCode(ErrorCode.BadUserInput);
/** No such thing. */
export const notFound = withCode(ErrorCode.NotFound);
/** The operation is too deep, too aliased or too costly. */
export const tooComplex = withCode(ErrorCode.QueryTooComplex);

/**
 * Reads the message of any caught value.
 *
 * @param error - Whatever was thrown.
 * @returns `error.message` for an Error, otherwise `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
