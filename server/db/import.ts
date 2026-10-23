// The first boot after the move to a database: the data directory of an older version held JSON files, which are put in
// the tables once and then moved aside, so nothing reads them again.
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { DIR_MODE } from '../core/wire.ts';
import { readDataDirectory } from '../store/backup.ts';
import { type Database, PGLITE_DIRECTORY } from './client.ts';
import type { DataSet } from './data-set.ts';
import { DOCUMENT_FILES } from './documents.ts';
import { documents } from './schema.ts';

/** Where the imported files are moved, under the data directory. */
export const IMPORTED_DIRECTORY = 'imported-json';

/**
 * Says whether a database holds no data yet: no keys, which every server makes on its first boot.
 *
 * @param db - The database, migrated.
 * @returns True for a database no server has started on.
 */
export async function isUnstarted(db: Database): Promise<boolean> {
  const keys = await db.select({ name: documents.name }).from(documents).where(eq(documents.name, DOCUMENT_FILES.keys));
  return keys.length === 0;
}

/** What an import did. */
export interface ImportSummary {
  /** How many files were put in the tables. */
  files: number;
  /** Where they were moved. */
  movedTo: string;
}

/**
 * Puts an older version's JSON data in the database, when the database has none yet and the data directory has some.
 * The files are moved to `imported-json/` once the tables hold them, so a second boot finds nothing to import and the
 * operator can delete them once they are happy.
 *
 * @param dataSet - Everything kept, as files.
 * @param dataDir - The data directory.
 * @param isEmpty - Whether the database holds no data yet (`isUnstarted`).
 * @returns What was imported, or null when there was nothing to.
 * @throws When a file is not JSON or not laid out as its store's; nothing is written or moved then.
 */
export async function importDataDirectory(
  dataSet: DataSet,
  dataDir: string,
  isEmpty: boolean,
): Promise<ImportSummary | null> {
  if (isEmpty === false) {
    return null;
  }
  const files = readDataDirectory(dataDir, [PGLITE_DIRECTORY, IMPORTED_DIRECTORY]);
  if (DOCUMENT_FILES.keys in files === false) {
    return null;
  }
  await dataSet.replaceAll(files);
  const movedTo = path.join(dataDir, IMPORTED_DIRECTORY);
  for (const relative of Object.keys(files)) {
    const target = path.join(movedTo, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
    renameSync(path.join(dataDir, ...relative.split('/')), target);
  }
  return { files: Object.keys(files).length, movedTo };
}
