import { CREDENTIAL_DEFAULTS } from '../../server/core/defaults.ts';
import { openDocument } from '../../server/db/document.ts';
import { PASSWORD_LINKS_DOCUMENT } from '../../server/db/documents.ts';
import { passwordLinks } from '../../server/db/schema.ts';
import { createPasswordLinkStore } from '../../server/store/password-links.ts';
import { createTestStore, type TestStore } from '../db.ts';

describe('password link store', () => {
  let db: TestStore;

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('keeps only a digest, one link per user, until it is used or expires', async () => {
    let time = 1_000_000;
    const store = createPasswordLinkStore(await openDocument(db, PASSWORD_LINKS_DOCUMENT), () => time);
    const { token } = await store.issue('u1');
    expect(JSON.stringify(await db.db.select().from(passwordLinks))).not.toContain(token);
    expect(store.find(token)).toBe('u1');
    const { token: other } = await store.issue('u2');
    expect(await store.consume(token)).toBe('u1');
    expect(store.find(token)).toBeNull();
    time += CREDENTIAL_DEFAULTS.passwordLinkSeconds * 1000 + 1;
    expect(store.find(other)).toBeNull();
  });

  it('finds a link when opened again on the same database, and not once it is used', async () => {
    const store = createPasswordLinkStore(await openDocument(db, PASSWORD_LINKS_DOCUMENT));
    const { token } = await store.issue('u1');
    const reopened = createPasswordLinkStore(await openDocument(db, PASSWORD_LINKS_DOCUMENT));
    expect(reopened.find(token)).toBe('u1');
    expect(await reopened.consume(token)).toBe('u1');
    expect(createPasswordLinkStore(await openDocument(db, PASSWORD_LINKS_DOCUMENT)).find(token)).toBeNull();
  });

  it('cancels a user’s link', async () => {
    const store = createPasswordLinkStore(await openDocument(db, PASSWORD_LINKS_DOCUMENT));
    const { token } = await store.issue('u1');
    await store.cancelFor('u1');
    expect(store.find(token)).toBeNull();
  });
});
