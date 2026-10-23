import { isSealed, type SecretBox, SecretKeyError, SecretKeyErrorCode } from '../core/secret-box.ts';
import type { DataDocument } from '../db/document.ts';

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
export function secretsIn<T>(document: T, mapSecrets: SecretMapper<T>): string[] {
  const found: string[] = [];
  mapSecrets(document, (secret) => {
    found.push(secret);
    return secret;
  });
  return found;
}

/**
 * Checks that every secret in a document opens with the key, without changing anything.
 *
 * @param document - The document as stored.
 * @param box - The key, or null when none is set.
 * @param mapSecrets - Finds its secrets.
 * @throws SecretKeyError when it holds sealed values and no key is set, or values the key does not open.
 */
export function checkSecrets<T>(document: T, box: SecretBox | null, mapSecrets: SecretMapper<T>): void {
  if (box === null) {
    if (secretsIn(document, mapSecrets).some(isSealed)) {
      throw new SecretKeyError(
        SecretKeyErrorCode.Missing,
        'The data holds sealed secrets but SECRET_KEY is not set. Set SECRET_KEY or SECRET_KEY_FILE to the key it was sealed with.',
      );
    }
    return;
  }
  mapSecrets(document, box.open);
}

/**
 * Opens a document whose secrets are sealed in the database and plain in memory. With a key, plain or previous-key
 * values are sealed under the current key as it is opened. Without one, it stays as it is, plain text.
 *
 * @typeParam T - The document's shape.
 * @param document - The document, as the tables hold it.
 * @param box - Seals and opens the secrets, or null when no `SECRET_KEY` is set.
 * @param mapSecrets - Finds the document's secrets.
 * @returns The document with its secrets open. Every write seals them again; a secret that did not change keeps the
 * sealed value it had, so its row is not rewritten.
 * @throws SecretKeyError when the document holds sealed values and no key is set, or values the key does not open.
 * Nothing is written then.
 */
export async function openSealedDocument<T>(
  document: DataDocument<T>,
  box: SecretBox | null,
  mapSecrets: SecretMapper<T>,
): Promise<DataDocument<T>> {
  checkSecrets(document.read(), box, mapSecrets);
  if (box === null) {
    return document;
  }
  /** Each open secret's sealed value, as the tables hold it. */
  let sealedOf = new Map<string, string>();
  const seal = (next: T): T =>
    mapSecrets(next, (secret) => {
      const known = sealedOf.get(secret);
      if (known !== undefined) {
        return known;
      }
      const sealed = box.seal(secret);
      sealedOf.set(secret, sealed);
      return sealed;
    });
  /**
   * Opens the document as the tables hold it, and remembers each secret's sealed value.
   *
   * @returns The document with its secrets open.
   */
  const openStored = (): T => {
    sealedOf = new Map();
    return mapSecrets(document.read(), (sealed) => {
      const secret = box.open(sealed);
      if (box.isCurrent(sealed)) {
        sealedOf.set(secret, sealed);
      }
      return secret;
    });
  };
  /**
   * Opens the document as the tables hold it, and seals again under the current key the secrets that are plain or
   * under the previous one. Everything is opened before anything is written, so a wrong key leaves the tables as they
   * were.
   *
   * @returns Once any re-sealing is saved; `current` then holds the document with its secrets open.
   */
  const openAndReseal = async (): Promise<void> => {
    const opened = openStored();
    current = opened;
    const isStale = secretsIn(document.read(), mapSecrets).some((secret) => box.isCurrent(secret) === false);
    if (isStale) {
      await document.update(() => seal(opened));
      current = openStored();
    }
  };
  let current = openStored();
  await openAndReseal();
  return {
    read: () => current,
    update: (change) => {
      const next = change(current);
      current = next;
      return document
        .update(() => seal(next))
        .then(
          () => next,
          (error: unknown) => {
            current = openStored();
            throw error;
          },
        );
    },
    reload: async () => {
      await document.reload();
      await openAndReseal();
    },
  };
}
