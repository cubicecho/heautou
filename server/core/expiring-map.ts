import { MS_PER_SECOND } from './wire.ts';

/** A map in memory whose entries are forgotten after a while. */
export interface ExpiringMap<T> {
  /**
   * Keeps a value until it expires, replacing one under the same key.
   *
   * @param key - The key.
   * @param value - The value.
   */
  set: (key: string, value: T) => void;
  /**
   * Reads a value.
   *
   * @param key - The key.
   * @returns It, or null when there is none or it has expired.
   */
  get: (key: string) => T | null;
  /**
   * Reads a value and forgets it, so it can be used once.
   *
   * @param key - The key.
   * @returns It, or null when there is none or it has expired.
   */
  take: (key: string) => T | null;
  delete: (key: string) => void;
}

/**
 * Builds a map whose entries last a fixed time. Expired entries are dropped whenever one is added, so it holds no
 * more than were added in one lifetime.
 *
 * @typeParam T - What it holds.
 * @param seconds - How long an entry lasts.
 * @param [now] - The clock, in epoch milliseconds.
 * @returns The map.
 */
export function createExpiringMap<T>(seconds: number, now: () => number = Date.now): ExpiringMap<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const get = (key: string): T | null => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    const isExpired = entry.expiresAt <= now();
    if (isExpired) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    set: (key, value) => {
      const at = now();
      for (const [other, entry] of entries) {
        if (entry.expiresAt <= at) {
          entries.delete(other);
        }
      }
      entries.set(key, { value, expiresAt: at + seconds * MS_PER_SECOND });
    },
    get,
    take: (key) => {
      const value = get(key);
      entries.delete(key);
      return value;
    },
    delete: (key) => {
      entries.delete(key);
    },
  };
}
