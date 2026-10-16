import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One JSON document on disk, held in memory and written through on every change. */
export interface JsonFile<T> {
  /** The document as last written. Treat it as read-only and change it through `update`. */
  read: () => T;
  /**
   * Replaces the document with what `change` returns, and writes it.
   *
   * @param change - Builds the next document from the current one.
   * @returns The next document.
   */
  update: (change: (current: T) => T) => T;
}

/** The suffix of the file a write goes to before it replaces the real one. */
const TEMP_SUFFIX = '.tmp';
/** Two-space indents, so a person can read and fix the file by hand. */
const JSON_INDENT = 2;

/**
 * Reads a document, or the fallback when the file is not there yet.
 *
 * @param file - The file's path.
 * @param fallback - The document a new install starts with.
 * @returns The parsed document.
 * @throws When the file exists but is not JSON: a hand edit gone wrong is reported, not overwritten.
 */
function readOrFallback<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  return JSON.parse(text) as T;
}

/**
 * Opens a JSON file as a document. Nothing here is encrypted or locked: one process owns the file.
 *
 * @typeParam T - The document's shape.
 * @param file - The file's path. Its directory is made when missing.
 * @param fallback - The document a new install starts with. It is not written until the first change.
 * @returns The document.
 *
 * @remarks
 * Writes are synchronous and go to a temporary file that is then renamed over the real one, so a crash
 * mid-write leaves the previous document rather than half of the next.
 */
export function openJsonFile<T>(file: string, fallback: T): JsonFile<T> {
  mkdirSync(path.dirname(file), { recursive: true });
  let current = readOrFallback(file, fallback);
  return {
    read: () => current,
    update: (change) => {
      const next = change(current);
      const temp = `${file}${TEMP_SUFFIX}`;
      writeFileSync(temp, `${JSON.stringify(next, null, JSON_INDENT)}\n`, 'utf8');
      renameSync(temp, file);
      current = next;
      return next;
    },
  };
}
