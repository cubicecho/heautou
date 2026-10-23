import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { jsonReply, postJson, redirectReplySchema } from '@/core/json-reply';
import { QUERY_KEYS } from '@/core/query-keys';

/** The server's backup routes. */
const BACKUP_URL = '/admin/backup';
const RESTORE_URL = '/admin/restore';
/** The archive's media type, which the restore route takes. */
const ARCHIVE_TYPE = 'application/gzip';
/** What the file is saved as when the reply names none. */
const FALLBACK_NAME = 'heautou-backup.json.gz';
/** The file name in a `Content-Disposition: attachment; filename="…"` header. */
const FILE_NAME = /filename="([^"]+)"/;

const infoSchema = z.object({ isSealed: z.boolean() });

/**
 * Reads whether this server seals secrets, so the backup section can say what the archive holds.
 *
 * @returns The query.
 */
export function useBackupInfo() {
  return useQuery({
    queryKey: QUERY_KEYS.backup,
    queryFn: async () => jsonReply(await fetch(BACKUP_URL), infoSchema),
  });
}

/**
 * Hands the browser a file to save.
 *
 * @param blob - The file.
 * @param name - What to call it.
 */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Downloads an archive of the data and saves it.
 *
 * @returns The mutation; its variable says whether to take the provider's sessions and tokens.
 */
export function useDownloadBackup() {
  return useMutation({
    mutationFn: async (includeSessions: boolean) => {
      const response = await postJson(BACKUP_URL, { includeSessions });
      if (response.ok === false) {
        await jsonReply(response, z.never());
      }
      const name = FILE_NAME.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? FALLBACK_NAME;
      save(await response.blob(), name);
    },
  });
}

/**
 * Replaces the data with an archive's. Every web session ends with it, so on success the browser is sent to sign in
 * again, as whoever the restored data knows.
 *
 * @returns The mutation; its variable is the archive.
 */
export function useRestoreBackup() {
  return useMutation({
    mutationFn: async (archive: Blob) =>
      jsonReply(
        await fetch(RESTORE_URL, { method: 'POST', headers: { 'content-type': ARCHIVE_TYPE }, body: archive }),
        redirectReplySchema,
      ),
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });
}
