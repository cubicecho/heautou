// A backup: every store's data as the files the data directory held before the database, gzipped as one JSON
// document, and checking one before it is taken back. `server/db/data-set.ts` writes the files out and puts them back.
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { BACKUP_DEFAULTS, type BackupSettings } from '../core/defaults.ts';
import { isSealed, type SecretBox, SecretKeyError } from '../core/secret-box.ts';
import type { DataSet } from '../db/data-set.ts';
import { DOCUMENT_FILES } from '../db/documents.ts';

/** What the `format` member of every archive says. */
export const BACKUP_FORMAT = 'heautou-backup';
/** The archive layout this build writes and reads. A different one is refused rather than guessed at. */
export const BACKUP_VERSION = 1;

/** What a backup archive holds, once unzipped. */
export interface BackupArchive {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** When it was made, as an ISO 8601 string. */
  createdAt: string;
  /** Whether the provider's sessions and tokens were taken. */
  includesSessions: boolean;
  /** Each data file's text, by its path under the data directory of a version before the database, with `/` between parts. */
  files: Record<string, string>;
}

/** Which files a backup treats apart. The services name them from their own file list. */
export interface BackupLayout {
  /** Files never taken and emptied by a restore, such as the web app's sessions, so a restore signs everyone out. */
  skipped: readonly string[];
  /** Files an archive must hold, without which the restored server could not start. */
  required: readonly string[];
}

/**
 * What a backup leaves out or needs. Every other store's document is taken, so a new store is backed up without being
 * listed here.
 */
export const BACKUP_LAYOUT: BackupLayout = Object.freeze({
  /** The web app's sessions: a restore signs everyone out rather than bringing back sessions from the backup. */
  skipped: Object.freeze([DOCUMENT_FILES.webSessions, DOCUMENT_FILES.proxySessions]),
  required: Object.freeze([DOCUMENT_FILES.keys]),
});

/** Where a restore was asked for, as its audit entry says. */
export const RestoreVia = { Web: 'web', Cli: 'cli' } as const;
export type RestoreVia = (typeof RestoreVia)[keyof typeof RestoreVia];

/** What to take. */
export interface BackupOptions {
  /** Take the provider's sessions and tokens too. */
  includeSessions: boolean;
}

/** What a restore put back. */
export interface RestoreSummary {
  /** How many files it put back. */
  files: number;
  /** When the archive was made, as an ISO 8601 string. */
  createdAt: string;
  /** Whether the archive held the provider's sessions and tokens. */
  includesSessions: boolean;
}

/** Why an archive was refused. Nothing is written when one is. */
export const BackupErrorCode = {
  /** Not gzip, or not the JSON document a backup is. */
  NotAnArchive: 'BACKUP_NOT_AN_ARCHIVE',
  /** Made by a version of heautou with another archive layout. */
  WrongVersion: 'BACKUP_WRONG_VERSION',
  /** Over `BACKUP_DEFAULTS`, zipped or unzipped. */
  TooBig: 'BACKUP_TOO_BIG',
  /** A file that does not parse, a path outside the data directory, or a required file missing. */
  BadFile: 'BACKUP_BAD_FILE',
  /** Sealed secrets that open under neither `SECRET_KEY` nor `SECRET_KEY_PREVIOUS`, or with no key set. */
  WrongKey: 'BACKUP_WRONG_KEY',
} as const;
export type BackupErrorCode = (typeof BackupErrorCode)[keyof typeof BackupErrorCode];

/** An archive that can't be restored, with a sentence the operator can act on. */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  /**
   * Makes the error.
   *
   * @param code - What went wrong.
   * @param message - What to do about it.
   */
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** The data files are JSON documents, and the audit log is JSON lines. Anything else in the directory is not data. */
const JSON_EXTENSION = '.json';
export const JSON_LINES_EXTENSION = '.jsonl';
/** One part of a path: letters, digits, dots, dashes and underscores, but not `.` or `..` alone. */
const PATH_PART = /^(?!\.{1,2}$)[\w.-]+$/;

const archiveSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number(),
  createdAt: z.string(),
  includesSessions: z.boolean(),
  files: z.record(z.string(), z.string()),
});

/**
 * Says whether a path names a data file.
 *
 * @param relative - A path under the data directory, with `/` between parts.
 * @returns True for a `.json` or `.jsonl` file.
 */
export function isDataFile(relative: string): boolean {
  return relative.endsWith(JSON_EXTENSION) || relative.endsWith(JSON_LINES_EXTENSION);
}

