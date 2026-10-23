import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, lte, or, type SQL } from 'drizzle-orm';
import { AUDIT_DEFAULTS, type AuditSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { DocumentStore } from '../db/document.ts';
import { auditEntries } from '../db/schema.ts';
import { AuditTargetKind, type AuditType } from './audit-vocabulary.ts';

export { AppSignInVia, AUDIT_TYPES, AuditTargetKind, AuditType, SIGN_IN_TYPES } from './audit-vocabulary.ts';

/** The target of key rotations. */
export const KEYS_TARGET: AuditTarget = Object.freeze({
  kind: AuditTargetKind.Keys,
  id: 'signing',
  name: 'Signing keys',
});

/** Who did it. */
export interface AuditActor {
  userId: string;
  username: string;
}

/**
 * Names a user as an entry's actor.
 *
 * @param user - The user.
 * @returns Their id and current username.
 */
export function actorOf(user: { id: string; username: string }): AuditActor {
  return { userId: user.id, username: user.username };
}

/**
 * Names a user as an entry's target.
 *
 * @param user - The user.
 * @returns The target.
 */
export function userTarget(user: { id: string; username: string }): AuditTarget {
  return { kind: AuditTargetKind.User, id: user.id, name: user.username };
}

/** Who made an admin change and where it is recorded: a GraphQL resolver's context. */
export interface AdminChangeContext {
  audit: AuditLog;
  /** The signed-in admin. */
  viewer: { id: string; username: string };
  /** Their address. */
  ip: string | null;
}

/**
 * Records what the signed-in admin did. Only changes that worked get here.
 *
 * @param ctx - Who did it, and the log.
 * @param type - What they did.
 * @param target - What they did it to.
 * @param [detail] - What else to keep. Never a password, token, secret or setup URL.
 */
export function recordAdminChange(
  ctx: AdminChangeContext,
  type: AuditType,
  target: AuditTarget,
  detail?: AuditEvent['detail'],
): void {
  ctx.audit.record({ type, actor: actorOf(ctx.viewer), ip: ctx.ip, target, detail });
}

/** What it was done to. The name is as it was then, so an entry still reads after a rename or delete. */
export interface AuditTarget {
  kind: AuditTargetKind;
  id: string;
  name: string;
}

/**
 * What a caller records. Never put a password, token, secret or setup URL in it: the log is meant to be read by
 * people, and is not hashed or encrypted.
 */
export interface AuditEvent {
  type: AuditType;
  /**
   * The signed-in user who did it, or for a sign-in the account it was for. Null when nobody is known, such as a
   * sign-in with an unknown username or an app managing its own registration.
   */
  actor: AuditActor | null;
  /** The client's address, as Express or Koa sees it behind `TRUST_PROXY`. */
  ip: string | null;
  target?: AuditTarget;
  /** Plain facts worth keeping, such as the username a failed sign-in tried. */
  detail?: Record<string, string>;
}

/** One line of the log. */
export interface AuditEntry extends AuditEvent {
  /** A random id, also the cursor for the next page. */
  id: string;
  /** When, as an ISO 8601 string. */
  at: string;
}

/** Which entries to read. */
export interface AuditQuery {
  /** How many, at most `AUDIT_DEFAULTS.maxPageSize`. */
  first?: number;
  /** The id of the last entry of the page before; the page starts after it. */
  after?: string | null;
  /** Only these types. */
  types?: readonly AuditType[] | null;
  /** Only entries done by this user or done to them. */
  userId?: string | null;
}

/** A page of entries, newest first. */
export interface AuditPage {
  entries: AuditEntry[];
  /** The cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/** The append-only log of who did what. */
export interface AuditLog {
  /**
   * Appends an entry. Listeners hear of it at once; it is saved in the order it was recorded. It never throws: a
   * write that fails is logged and the request goes on.
   *
   * @param event - What happened.
   */
  record: (event: AuditEvent) => void;
  /**
   * Waits for the entries recorded so far to be saved, or to fail.
   *
   * @returns Once they have.
   */
  settled: () => Promise<void>;
  /**
   * Reads entries, newest first, once every entry recorded before the call is saved.
   *
   * @param query - The filters and the page.
   * @returns The page.
   */
  list: (query: AuditQuery) => Promise<AuditPage>;
  /**
   * Calls a listener with every entry recorded from now on.
   *
   * @param listener - Called after each append.
   * @returns A function that stops the calls.
   */
  onRecord: (listener: (entry: AuditEntry) => void) => () => void;
}

/** Where the log's own failures are reported. */
const LOG_TAG = '[audit]';
/** The log's file in a backup, one entry per line, oldest first; the data directory of an older version had it too. */
export const AUDIT_FILE = 'audit.jsonl';

/** An entry as its table holds it. */
type AuditRow = typeof auditEntries.$inferSelect;
/** An entry as it is inserted: the table numbers it. */
type NewAuditRow = Omit<typeof auditEntries.$inferInsert, 'seq'>;

/**
 * Lays an entry out as a row.
 *
 * @param entry - The entry.
 * @returns Its row.
 */
export function auditRowOf(entry: AuditEntry): NewAuditRow {
  return {
    id: entry.id,
    at: new Date(entry.at),
    type: entry.type,
    actorUserId: entry.actor?.userId ?? null,
    actorUsername: entry.actor?.username ?? null,
    ip: entry.ip ?? null,
    targetKind: entry.target?.kind ?? null,
    targetId: entry.target?.id ?? null,
    targetName: entry.target?.name ?? null,
    detail: entry.detail ?? {},
  };
}

/**
 * Reads an entry from its row.
 *
 * @param row - The row.
 * @returns The entry, without the parts it did not have.
 */
export function auditEntryOf(row: AuditRow): AuditEntry {
  const { actorUserId, actorUsername, targetKind, targetId, targetName, detail } = row;
  return {
    id: row.id,
    at: row.at.toISOString(),
    type: row.type,
    actor: actorUserId === null ? null : { userId: actorUserId, username: actorUsername ?? '' },
    ip: row.ip,
    ...(targetKind === null ? {} : { target: { kind: targetKind, id: targetId ?? '', name: targetName ?? '' } }),
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}

/**
 * Says whether a parsed line is an entry.
 *
 * @param value - The parsed line.
 * @returns True when it has an id, a time and a type.
 */
function isEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'id' in value && typeof value.id === 'string' && 'at' in value && typeof value.at === 'string' && 'type' in value
  );
}

/**
 * Reads the entries of a log file: one JSON entry per line. A line that is not one, such as a torn last line, is
 * skipped.
 *
 * @param text - The file.
 * @returns Its entries, in file order.
 */
export function entriesOfLines(text: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) {
        entries.push(value);
      }
    } catch {
      // A torn line: skip it.
    }
  }
  return entries;
}

