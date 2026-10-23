import { createDataSet } from '../../server/db/data-set.ts';
import { createWriteQueue } from '../../server/db/document.ts';
import { archivePathOf, DOCUMENT_NAMES } from '../../server/db/documents.ts';
import { users } from '../../server/db/schema.ts';
import { AUDIT_FILE } from '../../server/store/audit.ts';
import { BACKUP_LAYOUT } from '../../server/store/backup.ts';
import { createTestDatabase } from '../db.ts';
import { startTestApp, type TestApp } from '../helpers.ts';
import { signInAsAdmin } from '../oidc/browser.ts';

describe('data set', () => {
  let app: TestApp;

  beforeEach(async () => {
    app = await startTestApp();
    await signInAsAdmin(app);
  });

  afterEach(() => app.close());

  it('puts back exactly what it wrote out, in another database', async () => {
    const options = { includeSessions: true, skipped: [] };
    const files = await app.services.dataSet.exportFiles(options);
    const target = await createTestDatabase();
    try {
      const copy = createDataSet({ db: target.db, queue: createWriteQueue() });
      await copy.replaceAll(files);
      expect(await copy.exportFiles(options)).toEqual(files);
    } finally {
      await target.close();
    }
  });

  it('leaves out skipped files, untouched documents, and the provider sessions unless asked', async () => {
    const without = await app.services.dataSet.exportFiles({ includeSessions: false, skipped: BACKUP_LAYOUT.skipped });
    expect(Object.keys(without)).toEqual(
      expect.arrayContaining([archivePathOf(DOCUMENT_NAMES.users), archivePathOf(DOCUMENT_NAMES.keys), AUDIT_FILE]),
    );
    expect(without).not.toHaveProperty(archivePathOf(DOCUMENT_NAMES.webSessions));
    expect(without).not.toHaveProperty(archivePathOf(DOCUMENT_NAMES.branding));
    expect(Object.keys(without).some((file) => file.startsWith('oidc/'))).toBe(false);

    const withSessions = await app.services.dataSet.exportFiles({ includeSessions: true, skipped: [] });
    expect(Object.keys(withSessions).some((file) => file.startsWith('oidc/'))).toBe(true);
    expect(withSessions).toHaveProperty(archivePathOf(DOCUMENT_NAMES.webSessions));
  });

  it('changes nothing when a file is not JSON', async () => {
    const files = await app.services.dataSet.exportFiles({ includeSessions: true, skipped: [] });
    const before = await app.services.db.select().from(users);
    const damaged = { ...files, [archivePathOf(DOCUMENT_NAMES.clients)]: '{ not json' };
    await expect(app.services.dataSet.replaceAll(damaged)).rejects.toThrow(archivePathOf(DOCUMENT_NAMES.clients));
    expect(await app.services.db.select().from(users)).toEqual(before);
  });
});
