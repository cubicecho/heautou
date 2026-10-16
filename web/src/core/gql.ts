import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

/** The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ENDPOINT = '/graphql';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/** What a subscription calls back with. */
export interface SubscriptionHandlers<TResult> {
  next: (data: TResult) => void;
  error?: (error: Error) => void;
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

  const body = (await response.json()) as GraphQLResponse<TResult>;
  // GraphQL reports failures in the body with a 200, so the status alone proves nothing.
  if (body.errors?.length) {
    throw errorOf(body.errors);
  }
  if (body.data === undefined) {
    throw new Error(`GraphQL returned no data (HTTP ${response.status})`);
  }
  return body.data;
}

/**
 * Opens one subscription over server-sent events.
 *
 * @param document - The typed subscription.
 * @param variables - Its variables.
 * @param handlers - Called for each payload and each failure.
 * @returns The unsubscribe; call it on unmount.
 *
 * @remarks
 * Yoga answers `GET /graphql?query=…` with an SSE stream, which `EventSource` reads and
 * reconnects by itself, so a dropped connection is reported and left to recover.
 */
export function subscribe<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  variables: TVariables,
  handlers: SubscriptionHandlers<TResult>,
): () => void {
  const params = new URLSearchParams({
    query: print(document),
    variables: JSON.stringify(variables ?? {}),
  });
  const source = new EventSource(`${ENDPOINT}?${params}`);

  source.addEventListener('next', (message) => {
    const body = JSON.parse(message.data) as GraphQLResponse<TResult>;
    if (body.errors?.length) {
      handlers.error?.(errorOf(body.errors));
      return;
    }
    if (body.data !== undefined) {
      handlers.next(body.data);
    }
  });
  source.addEventListener('complete', () => source.close());
  source.onerror = () => handlers.error?.(new Error('lost the connection to the server'));

  return () => source.close();
}
