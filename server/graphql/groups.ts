import type { GraphQLResolveInfo } from 'graphql';
import type { Context } from '../core/context.ts';
import { AuditType, groupTarget, recordAdminChange } from '../store/audit.ts';
import { deleteGroup, type Group, listGroups, renameGroup } from '../store/groups.ts';
import { type GeneratedRow, GeneratedTable, rowsWhere } from './rows.ts';

/** The groups part of the admin API: the groups users and clients name, renamed or removed everywhere at once. */
export const GROUP_TYPE_DEFS = /* GraphQL */ `
  "A name users hold in their groups claim and clients may be limited to."
  type Group {
    name: String!
    "Its users."
    members: [User!]!
    "The clients limited to it, among other groups."
    clients: [Client!]!
    "Whether it is the admin group, which cannot be renamed or removed."
    isProtected: Boolean!
  }

  extend type Query {
    "Every group a user or client names, by name."
    groups: [Group!]!
  }

  extend type Mutation {
    "Renames a group in every user and client."
    renameGroup(name: String!, newName: String!): Group!
    "Takes a group off every user. Refused while a client is limited to it. Returns how many users had it."
    deleteGroup(name: String!): Int!
  }
`;

/** The resolvers for the groups, merged with the rest of the schema's. */
export const groupResolvers = {
  Group: {
    /**
     * Resolves `Group.members`.
     *
     * @param group - The group.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the rows' selection.
     * @returns Its users.
     */
    members: (group: Group, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow[]> =>
      rowsWhere(ctx, info, GeneratedTable.Users, { id: { inArray: group.memberIds } }),
    /**
     * Resolves `Group.clients`.
     *
     * @param group - The group.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the rows' selection.
     * @returns The clients limited to it.
     */
    clients: (group: Group, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow[]> =>
      rowsWhere(ctx, info, GeneratedTable.Clients, { clientId: { inArray: group.clientIds } }),
  },
  Query: {
    /**
     * Resolves `Query.groups`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Every group.
     */
    groups: (_parent: unknown, _args: unknown, ctx: Context): Group[] => listGroups(ctx),
  },
  Mutation: {
    /**
     * Resolves `Mutation.renameGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group and its new name.
     * @param ctx - Request context.
     * @returns The renamed group.
     */
    renameGroup: async (_parent: unknown, args: { name: string; newName: string }, ctx: Context): Promise<Group> => {
      const group = await renameGroup(ctx, args.name, args.newName);
      recordAdminChange(ctx, AuditType.GroupRenamed, groupTarget(group.name), { from: args.name });
      return group;
    },
    /**
     * Resolves `Mutation.deleteGroup`.
     *
     * @param _parent - Unused.
     * @param args - The group.
     * @param ctx - Request context.
     * @returns How many users were in it.
     */
    deleteGroup: async (_parent: unknown, args: { name: string }, ctx: Context): Promise<number> => {
      const members = await deleteGroup(ctx, args.name);
      recordAdminChange(ctx, AuditType.GroupDeleted, groupTarget(args.name), { members: String(members) });
      return members;
    },
  },
};
