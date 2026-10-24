import { z } from 'zod';
import { post, SignInRefusal } from '../../web/src/core/sign-in.ts';

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;

const redirectSchema = z.object({ redirectTo: z.string() });

/**
 * Has the next fetch answer with a reply.
 *
 * @param reply - What it answers.
 * @returns The stubbed fetch.
 */
function answerWith(reply: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/**
 * Builds a JSON reply.
 *
 * @param status - Its HTTP status.
 * @param body - What it holds.
 * @returns The reply.
 */
function replyOf(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Runs a post that should be refused and hands back what it threw.
 *
 * @returns The refusal.
 */
async function refusalOf(): Promise<unknown> {
  return post('/interaction/abc/login', {}, redirectSchema).catch((error: unknown) => error);
}

describe('the sign-in page’s post', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the body as JSON and parses the reply', async () => {
    const fetch = answerWith(replyOf(HTTP_OK, { redirectTo: '/oidc/auth/abc' }));
    const reply = await post('/interaction/abc/login', { username: 'ada' }, redirectSchema);
    expect(reply).toEqual({ redirectTo: '/oidc/auth/abc' });
    expect(fetch).toHaveBeenCalledWith('/interaction/abc/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada' }),
    });
  });

  it('throws a refusal that says to start again when the server says so', async () => {
    answerWith(replyOf(HTTP_FORBIDDEN, { error: 'Start again.', restart: true }));
    const refusal = await refusalOf();
    expect(refusal).toBeInstanceOf(SignInRefusal);
    expect(refusal).toMatchObject({ message: 'Start again.', restart: true });
  });

  it('throws a refusal that keeps the step when the server leaves restart out', async () => {
    answerWith(replyOf(HTTP_FORBIDDEN, { error: 'Wrong code.' }));
    expect(await refusalOf()).toMatchObject({ message: 'Wrong code.', restart: false });
  });

  it('names the status for a refusal that is not JSON', async () => {
    answerWith(new Response('<html>', { status: HTTP_UNAVAILABLE }));
    const refusal = await refusalOf();
    expect(refusal).toBeInstanceOf(SignInRefusal);
    expect(refusal).toMatchObject({ restart: false });
    expect(String(refusal)).toContain(String(HTTP_UNAVAILABLE));
  });
});
