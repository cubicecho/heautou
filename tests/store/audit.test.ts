import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AuditEntry,
  type AuditEvent,
  AuditTargetKind,
  AuditType,
  matchesQuery,
  openAuditLog,
} from '../../server/store/audit.ts';
import { tempDir } from '../helpers.ts';

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

describe('audit log', () => {
  it('appends owner-only lines and reads them newest first, a page at a time', () => {
    const dir = tempDir();
    const file = path.join(dir, 'audit.jsonl');
    let time = Date.UTC(2026, 0, 1);
    const log = openAuditLog(file, () => time);
    for (let i = 0; i < 5; i++) {
      log.record(event(AuditType.ClientCreated, { target: { kind: AuditTargetKind.Client, id: `c${i}`, name: '' } }));
      time += 1000;
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const first = log.list({ first: 2 });
    expect(first.entries.map((entry) => entry.target?.id)).toEqual(['c4', 'c3']);
    expect(first.entries[0].at).toBe('2026-01-01T00:00:04.000Z');
    const second = log.list({ first: 2, after: first.nextCursor });
    expect(second.entries.map((entry) => entry.target?.id)).toEqual(['c2', 'c1']);
    const last = log.list({ first: 2, after: second.nextCursor });
    expect(last.entries.map((entry) => entry.target?.id)).toEqual(['c0']);
    expect(last.nextCursor).toBeNull();
  });

  it('filters by type and by the user who did it or had it done to them', () => {
    const log = openAuditLog(path.join(tempDir(), 'audit.jsonl'));
    log.record(event(AuditType.SignInSucceeded));
    log.record(event(AuditType.UserCreated, { target: { kind: AuditTargetKind.User, id: 'u2', name: 'bob' } }));
    log.record(event(AuditType.SignInFailed, { actor: null, detail: { username: 'eve' } }));

    expect(log.list({ types: [AuditType.SignInFailed] }).entries).toMatchObject([{ detail: { username: 'eve' } }]);
    expect(log.list({ userId: 'u1' }).entries.map((entry) => entry.type)).toEqual([
      AuditType.UserCreated,
      AuditType.SignInSucceeded,
    ]);
    expect(log.list({ userId: 'u2' }).entries.map((entry) => entry.type)).toEqual([AuditType.UserCreated]);
  });

  it('tells listeners about each entry once it is written, until they stop listening', () => {
    const log = openAuditLog(path.join(tempDir(), 'audit.jsonl'));
    const heard: AuditEntry[] = [];
    const off = log.onRecord((entry) => heard.push(entry));
    log.record(event(AuditType.SignInFailed, { actor: null }));
    off();
    log.record(event(AuditType.SignInSucceeded));
    expect(heard).toHaveLength(1);
    expect(heard[0]).toEqual(log.list({ types: [AuditType.SignInFailed] }).entries[0]);
    expect(matchesQuery(heard[0], { types: [AuditType.SignInFailed] })).toBe(true);
    expect(matchesQuery(heard[0], { userId: 'u1' })).toBe(false);
  });

  it('rotates by size, keeping only so many files, and still reads across them', () => {
    const dir = tempDir();
    const log = openAuditLog(path.join(dir, 'audit.jsonl'), Date.now, { maxFileBytes: 400, keptFiles: 2 });
    for (let i = 0; i < 20; i++) {
      log.record(event(AuditType.UserUpdated, { target: { kind: AuditTargetKind.User, id: `u${i}`, name: '' } }));
    }
    expect(readdirSync(dir).sort()).toEqual(['audit.1.jsonl', 'audit.2.jsonl', 'audit.jsonl']);
    for (const name of readdirSync(dir)) {
      expect(statSync(path.join(dir, name)).size).toBeLessThanOrEqual(400);
    }
    const ids = log.list({ first: 200 }).entries.map((entry) => entry.target?.id);
    expect(ids[0]).toBe('u19');
    expect(ids.length).toBeLessThan(20);
    expect(ids).toEqual([...ids].sort((a = '', b = '') => Number(b.slice(1)) - Number(a.slice(1))));
  });

  it('logs a failed write and goes on, without throwing', () => {
    const dir = tempDir();
    // A file where the log's directory should be: every write fails.
    writeFileSync(path.join(dir, 'blocker'), '');
    const file = path.join(dir, 'blocker', 'audit.jsonl');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = openAuditLog(file);
    expect(() => log.record(event(AuditType.KeysRotated))).not.toThrow();
    expect(errors).toHaveBeenCalledWith('[audit]', 'could not record', AuditType.KeysRotated, expect.any(Error));
    expect(log.list({}).entries).toEqual([]);
    errors.mockRestore();
  });
});
