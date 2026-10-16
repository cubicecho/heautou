import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

/** The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ENDPOINT = '/graphql';

/** Where the server starts an admin sign-in; `?return=` is where it comes back to. */
const ADMIN_LOGIN = '/admin/login';
/** What `/graphql` answers when the admin session is missing or over. */
const HTTP_UNAUTHORIZED = 401;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
  /** Set instead when the server refused the request before GraphQL saw it. */
  error?: string;
}

/**
 * Joins the messages of a GraphQL error list into one sentence.
 *
 * @param errors - The `errors` member of a response.
 * @returns One error carrying every message.
 */
function errorOf(errors: { message: string }[]): Error {
  return new Error(errors.map((error) => error.message).join('; '));
}

/**
 * Sends one request, typed by its document.
 *
 * @param document - The typed query or mutation.
 * @param variables - Its variables, left out when it takes none.
 * @returns The response's `data`.
 * @throws When the response carries errors or no data.
 *
 * @remarks
 * Without an admin session the server answers 401, and the browser is sent to sign in, coming back to this page.
 */
export async function request<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: print(document), variables }),
  });

  if (response.status === HTTP_UNAUTHORIZED) {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`${ADMIN_LOGIN}?return=${encodeURIComponent(here)}`);
    throw new Error('Your admin session ended. Signing in again…');
  }
  const body = ((await response.json().catch(() => null)) ?? {}) as GraphQLResponse<TResult>;
  if (body.error !== undefined) {
    throw new Error(body.error);
  }
  // GraphQL reports failures in the body with a 200, so the status alone proves nothing.
  if (body.errors?.length) {
    throw errorOf(body.errors);
  }
  if (body.data === undefined) {
    throw new Error(`GraphQL returned no data (HTTP ${response.status})`);
  }
  return body.data;
}
