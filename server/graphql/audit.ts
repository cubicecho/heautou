import type { GraphQLResolveInfo } from 'graphql';
import { Repeater } from 'graphql-yoga';
import type { Context } from '../core/context.ts';
import { type AuditEntry, type AuditType, matchesQuery } from '../store/audit.ts';
import { type GeneratedRow, GeneratedTable, requiredRow } from './rows.ts';

/** The audit log's live feed. Its reads are generated from the table (`build-schema.ts`). */
export const AUDIT_TYPE_DEFS = /* GraphQL */ `
  extend type Subscription {
    "Each entry recorded from now on that passes the filters: one type, and entries done by a user or to them."
    auditEntryAdded(type: AuditType, userId: ID): AuditEntry!
  }
`;

/**
 * Streams the entries recorded while a subscription is open.
 *
 * @param ctx - Request context.
 * @param args - The filters.
 * @returns The entries, each wrapped as the `auditEntryAdded` payload.
 */
function auditEntriesAdded(
  ctx: Context,
  args: { type?: AuditType | null; userId?: string | null },
): Repeater<{ auditEntryAdded: AuditEntry }> {
  const query = { types: args.type === null || args.type === undefined ? null : [args.type], userId: args.userId };
  return new Repeater(async (push, stop) => {
    const off = ctx.audit.onRecord((entry) => {
      if (matchesQuery(entry, query)) {
        void push({ auditEntryAdded: entry });
      }
    });
    await stop;
    off();
  });
}

/** The resolvers for the audit log's feed, merged with the rest of the schema's. */
export const auditResolvers = {
  Subscription: {
    auditEntryAdded: {
      /**
       * Opens `Subscription.auditEntryAdded`.
       *
       * @param _parent - Unused.
       * @param args - The filters.
       * @param ctx - Request context.
       * @returns The stream.
       */
      subscribe: (_parent: unknown, args: { type?: AuditType | null; userId?: string | null }, ctx: Context) =>
        auditEntriesAdded(ctx, args),
      /**
       * Reads each entry's row once it is saved, so it carries whatever the subscription selected.
       *
       * @param payload - The entry, as it was recorded.
       * @param payload.auditEntryAdded - The entry.
       * @param _args - Unused.
       * @param ctx - Request context.
       * @param info - The field, for the row's selection.
       * @returns The entry's row.
       */
      resolve: async (
        { auditEntryAdded: entry }: { auditEntryAdded: AuditEntry },
        _args: unknown,
        ctx: Context,
        info: GraphQLResolveInfo,
      ): Promise<GeneratedRow> => {
        await ctx.audit.settled();
        return requiredRow(ctx, info, GeneratedTable.AuditEntries, { id: { eq: entry.id } });
      },
    },
  },
};
