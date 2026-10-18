// A backup of the data directory: every data file, gzipped as one JSON document, and taking one back.
import {
  chmodSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { BACKUP_DEFAULTS, type BackupSettings } from '../core/defaults.ts';
import { isSealed, type SecretBox, SecretKeyError } from '../core/secret-box.ts';
import { DIR_MODE, FILE_MODE } from './json-file.ts';

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
  /** Each data file's text, exactly as it was on disk, by its path under the data directory with `/` between parts. */
  files: Record<string, string>;
}

/** Which parts of the data directory a backup treats apart. The services name them from their own file list. */
export interface BackupLayout {
  /** The directory holding the provider's sessions and tokens, taken only when asked for. */
  sessionsDir: string;
  /** Files never taken and removed by a restore, such as the web app's sessions, so a restore signs everyone out. */
  skipped: readonly string[];
  /** Files an archive must hold, without which the restored server could not start. */
  required: readonly string[];
}

/** What to take. */
export interface BackupOptions {
  /** Take the provider's sessions and tokens too. */
  includeSessions: boolean;
}

/** What a restore put back. */
export interface RestoreSummary {
  /** How many files were written. */
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
const JSON_LINES_EXTENSION = '.jsonl';
/** A file a restore is writing, renamed over the real one once every file is written. */
const RESTORE_SUFFIX = '.restore.tmp';
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
function isDataFile(relative: string): boolean {
  return relative.endsWith(JSON_EXTENSION) || relative.endsWith(JSON_LINES_EXTENSION);
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
 * Parses each line of a JSON lines file.
 *
 * @param text - The file's text.
 * @returns For each non-empty line, its value, or undefined where it does not parse.
 */
function linesOf(text: string): unknown[] {
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
function parseDataFile(relative: string, text: string): unknown[] {
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
 * Reads one data file for an archive. A JSON lines file loses lines a crash cut short, which the audit log skips
 * when it reads them anyway, so one torn line never makes every later backup unrestorable.
 *
 * @param dataDir - The data directory.
 * @param relative - The file's path under it.
 * @returns Its text.
 * @throws When a JSON file does not parse: a backup that could not be restored is refused while it is made.
 */
function readForArchive(dataDir: string, relative: string): string {
  const text = readFileSync(path.join(dataDir, ...relative.split('/')), 'utf8');
  if (relative.endsWith(JSON_LINES_EXTENSION)) {
    const kept = text.split('\n').filter((line) => line.trim() !== '' && linesOf(line)[0] !== undefined);
    return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
  }
  parseDataFile(relative, text);
  return text;
}

/**
 * Makes a backup of the data directory: a gzipped JSON document holding each data file's text as it is on disk, so
 * sealed secrets stay sealed.
 *
 * @param dataDir - The data directory.
 * @param layout - Which files are left out, and where the sessions are.
 * @param options - Whether to take the provider's sessions and tokens.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The archive.
 * @throws BackupError when a data file is not JSON, or a file every server has is missing.
 *
 * @remarks
 * Every file is read synchronously, in one turn of the event loop. The stores write synchronously from the same
 * process, so no write lands between two reads and the archive is one consistent moment. Run from another process
 * (the CLI beside a running server) each file is still whole, since writes are renamed into place.
 */
export function createBackup(
  dataDir: string,
  layout: BackupLayout,
  options: BackupOptions,
  now: () => number = Date.now,
): Buffer {
  const files: Record<string, string> = {};
  for (const relative of listDataFiles(dataDir)) {
    const isSkipped = layout.skipped.includes(relative);
    const isSession = isUnder(relative, layout.sessionsDir);
    const isLeftOut = isSkipped || (isSession && options.includeSessions === false);
    if (isLeftOut) {
      continue;
    }
    files[relative] = readForArchive(dataDir, relative);
  }
  const missing = layout.required.filter((relative) => relative in files === false);
  if (missing.length > 0) {
    throw new BackupError(
      BackupErrorCode.BadFile,
      `${dataDir} has no ${missing.join(', ')}: it is not the data directory of a server that has started.`,
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
 * Makes the data directory what a checked archive holds. Every file is written beside its target first, then each
 * is renamed over it, and data files the archive does not hold are removed: the web app's sessions always, and the
 * provider's sessions and tokens when it has none.
 *
 * @param dataDir - The data directory.
 * @param layout - Which files are never restored.
 * @param backup - The archive, from `readBackup`.
 * @returns What was put back.
 *
 * @remarks
 * The renames are not atomic as a set, but they run back to back with nothing else in between: a server restoring
 * through its own route answers no request until they are done. If writing a file fails, the files written so far
 * are removed and the data is left as it was.
 */
export function restoreBackup(dataDir: string, layout: BackupLayout, backup: BackupArchive): RestoreSummary {
  const incoming = Object.entries(backup.files).filter(([relative]) => layout.skipped.includes(relative) === false);
  const staged: Array<{ temp: string; target: string }> = [];
  try {
    for (const [relative, text] of incoming) {
      const target = path.join(dataDir, ...relative.split('/'));
      const temp = `${target}${RESTORE_SUFFIX}`;
      mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
      staged.push({ temp, target });
      writeFileSync(temp, text, { encoding: 'utf8', mode: FILE_MODE });
      chmodSync(temp, FILE_MODE);
    }
  } catch (error) {
    for (const { temp } of staged) {
      rmSync(temp, { force: true });
    }
    throw error;
  }
  const kept = new Set(incoming.map(([relative]) => relative));
  const leaving = listDataFiles(dataDir).filter((relative) => kept.has(relative) === false);
  for (const { temp, target } of staged) {
    renameSync(temp, target);
  }
  for (const relative of leaving) {
    rmSync(path.join(dataDir, ...relative.split('/')), { force: true });
  }
  return { files: staged.length, createdAt: backup.createdAt, includesSessions: backup.includesSessions };
}
