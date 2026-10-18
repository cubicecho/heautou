import { isSealed, type SecretBox, SecretKeyError, SecretKeyErrorCode } from '../core/secret-box.ts';
import type { JsonFile } from './json-file.ts';

/**
 * Rebuilds a document with each of its secrets changed, and nothing else.
 *
 * @typeParam T - The document's shape.
 */
export type SecretMapper<T> = (document: T, change: (secret: string) => string) => T;

/**
 * Lists the secrets in a document.
 *
 * @param document - The document.
 * @param mapSecrets - Finds its secrets.
 * @returns Them, as stored.
 */
function secretsIn<T>(document: T, mapSecrets: SecretMapper<T>): string[] {
  const found: string[] = [];
  mapSecrets(document, (secret) => {
    found.push(secret);
    return secret;
  });
  return found;
}

/**
 * Opens a JSON file whose secrets are sealed on disk and plain in memory. With a key, plain or previous-key values
 * are sealed under the current key as the file is opened. Without one, the file stays as it is, plain text.
 *
 * @typeParam T - The document's shape.
 * @param file - The file, as read from disk.
 * @param box - Seals and opens the secrets, or null when no `SECRET_KEY` is set.
 * @param mapSecrets - Finds the document's secrets.
 * @returns The document with its secrets open. Every write seals them again.
 * @throws SecretKeyError when the file holds sealed values and no key is set, or values the key does not open.
 * Nothing is written then.
 */
export function openSealedFile<T>(file: JsonFile<T>, box: SecretBox | null, mapSecrets: SecretMapper<T>): JsonFile<T> {
  const stored = file.read();
  if (box === null) {
    if (secretsIn(stored, mapSecrets).some(isSealed)) {
      throw new SecretKeyError(
        SecretKeyErrorCode.Missing,
        'The data holds sealed secrets but SECRET_KEY is not set. Set SECRET_KEY or SECRET_KEY_FILE to the key it was sealed with.',
      );
    }
    return file;
  }
  const seal = (document: T): T => mapSecrets(document, box.seal);
  /**
   * Opens the document as the file holds it, re-sealing values that are plain or under the previous key.
   *
   * @returns The document with its secrets open.
   */
  const openStored = (): T => {
    const onDisk = file.read();
    // Open everything before writing anything, so a wrong key leaves the file as it was.
    const opened = mapSecrets(onDisk, box.open);
    const isStale = secretsIn(onDisk, mapSecrets).some((secret) => box.isCurrent(secret) === false);
    if (isStale) {
      file.update(() => seal(opened));
    }
    return opened;
  };
  let current = openStored();
  return {
    read: () => current,
    update: (change) => {
      const next = change(current);
      file.update(() => seal(next));
      current = next;
      return next;
    },
    reload: () => {
      file.reload();
      current = openStored();
    },
  };
}