/**
 * Writes entries as a log file.
 *
 * @param entries - The entries, oldest first.
 * @returns One JSON entry per line.
 */
export function linesOfEntries(entries: readonly AuditEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

/**
 * Says whether an entry was done by a user or to them.
 *
 * @param entry - The entry.
 * @param userId - The user.
 * @returns True when they are its actor or its target.
 */
function concerns(entry: AuditEntry, userId: string): boolean {
  return entry.actor?.userId === userId || (entry.target?.kind === AuditTargetKind.User && entry.target.id === userId);
}

/**
 * Says whether an entry passes a query's filters, for the entries a subscription hears of as they are recorded.
 *
 * @param entry - The entry.
 * @param query - The filters. The page is ignored.
 * @returns True when it passes.
 */
export function matchesQuery(entry: AuditEntry, { types = null, userId = null }: AuditQuery): boolean {
  if (types !== null && types.includes(entry.type) === false) {
    return false;
  }
  return userId === null || concerns(entry, userId);
}

/**
 * Builds the condition a query's filters make.
 *
 * @param query - The filters.
 * @returns The condition, or undefined for every entry.
 */
function filterOf({ types = null, userId = null }: AuditQuery): SQL | undefined {
  const byType = types === null ? undefined : inArray(auditEntries.type, [...types]);
  const byUser =
    userId === null
      ? undefined
      : or(
          eq(auditEntries.actorUserId, userId),
          and(eq(auditEntries.targetKind, AuditTargetKind.User), eq(auditEntries.targetId, userId)),
        );
  return and(byType, byUser);
}

/**
 * Opens the audit log in its table.
 *
 * @param store - The database and its write queue.
 * @param [now] - The clock, in epoch milliseconds.
 * @param [overrides] - Settings that differ from `AUDIT_DEFAULTS`.
 * @returns The log.
 */
export function openAuditLog(
  store: DocumentStore,
  now: () => number = Date.now,
  overrides: Partial<AuditSettings> = {},
): AuditLog {
  const { keptEntries, pruneEveryEntries, pageSize, maxPageSize } = { ...AUDIT_DEFAULTS, ...overrides };
  const { db, queue } = store;
  const listeners = new Set<(entry: AuditEntry) => void>();
  let recordedSincePrune = 0;
  let lastWrite: Promise<void> = Promise.resolve();

  /** Drops the entries older than the newest `keptEntries`. */
  const prune = async (): Promise<void> => {
    const [newest] = await db
      .select({ seq: auditEntries.seq })
      .from(auditEntries)
      .orderBy(desc(auditEntries.seq))
      .limit(1);
    if (newest !== undefined) {
      await db.delete(auditEntries).where(lte(auditEntries.seq, newest.seq - keptEntries));
    }
  };

  return {
    record: (event) => {
      const entry: AuditEntry = { id: randomUUID(), at: new Date(now()).toISOString(), ...event };
      lastWrite = queue
        .run(async () => {
          await db.insert(auditEntries).values(auditRowOf(entry));
          recordedSincePrune += 1;
          if (recordedSincePrune >= pruneEveryEntries) {
            recordedSincePrune = 0;
            await prune();
          }
        })
        .catch((error: unknown) => console.error(LOG_TAG, 'could not record', event.type, errorMessage(error)));
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (error) {
          console.error(LOG_TAG, 'a listener failed on', event.type, errorMessage(error));
        }
      }
    },
    settled: () => lastWrite,
    onRecord: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    list: (query) =>
      queue.run(async () => {
        const { first = pageSize, after = null } = query;
        const size = Math.min(Math.max(first, 1), maxPageSize);
        const [cursor] =
          after === null
            ? []
            : await db.select({ seq: auditEntries.seq }).from(auditEntries).where(eq(auditEntries.id, after));
        // A cursor that is gone, such as one pruned since, ends the list.
        if (after !== null && cursor === undefined) {
          return { entries: [], nextCursor: null };
        }
        const rows = await db
          .select()
          .from(auditEntries)
          .where(and(filterOf(query), cursor === undefined ? undefined : lt(auditEntries.seq, cursor.seq)))
          .orderBy(desc(auditEntries.seq))
          .limit(size + 1);
        const entries = rows.slice(0, size).map(auditEntryOf);
        const hasMore = rows.length > size;
        return { entries, nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null };
      }),
  };
}
