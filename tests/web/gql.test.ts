import { ViewerDocument } from '../../web/src/__generated__/graphql.ts';
import { request } from '../../web/src/core/gql.ts';

const HTTP_OK = 200;

/**
 * Has `/graphql` answer with a body.
 *
 * @param body - What it answers.
 */
function answerWith(body: unknown): void {
  const reply = new Response(JSON.stringify(body), {
    status: HTTP_OK,
    headers: { 'content-type': 'application/json' },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async () => reply),
  );
}

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the reply's data", async () => {
    const viewer = { viewer: { id: 'u1', username: 'ada' } };
    answerWith({ data: viewer });
    await expect(request(ViewerDocument)).resolves.toEqual(viewer);
  });

  it("throws the reply's GraphQL errors as one", async () => {
    answerWith({ data: null, errors: [{ message: 'First.' }, { message: 'Second.' }] });
    await expect(request(ViewerDocument)).rejects.toThrow('First.; Second.');
  });

  it('throws the refusal the server sent before GraphQL saw the request', async () => {
    answerWith({ error: 'Send JSON.' });
    await expect(request(ViewerDocument)).rejects.toThrow('Send JSON.');
  });

  it('refuses a reply that is not GraphQL', async () => {
    answerWith({ data: 'not an object', errors: 'none' });
    await expect(request(ViewerDocument)).rejects.toThrow('not a GraphQL reply');
  });

  it('refuses a reply with no data', async () => {
    answerWith({});
    await expect(request(ViewerDocument)).rejects.toThrow('no data');
  });
});
