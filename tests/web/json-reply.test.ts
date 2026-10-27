import { z } from 'zod';
import { jsonReply, postJson, ReplyError } from '../../web/src/core/json-reply.ts';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;

const okSchema = z.object({ ok: z.literal(true) });

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

describe('jsonReply', () => {
  it('parses a successful reply with the schema', async () => {
    await expect(jsonReply(replyOf(HTTP_OK, { ok: true, extra: 1 }), okSchema)).resolves.toEqual({ ok: true });
  });

  it('refuses a successful reply the schema does not match', async () => {
    await expect(jsonReply(replyOf(HTTP_OK, { ok: false }), okSchema)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("throws the server's error for a refusal", async () => {
    const refusal = jsonReply(replyOf(HTTP_BAD_REQUEST, { error: 'That name is taken.' }), okSchema);
    await expect(refusal).rejects.toThrow('That name is taken.');
  });

  it("keeps a refusal's status and its fields besides the error", async () => {
    const reply = replyOf(HTTP_BAD_REQUEST, { error: 'Start again.', restart: true });
    const refusal = await jsonReply(reply, okSchema).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReplyError);
    expect(refusal).toMatchObject({ status: HTTP_BAD_REQUEST, fields: { restart: true } });
  });

  it('names the status for a refusal that is not JSON', async () => {
    const refusal = jsonReply(new Response('<html>', { status: HTTP_SERVER_ERROR }), okSchema);
    await expect(refusal).rejects.toThrow(String(HTTP_SERVER_ERROR));
  });

  it('names the status for a JSON refusal without an error', async () => {
    const refusal = jsonReply(replyOf(HTTP_BAD_REQUEST, { message: 'no' }), okSchema);
    await expect(refusal).rejects.toThrow(String(HTTP_BAD_REQUEST));
  });
});

describe('postJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the body as JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => replyOf(HTTP_OK, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    await postJson('/somewhere', { name: 'x' });
    expect(fetch).toHaveBeenCalledWith('/somewhere', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
  });
});
