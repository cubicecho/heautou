// The backup CLI: `node server/backup.ts export <file> [--sessions]` and `node server/backup.ts restore <file>`.
// It reads DATA_DIR and SECRET_KEY as the server does, and shares the archive code with Settings.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, secretKeys } from './core/config.ts';
import { errorMessage } from './core/errors.ts';
import { createSecretBox } from './core/secret-box.ts';
import { BACKUP_LAYOUT, DATA_FILES } from './core/services.ts';
import { AuditType, openAuditLog } from './store/audit.ts';
import { createBackup, readBackup, restoreBackup } from './store/backup.ts';
import { FILE_MODE } from './store/json-file.ts';

/** The commands. */
const Command = { Export: 'export', Restore: 'restore' } as const;
/** Takes the provider's sessions and tokens too. */
const SESSIONS_FLAG = '--sessions';
const USAGE = `Usage:
  node server/backup.ts export <file> [${SESSIONS_FLAG}]   back DATA_DIR up to <file>
  node server/backup.ts restore <file>                 replace DATA_DIR with <file>; stop the server first`;

/**
 * Writes an archive of the data directory.
 *
 * @param file - Where to.
 * @param includeSessions - Whether to take the provider's sessions and tokens.
 */
function exportTo(file: string, includeSessions: boolean): void {
  const archive = createBackup(dataDir(), BACKUP_LAYOUT, { includeSessions });
  writeFileSync(file, archive, { mode: FILE_MODE });
  const sealing =
    secretKeys() === null
      ? 'SECRET_KEY is not set, so its secrets are plain text'
      : 'its secrets are sealed under SECRET_KEY';
  console.log(`[backup] Wrote ${file} (${archive.length} bytes); ${sealing}.`);
}

/**
 * Checks an archive and makes the data directory hold it.
 *
 * @param file - The archive.
 */
function restoreFrom(file: string): void {
  const keys = secretKeys();
  const box = keys === null ? null : createSecretBox(keys);
  const directory = dataDir();
  const checked = readBackup(readFileSync(file), BACKUP_LAYOUT, box);
  const restored = restoreBackup(directory, BACKUP_LAYOUT, checked);
  openAuditLog(path.join(directory, DATA_FILES.audit)).record({
    type: AuditType.DataRestored,
    actor: null,
    ip: null,
    detail: {
      madeAt: restored.createdAt,
      files: String(restored.files),
      sessions: restored.includesSessions ? 'included' : 'left out',
      via: 'cli',
    },
  });
  console.log(
    `[backup] Restored ${restored.files} files from the backup made ${restored.createdAt} into ${directory}. Start the server to use them.`,
  );
}

const [command, file, ...flags] = process.argv.slice(2);
const isKnownFlag = flags.every((flag) => flag === SESSIONS_FLAG);
const isUsable = file !== undefined && isKnownFlag;
try {
  if (command === Command.Export && isUsable) {
    exportTo(file, flags.includes(SESSIONS_FLAG));
  } else if (command === Command.Restore && isUsable && flags.length === 0) {
    restoreFrom(file);
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[backup] ${errorMessage(error)}`);
  process.exitCode = 1;
}
