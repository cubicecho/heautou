import { useState } from 'react';
import { ConfirmButton } from '@/components/confirm-button';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FilePickerButton } from '@/components/ui/file-picker';
import type { PickedFile } from '@/components/ui/file-picker-base';
import { Download, Upload } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { useBackupInfo, useDownloadBackup, useRestoreBackup } from '@/core/backup';
import { messageOf } from '@/core/lists';
import { formatBytes } from '@/lib/format';

/** What the restore picker offers: the gzipped archives a download saves. */
const ARCHIVE_TYPES = '.gz,application/gzip';
/** The largest archive the server takes, in bytes: `BACKUP_DEFAULTS.maxArchiveBytes`. */
const MAX_ARCHIVE_BYTES = 33_554_432;

/** An archive picked for a restore, waiting for the admin to confirm it. */
interface PickedArchive {
  name: string;
  size: number;
  blob: Blob;
}

/**
 * Says how the archive's secrets are kept: sealed under `SECRET_KEY`, or plain text when it is not set.
 *
 * @param props - Whether this server seals secrets.
 * @param props.isSealed - True when `SECRET_KEY` is set.
 * @returns The callout.
 */
function SealingNote({ isSealed }: { isSealed: boolean }) {
  if (isSealed) {
    return (
      <Alert
        variant="info"
        title="Secrets stay sealed"
        description="Client secrets, signing keys and authenticator app secrets go into the archive sealed under SECRET_KEY, as they are on disk, so restoring it needs the same key. Password hashes are in it too: keep it as safe as the data directory."
      />
    );
  }
  return (
    <Alert
      variant="warning"
      title="SECRET_KEY is not set"
      description="Client secrets, signing keys and authenticator app secrets go into the archive in plain text. Set SECRET_KEY to seal them, and keep the archive where only you can read it."
    />
  );
}

/**
 * Downloading a backup of the data, and restoring one.
 *
 * @returns The section.
 */
export function BackupSection() {
  const info = useBackupInfo();
  const download = useDownloadBackup();
  const restore = useRestoreBackup();
  const [includeSessions, setIncludeSessions] = useState(false);
  const [picked, setPicked] = useState<PickedArchive | null>(null);
  const [tooBig, setTooBig] = useState<string | null>(null);

  const pick = ([file]: PickedFile[]) => {
    if (file?.blob === undefined) {
      return;
    }
    restore.reset();
    if (file.size > MAX_ARCHIVE_BYTES) {
      setPicked(null);
      setTooBig(`${file.name} is ${formatBytes(file.size)}. A restore takes up to ${formatBytes(MAX_ARCHIVE_BYTES)}.`);
      return;
    }
    setTooBig(null);
    setPicked({ name: file.name, size: file.size, blob: file.blob });
  };

  return (
    <Section
      title="Backup"
      description="An archive of the data directory: clients, users, groups, keys, branding, settings, pairings, second factors and the audit log."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {info.isError ? <QueryError error={info.error} onRetry={info.refetch} what="the backup settings" /> : null}
          {info.data === undefined ? null : <SealingNote isSealed={info.data.isSealed} />}
          <SettingRow
            title="Include sessions and tokens"
            description="The provider’s sign-in sessions, codes and refresh tokens. They are short-lived; left out, restoring the archive signs everyone out of their apps."
            actionSlot={({ titleId }) => (
              <Switch aria-labelledby={titleId} checked={includeSessions} onCheckedChange={setIncludeSessions} />
            )}
          />
          <SettingRow
            title="Download backup"
            description="Saves the archive as a .json.gz file, the same one node server/backup.ts export writes on the server."
            actionSlot={
              <Button
                variant="outline"
                size="sm"
                iconSlot={<Download />}
                content="Download backup"
                loading={download.isPending}
                onClick={() => download.mutate(includeSessions)}
              />
            }
          />
          <SettingRow
            title="Restore"
            description="Replaces all the data with an archive’s, once it is checked to open with this server’s SECRET_KEY. Everyone is signed out of this site, you too."
            actionSlot={
              <FilePickerButton
                label="Choose archive"
                accept={ARCHIVE_TYPES}
                read="none"
                variant="outline"
                size="sm"
                iconSlot={<Upload />}
                onPickMany={pick}
              />
            }
          />
          {picked === null ? null : (
            <SettingRow
              title={`Restore ${picked.name}`}
              description={`${formatBytes(picked.size)}. Every client, user, key and setting is replaced by the archive’s.`}
              actionSlot={
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    content="Cancel"
                    disabled={restore.isPending}
                    onClick={() => setPicked(null)}
                  />
                  <ConfirmButton
                    variant="destructive"
                    size="sm"
                    content="Restore"
                    loading={restore.isPending}
                    title="Replace all data with this backup?"
                    description="Clients, users, keys, settings and the audit log become what the archive holds; anything made since it was taken is lost. Everyone is signed out, and you sign in again as a user the archive knows."
                    confirmLabel="Restore"
                    onConfirm={() => restore.mutate(picked.blob)}
                  />
                </div>
              }
            />
          )}
          {tooBig === null ? null : <Alert variant="destructive" title="Archive not used" description={tooBig} />}
          {download.error === null ? null : (
            <Alert variant="destructive" title="Backup not made" description={messageOf(download.error)} />
          )}
          {restore.error === null ? null : (
            <Alert variant="destructive" title="Nothing restored" description={messageOf(restore.error)} />
          )}
        </div>
      }
    />
  );
}
