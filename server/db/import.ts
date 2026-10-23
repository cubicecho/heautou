// The first boot after the move to a database: the data directory of an older version held JSON files, which are put in
// the tables once and then moved aside, so nothing reads them again.
import { type Dirent, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { DIR_MODE } from '../core/wire.ts';
import { isDataFile, JSON_LINES_EXTENSION, linesOf, parseDataFile } from '../store/backup.ts';
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

/**
 * Says whether a path is under a directory, or is it.
 *
 * @param relative - A path with `/` between parts.
 * @param dir - The directory, the same way.
 * @returns Whether it is.
 */
function isUnder(relative: string, dir: string): boolean {
  return relative === dir || relative.startsWith(`${dir}/`);
}

/**
 * Lists the data files under the data directory: every `.json` and `.jsonl` file at any depth, so a store added
 * later is backed up without being named here. Temporary files a write left behind are not data.
 *
 * @param dataDir - The data directory.
 * @returns Their paths under it, with `/` between parts, sorted.
 */
export function listDataFiles(dataDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dataDir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dataDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(isDataFile)
    .sort();
}

/**
 * Reads one data file of an older data directory. A JSON lines file loses lines a crash cut short, which the audit
 * log skipped when it read them anyway.
 *
 * @param dataDir - The data directory.
 * @param relative - The file's path under it.
 * @returns Its text.
 * @throws BackupError when a JSON file does not parse.
 */
function readDataFile(dataDir: string, relative: string): string {
  const text = readFileSync(path.join(dataDir, ...relative.split('/')), 'utf8');
  if (relative.endsWith(JSON_LINES_EXTENSION)) {
    const kept = text.split('\n').filter((line) => line.trim() !== '' && linesOf(line)[0] !== undefined);
    return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
  }
  parseDataFile(relative, text);
  return text;
}

/**
 * Reads the data files a version before the database kept in its data directory.
 *
 * @param dataDir - The data directory.
 * @param exceptUnder - Directories under it to leave alone, such as PGlite's.
 * @returns Each file's text, by its path under the directory.
 * @throws BackupError when a JSON file does not parse.
 */
export function readDataDirectory(dataDir: string, exceptUnder: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const relative of listDataFiles(dataDir)) {
    const isLeftAlone = exceptUnder.some((dir) => isUnder(relative, dir));
    if (isLeftAlone === false) {
      files[relative] = readDataFile(dataDir, relative);
    }
  }
  return files;
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