/**
 * Parses each line of a JSON lines file.
 *
 * @param text - The file's text.
 * @returns For each non-empty line, its value, or undefined where it does not parse.
 */
export function linesOf(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    });
}

/**
 * Reads a data file's text into values, refusing one that does not parse.
 *
 * @param relative - Its path, for the error.
 * @param text - Its text.
 * @returns Its document, or its lines for JSON lines.
 * @throws BackupError when it, or one of its lines, is not JSON.
 */
export function parseDataFile(relative: string, text: string): unknown[] {
  if (relative.endsWith(JSON_LINES_EXTENSION)) {
    const values = linesOf(text);
    if (values.includes(undefined)) {
      throw new BackupError(BackupErrorCode.BadFile, `${relative} in the archive has a line that is not JSON.`);
    }
    return values;
  }
  try {
    return [JSON.parse(text)];
  } catch {
    throw new BackupError(BackupErrorCode.BadFile, `${relative} in the archive is not JSON.`);
  }
}

/**
 * Lists every sealed value in a parsed document, at any depth.
 *
 * @param value - The document.
 * @param found - Where they are collected.
 * @returns The same list.
 */
function sealedValuesIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (isSealed(value)) {
      found.push(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      sealedValuesIn(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      sealedValuesIn(item, found);
    }
  }
  return found;
}

/**
 * Makes a backup: a gzipped JSON document holding each store's file, secrets sealed.
 *
 * @param files - The files, as the data set wrote them out.
 * @param layout - Which files a server needs.
 * @param options - Whether the provider's sessions and tokens were taken.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The archive.
 * @throws BackupError when a file every server has is missing.
 */
export function createBackup(
  files: Record<string, string>,
  layout: BackupLayout,
  options: BackupOptions,
  now: () => number = Date.now,
): Buffer {
  const missing = layout.required.filter((relative) => relative in files === false);
  if (missing.length > 0) {
    throw new BackupError(
      BackupErrorCode.BadFile,
      `There is no ${missing.join(', ')}: this is not the data of a server that has started.`,
    );
  }
  const archive: BackupArchive = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date(now()).toISOString(),
    includesSessions: options.includeSessions,
    files,
  };
  return gzipSync(JSON.stringify(archive));
}

/**
 * Unzips an archive and reads its outer document.
 *
 * @param archive - The gzipped bytes.
 * @param limits - The largest archive, zipped and unzipped.
 * @returns The document, unchecked.
 * @throws BackupError when it is too big, not gzip or not JSON.
 */
