import type { AuditEntryFieldsFragment } from '../../web/src/__generated__/graphql.ts';
import { type AuditPages, auditWhere, withNewEntry } from '../../web/src/core/audit.ts';

/**
 * Builds an audit entry as the activity page reads it.
 *
 * @param id - The entry's id.
 * @returns The entry.
 */
function entryOf(id: string): AuditEntryFieldsFragment {
  return {
    id,
    at: '2026-10-23T12:00:00.000Z',
    type: 'WEB_SIGNED_IN',
    actorUserId: 'u1',
    actorUsername: 'ada',
    ip: null,
    targetKind: null,
    targetId: null,
    targetName: null,
    detail: {},
    cursor: id,
  };
}

/**
 * Builds the cached pages of the audit log.
 *
 * @param pages - The ids on each page.
 * @returns The pages.
 */
function pagesOf(...pages: string[][]): AuditPages {
  return {
    pages: pages.map((ids) => ({ entries: ids.map(entryOf), nextCursor: null })),
    pageParams: pages.map(() => null),
  };
}

describe('auditWhere', () => {
  it('asks for every entry when nothing is filtered', () => {
    expect(auditWhere({ type: null, userId: null })).toBeNull();
  });

  it('keeps one type', () => {
    expect(auditWhere({ type: 'WEB_SIGNED_IN', userId: null })).toEqual({ type: { eq: 'WEB_SIGNED_IN' } });
  });

  it('keeps entries done by the user or to them', () => {
    expect(auditWhere({ type: null, userId: 'u1' })).toEqual({
      OR: [{ actorUserId: { eq: 'u1' } }, { targetKind: { eq: 'USER' }, targetId: { eq: 'u1' } }],
    });
  });

  it('combines a type and a user', () => {
    expect(auditWhere({ type: 'USER_UPDATED', userId: 'u1' })).toEqual({
      type: { eq: 'USER_UPDATED' },
      OR: [{ actorUserId: { eq: 'u1' } }, { targetKind: { eq: 'USER' }, targetId: { eq: 'u1' } }],
    });
  });
});

describe('withNewEntry', () => {
  it('leaves an empty cache empty', () => {
    expect(withNewEntry(undefined, entryOf('e9'))).toBeUndefined();
  });

  it('leaves a cache with no pages as it is', () => {
    const data = pagesOf();
    expect(withNewEntry(data, entryOf('e9'))).toBe(data);
  });

  it('puts a new entry at the top of the first page only', () => {
    const data = pagesOf(['e2', 'e1'], ['e0']);
    const next = withNewEntry(data, entryOf('e3'));
    expect(next?.pages.map((page) => page.entries.map((entry) => entry.id))).toEqual([['e3', 'e2', 'e1'], ['e0']]);
    expect(next?.pages[1]).toBe(data.pages[1]);
    expect(next?.pageParams).toBe(data.pageParams);
  });

  it('adds an entry once, whichever page already holds it', () => {
    const data = pagesOf(['e2', 'e1'], ['e0']);
    expect(withNewEntry(data, entryOf('e0'))).toBe(data);
  });
});
