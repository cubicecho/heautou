// Everything heautou keeps, as the files a backup archive holds: each store's document as JSON, the audit log as JSON
// lines and the provider's models one file each. The same layout is what the data directory held before the
// database, so restoring a backup and importing an older data directory are the same thing.
import { asc } from 'drizzle-orm';
import { AUDIT_FILE, auditEntryOf, auditRowOf, entriesOfLines, linesOfEntries } from '../store/audit.ts';
import type { Transaction } from './client.ts';
import { type DocumentStore, loosen, type Row, readDocument, replaceDocument } from './document.ts';
import { DOCUMENT_MAPPINGS, modelOfFile, oidcModelDocument } from './documents.ts';
import { auditEntries, oidcModels } from './schema.ts';

/** Two-space indents, as the data files had, so a person can read a backup's files. */
const JSON_INDENT = 2;
/** What a rotated audit file was called before the database: `audit.1.jsonl` is newer than `audit.2.jsonl`. */
const ROTATED_AUDIT_FILE = /^audit\.(\d+)\.jsonl$/;

/** What to leave out of an export. */
export interface ExportOptions {
  /** Whether to take the provider's sessions and tokens. */
  includeSessions: boolean;
  /** Files never taken, such as the web app's sessions. */
  skipped: readonly string[];
}

/** Everything heautou keeps, as files. */
export interface DataSet {
  /**
   * Writes everything out as files, once every change made so far is saved. Secrets stay sealed.
   *
   * @param options - What to leave out.
   * @returns The files by their path in the archive. A document still as a new install has it is left out.
   */
  exportFiles: (options: ExportOptions) => Promise<Record<string, string>>;
  /**
   * Replaces everything with what files hold, in one transaction: a document whose file is missing is emptied. The
   * stores' documents in memory are not reloaded; the caller reloads them.
   *
   * @param files - Files by path, as an archive or an older data directory holds them.
   * @throws When a file is not JSON or not laid out as its document; nothing is changed then.
   */
  replaceAll: (files: Record<string, string>) => Promise<void>;
}

/**
 * Reads a data file.
 *
 * @param file - Its path, for the error.
 * @param text - Its contents.
 * @returns What it holds.
 * @throws When it is not JSON.
 */
function parseFile(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON.`);
  }
}

/**
 * Puts the audit log's files back, oldest first: the rotated files of an older data directory, then the current one.
 *
 * @param tx - The transaction.
 * @param files - The files.
 */
async function replaceAudit(tx: Transaction, files: Record<string, string>): Promise<void> {
  const rotated = Object.keys(files)
    .flatMap((file) => {
      const [, number] = ROTATED_AUDIT_FILE.exec(file) ?? [];
      return number === undefined ? [] : [{ file, age: Number(number) }];
    })
    .sort((a, b) => b.age - a.age)
    .map(({ file }) => file);
  const ordered = [...rotated, AUDIT_FILE].flatMap((file) => entriesOfLines(files[file] ?? ''));
  const unique = [...new Map(ordered.map((entry) => [entry.id, entry])).values()];
  await tx.delete(auditEntries);
  for (const entry of unique) {
    await tx.insert(auditEntries).values(auditRowOf(entry));
  }
}

/**
 * Puts the provider's models back, one file per model.
 *
 * @param tx - The transaction.
 * @param files - The files.
 */
async function replaceModels(tx: Transaction, files: Record<string, string>): Promise<void> {
  await tx.delete(oidcModels);
  for (const [file, text] of Object.entries(files)) {
    const model = modelOfFile(file);
    if (model !== null) {
      await replaceDocument(tx, loosen(oidcModelDocument(model)), parseFile(file, text));
    }
  }
}

/**
 * Builds the data set over the database.
 *
 * @param store - The database and its write queue.
 * @returns The data set.
 */
export function createDataSet(store: DocumentStore): DataSet {
  const { db, queue } = store;
  return {
    exportFiles: (options) =>
      queue.run(async () => {
        const files: Record<string, string> = {};
        const isTaken = (file: string): boolean => options.skipped.includes(file) === false;
        for (const mapping of DOCUMENT_MAPPINGS) {
          const document: unknown = await readDocument(db, mapping);
          const isUntouched = JSON.stringify(document) === JSON.stringify(mapping.fallback);
          if (isTaken(mapping.name) && isUntouched === false) {
            files[mapping.name] = `${JSON.stringify(document, null, JSON_INDENT)}\n`;
          }
        }
        const audit = await db.select().from(auditEntries).orderBy(asc(auditEntries.seq));
        if (audit.length > 0 && isTaken(AUDIT_FILE)) {
          files[AUDIT_FILE] = linesOfEntries(audit.map(auditEntryOf));
        }
        if (options.includeSessions) {
          const byModel = new Map<string, Row[]>();
          for (const row of await db.select().from(oidcModels)) {
            byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
          }
          for (const [model, rows] of byModel) {
            const mapping = loosen(oidcModelDocument(model));
            const document = mapping.fromRows([rows]);
            files[mapping.name] = `${JSON.stringify(document, null, JSON_INDENT)}\n`;
          }
        }
        return files;
      }),
    replaceAll: (files) =>
      queue.run(() =>
        db.transaction(async (tx) => {
          for (const mapping of DOCUMENT_MAPPINGS) {
            const text = files[mapping.name];
            const document = text === undefined ? mapping.fallback : parseFile(mapping.name, text);
            await replaceDocument(tx, mapping, document);
          }
          await replaceAudit(tx, files);
          await replaceModels(tx, files);
        }),
      ),
  };
}