function unpack(archive: Buffer, limits: BackupSettings): unknown {
  if (archive.length > limits.maxArchiveBytes) {
    throw new BackupError(
      BackupErrorCode.TooBig,
      `The archive is ${archive.length} bytes; a restore takes up to ${limits.maxArchiveBytes}.`,
    );
  }
  let text: string;
  try {
    text = gunzipSync(archive, { maxOutputLength: limits.maxUnpackedBytes }).toString('utf8');
  } catch (error) {
    const isTooBig = error instanceof RangeError;
    if (isTooBig) {
      throw new BackupError(
        BackupErrorCode.TooBig,
        `The archive unzips to more than ${limits.maxUnpackedBytes} bytes, more than a restore takes.`,
      );
    }
    throw new BackupError(BackupErrorCode.NotAnArchive, 'That file is not a heautou backup: it is not gzipped.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupError(BackupErrorCode.NotAnArchive, 'That file is not a heautou backup: it is not JSON.');
  }
}

/**
 * Checks an archive through before anything is written: its format and version, every path, that every file parses,
 * the files a server needs, and that every sealed secret opens under the current keys.
 *
 * @param archive - The gzipped bytes.
 * @param layout - Which files the archive must hold.
 * @param box - The keys the server runs with, or null when no `SECRET_KEY` is set.
 * @param [limits] - The largest archive, zipped and unzipped; tests make them small.
 * @returns The checked archive.
 * @throws BackupError saying what is wrong with it.
 */
export function readBackup(
  archive: Buffer,
  layout: BackupLayout,
  box: SecretBox | null,
  limits: BackupSettings = BACKUP_DEFAULTS,
): BackupArchive {
  const document = unpack(archive, limits);
  const isOurs =
    typeof document === 'object' && document !== null && 'format' in document && document.format === BACKUP_FORMAT;
  if (isOurs === false) {
    throw new BackupError(BackupErrorCode.NotAnArchive, 'That file is not a heautou backup.');
  }
  const version = 'version' in document ? document.version : undefined;
  if (version !== BACKUP_VERSION) {
    throw new BackupError(
      BackupErrorCode.WrongVersion,
      `The archive is format version ${String(version)}; this server reads version ${BACKUP_VERSION}.`,
    );
  }
  const parsed = archiveSchema.safeParse(document);
  if (parsed.success === false) {
    throw new BackupError(
      BackupErrorCode.NotAnArchive,
      'The archive is damaged: its contents are not laid out as a backup.',
    );
  }
  const checked: BackupArchive = parsed.data;
  const sealed: string[] = [];
  for (const [relative, text] of Object.entries(checked.files)) {
    const isSafePath = isDataFile(relative) && relative.split('/').every((part) => PATH_PART.test(part));
    if (isSafePath === false) {
      throw new BackupError(BackupErrorCode.BadFile, `The archive names a file "${relative}" that is not a data file.`);
    }
    for (const value of parseDataFile(relative, text)) {
      sealedValuesIn(value, sealed);
    }
  }
  const missing = layout.required.filter((relative) => relative in checked.files === false);
  if (missing.length > 0) {
    throw new BackupError(BackupErrorCode.BadFile, `The archive has no ${missing.join(', ')}, which a server needs.`);
  }
  if (sealed.length > 0 && box === null) {
    throw new BackupError(
      BackupErrorCode.WrongKey,
      'The archive holds sealed secrets but SECRET_KEY is not set. Set SECRET_KEY to the key it was sealed with.',
    );
  }
  try {
    for (const value of sealed) {
      box?.open(value);
    }
  } catch (error) {
    if (error instanceof SecretKeyError) {
      throw new BackupError(
        BackupErrorCode.WrongKey,
        'The archive’s sealed secrets do not open with SECRET_KEY or SECRET_KEY_PREVIOUS. Restore it where the key it was made under is set.',
      );
    }
    throw error;
  }
  return checked;
}

/**
 * Picks the files a restore puts back: all but the skipped ones, which it empties.
 *
 * @param layout - Which files are skipped.
 * @param backup - The checked archive.
 * @returns The files, and what to report.
 */
export function filesToRestore(
  layout: BackupLayout,
  backup: BackupArchive,
): { files: Record<string, string>; summary: RestoreSummary } {
  const files = Object.fromEntries(
    Object.entries(backup.files).filter(([relative]) => layout.skipped.includes(relative) === false),
  );
  const summary = {
    files: Object.keys(files).length,
    createdAt: backup.createdAt,
    includesSessions: backup.includesSessions,
  };
  return { files, summary };
}

/**
 * Makes an archive of the data as the tables hold it.
 *
 * @param dataSet - Everything kept, as files.
 * @param options - Whether to take the provider's sessions and tokens.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The gzipped archive.
 * @throws BackupError when a file every server has is missing.
 */
export async function exportArchive(
  dataSet: DataSet,
  options: BackupOptions,
  now: () => number = Date.now,
): Promise<Buffer> {
  const files = await dataSet.exportFiles({ ...options, skipped: BACKUP_LAYOUT.skipped });
  return createBackup(files, BACKUP_LAYOUT, options, now);
}

/**
 * Checks an archive and puts its data in the tables in one transaction, emptying the skipped documents. Nothing is
 * written when the archive is refused. A running server still has to read its stores again.
 *
 * @param dataSet - Everything kept, as files.
 * @param archive - The gzipped archive.
 * @param box - The keys the data is sealed with, or null when no `SECRET_KEY` is set.
 * @returns What was put back.
 * @throws BackupError when the archive is refused.
 */
export async function restoreArchive(
  dataSet: DataSet,
  archive: Buffer,
  box: SecretBox | null,
): Promise<RestoreSummary> {
  const checked = readBackup(archive, BACKUP_LAYOUT, box);
  const { files, summary } = filesToRestore(BACKUP_LAYOUT, checked);
  await dataSet.replaceAll(files);
  return summary;
}

/**
 * Says what a restore put back, for its `DataRestored` entry.
 *
 * @param summary - What the restore put back.
 * @param via - Where it was asked for.
 * @returns The entry's detail.
 */
export function restoredDetail(summary: RestoreSummary, via: RestoreVia): Record<string, string> {
  return {
    madeAt: summary.createdAt,
    files: String(summary.files),
    sessions: summary.includesSessions ? 'included' : 'left out',
    via,
  };
}
