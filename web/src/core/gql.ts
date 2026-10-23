import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { HttpStatus, MS_PER_SECOND } from '@server/core/wire.ts';
import { print } from 'graphql';
import { SUBSCRIPTION_DEFAULTS } from '@/core/defaults';
import { ACCOUNT_PAGE, signInPath } from '@/core/paths';

/** The browser talks to its own origin; Vite proxies `/graphql` to the server in dev. */
const ENDPOINT = '/graphql';

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
  if (status === HttpStatus.Unauthorized) {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(signInPath(here));
    return new Error('Your admin session ended. Signing in again…');
  }
  if (status === HttpStatus.Forbidden && window.location.pathname !== ACCOUNT_PAGE) {
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
 * drops is opened again after `SUBSCRIPTION_DEFAULTS.resubscribeSeconds`.
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
    if (sendOnIfRefused(response.status) !== null || response.status === HttpStatus.Forbidden) {
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
      await new Promise((resolve) => setTimeout(resolve, SUBSCRIPTION_DEFAULTS.resubscribeSeconds * MS_PER_SECOND));
    }
  })();
  return () => abort.abort();
}
