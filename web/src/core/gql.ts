import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';

/** The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ENDPOINT = '/graphql';

/** Where the server starts an admin sign-in; `?return=` is where it comes back to. */
const ADMIN_LOGIN = '/admin/login';
/** What `/graphql` answers when the admin session is missing or over. */
const HTTP_UNAUTHORIZED = 401;
/** What `/graphql` answers a signed-in user who is not an admin. */
const HTTP_FORBIDDEN = 403;
/** Where a user who is not an admin has their own page. */
const ACCOUNT_PAGE = '/account';

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
 * Sends the browser on when the server refused the admin session: to sign in, coming back to this page, on a 401,
 * and to the account page on a 403.
 *
 * @param status - The response's HTTP status.
 * @returns What to tell the caller when it was refused; null when it was not.
 */
function sendOnIfRefused(status: number): Error | null {
  if (status === HTTP_UNAUTHORIZED) {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`${ADMIN_LOGIN}?return=${encodeURIComponent(here)}`);
    return new Error('Your admin session ended. Signing in again…');
  }
  if (status === HTTP_FORBIDDEN && window.location.pathname !== ACCOUNT_PAGE) {
    window.location.assign(ACCOUNT_PAGE);
    return new Error('Only admins may use this page.');
  }
  return null;
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
 * A user who is signed in but not an admin gets 403, and is sent to their account page.
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

  const refusal = sendOnIfRefused(response.status);
  if (refusal !== null) {
    throw refusal;
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

/** How long a dropped subscription waits before it opens again. */
const RESUBSCRIBE_MS = 3000;
/** What separates server-sent events. */
const EVENT_END = '\n\n';

/** What a subscription is told about, besides its events. */
export interface SubscriptionHandlers<TResult> {
  /** Called with each event's `data`. */
  onData: (data: TResult) => void;
  /**
   * Called when the stream opens, the first time and after each drop, so a page can refetch what it missed while
   * it was down.
   */
  onOpen?: () => void;
  /** Called once when the server ended the stream itself, such as a pairing that expired. */
  onComplete?: () => void;
}

/**
 * Reads one server-sent event block.
 *
 * @param block - The lines between two blank lines.
 * @returns The event's name and its joined `data` lines.
 */
function parseEvent(block: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }
  return { event, data: data.join('\n') };
}

/**
 * Opens a GraphQL subscription over server-sent events, the way Yoga serves them, and keeps it open: a stream that
 * drops is opened again after `RESUBSCRIBE_MS`.
 *
 * @param document - The typed subscription.
 * @param variables - Its variables.
 * @param handlers - What to call with each event, and when the stream opens or ends.
 * @returns A function that closes it for good.
 *
 * @remarks
 * A 401 or 403 sends the browser on, as `request` does. The server checks the admin session only when the stream
 * opens, so a session that ends while watching is noticed on the next drop.
 */
export function subscribe<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  variables: TVariables,
  handlers: SubscriptionHandlers<TResult>,
): () => void {
  const abort = new AbortController();
  const query = print(document);

  /**
   * Reads one stream to its end.
   *
   * @returns Whether the server completed it, which ends the subscription.
   */
  const follow = async (): Promise<boolean> => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query, variables }),
      signal: abort.signal,
    });
    if (sendOnIfRefused(response.status) !== null || response.status === HTTP_FORBIDDEN) {
      return true;
    }
    if (response.ok === false || response.body === null) {
      return false;
    }
    handlers.onOpen?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return false;
      }
      buffer += chunk.value;
      for (let end = buffer.indexOf(EVENT_END); end !== -1; end = buffer.indexOf(EVENT_END)) {
        const { event, data } = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + EVENT_END.length);
        if (event === 'complete') {
          return true;
        }
        if (event === 'next' && data !== '') {
          const body: GraphQLResponse<TResult> = JSON.parse(data);
          if (body.data !== undefined && body.data !== null) {
            handlers.onData(body.data);
          }
        }
      }
    }
  };

  void (async () => {
    while (abort.signal.aborted === false) {
      const isComplete = await follow().catch(() => false);
      if (isComplete) {
        if (abort.signal.aborted === false) {
          handlers.onComplete?.();
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_MS));
    }
  })();
  return () => abort.abort();
}
