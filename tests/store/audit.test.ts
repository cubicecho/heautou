import type { Database } from '../../server/db/client.ts';
import { auditEntries } from '../../server/db/schema.ts';
import {
  type AuditEntry,
  type AuditEvent,
  AuditTargetKind,
  AuditType,
  matchesQuery,
  openAuditLog,
} from '../../server/store/audit.ts';
import { createTestStore, type TestStore } from '../db.ts';

const ADA = { userId: 'u1', username: 'ada' };

/**
 * Makes an event for a test.
 *
 * @param type - What happened.
 * @param [extra] - Anything else on it.
 * @returns The event.
 */
function event(type: AuditType, extra: Partial<AuditEvent> = {}): AuditEvent {
  return { type, actor: ADA, ip: '127.0.0.1', ...extra };
}

/**
 * Makes an event done to a user, told apart by its target's id.
 *
 * @param id - The target's id.
 * @returns The event.
 */
function userUpdated(id: string): AuditEvent {
  return event(AuditType.UserUpdated, { target: { kind: AuditTargetKind.User, id, name: '' } });
}

/**
 * Wraps a database so every insert fails, as a full disk or a dropped connection would, while reads still work.
 *
 * @param db - The database.
 * @returns The same database, refusing inserts.
 */
function refusingInserts(db: Database): Database {
  return new Proxy(db, {
    get: (target, key, receiver) => {
      if (key === 'insert') {
        return () => {
          throw new Error('the disk is full');
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('audit log', () => {
  let db: TestStore;

  beforeEach(async () => {
    db = await createTestStore();
  });

  afterEach(() => db.close());

  it('reads the newest entries first, at most as many as asked', async () => {
    let time = Date.UTC(2026, 0, 1);
    const log = openAuditLog(db, () => time);
    for (let i = 0; i < 5; i++) {
      log.record(event(AuditType.ClientCreated, { target: { kind: AuditTargetKind.Client, id: `c${i}`, name: '' } }));
      time += 1000;
    }

    const { entries } = await log.list({ first: 2 });
    expect(entries.map((entry) => entry.target?.id)).toEqual(['c4', 'c3']);
    expect(entries[0]?.at).toBe('2026-01-01T00:00:04.000Z');
  });

  it('keeps entries recorded in the same millisecond in the order they were recorded', async () => {
    const log = openAuditLog(db, () => Date.UTC(2026, 0, 1));
    for (const id of ['a', 'b', 'c']) {
      log.record(userUpdated(id));
    }
    const { entries } = await log.list({});
    expect(entries.map((entry) => entry.target?.id)).toEqual(['c', 'b', 'a']);
  });

  it('reads back what an earlier log on the same database recorded', async () => {
    const before = openAuditLog(db);
    before.record(userUpdated('u2'));
    await before.settled();
    const { entries } = await openAuditLog(db).list({});
    expect(entries).toMatchObject([{ type: AuditType.UserUpdated, actor: ADA, target: { id: 'u2' } }]);
  });

  it('filters by type and by the user who did it or had it done to them', async () => {
    const log = openAuditLog(db);
    log.record(event(AuditType.SignInSucceeded));
    log.record(event(AuditType.UserCreated, { target: { kind: AuditTargetKind.User, id: 'u2', name: 'bob' } }));
    log.record(event(AuditType.SignInFailed, { actor: null, detail: { username: 'eve' } }));

    expect((await log.list({ types: [AuditType.SignInFailed] })).entries).toMatchObject([
      { detail: { username: 'eve' } },
    ]);
    expect((await log.list({ userId: 'u1' })).entries.map((entry) => entry.type)).toEqual([
      AuditType.UserCreated,
      AuditType.SignInSucceeded,
    ]);
    expect((await log.list({ userId: 'u2' })).entries.map((entry) => entry.type)).toEqual([AuditType.UserCreated]);
  });

  it('tells listeners about each entry as it is recorded, until they stop listening', async () => {
    const log = openAuditLog(db);
    const heard: AuditEntry[] = [];
    const off = log.onRecord((entry) => heard.push(entry));
    log.record(event(AuditType.SignInFailed, { actor: null }));
    off();
    log.record(event(AuditType.SignInSucceeded));
    expect(heard).toHaveLength(1);
    const [entry] = heard;
    if (entry === undefined) {
      throw new Error('No entry was heard.');
    }
    expect(entry).toEqual((await log.list({ types: [AuditType.SignInFailed] })).entries[0]);
    expect(matchesQuery(entry, { types: [AuditType.SignInFailed] })).toBe(true);
    expect(matchesQuery(entry, { userId: 'u1' })).toBe(false);
  });

  it('prunes all but the newest entries, and still reads them in order', async () => {
    const keptEntries = 5;
    const pruneEveryEntries = 3;
    const log = openAuditLog(db, Date.now, { keptEntries, pruneEveryEntries });
    for (let i = 0; i < 20; i++) {
      log.record(userUpdated(`u${i}`));
    }
    await log.settled();
    const rows = await db.db.select().from(auditEntries);
    expect(rows.length).toBeGreaterThanOrEqual(keptEntries);
    expect(rows.length).toBeLessThan(keptEntries + pruneEveryEntries);
    const ids = (await log.list({ first: 200 })).entries.map((entry) => entry.target?.id);
    expect(ids).toHaveLength(rows.length);
    expect(ids).toEqual(Array.from({ length: rows.length }, (_unused, index) => `u${19 - index}`));
  });

  it('logs a failed write and goes on, without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = openAuditLog({ db: refusingInserts(db.db), queue: db.queue });
    expect(() => log.record(event(AuditType.KeysRotated))).not.toThrow();
    await log.settled();
    expect(errors).toHaveBeenCalledWith('[audit]', 'could not record', AuditType.KeysRotated, expect.any(String));
    expect((await log.list({})).entries).toEqual([]);

    // Writes queued after it still go through.
    const working = openAuditLog(db);
    working.record(event(AuditType.SignInSucceeded));
    expect((await working.list({})).entries.map((entry) => entry.type)).toEqual([AuditType.SignInSucceeded]);
    errors.mockRestore();
  });
});
