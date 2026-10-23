import type { GraphQLResolveInfo } from 'graphql';
import { adminUrls, sessionClientName, WEB_APP_PAGE } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { PROFILE_DEFAULTS } from '../core/defaults.ts';
import { notFound } from '../core/errors.ts';
import type { SessionInfo } from '../oidc/sessions.ts';
import { AuditType, recordAdminChange, userTarget } from '../store/audit.ts';
import type { NewUser, PublicUser, UserFields } from '../store/users.ts';
import { type GeneratedRow, GeneratedTable, requiredRow, rowWhere } from './rows.ts';

/** The users part of the admin API: what a row can't hold (sessions, second factors, picture), the viewer, every change. */
export const USER_TYPE_DEFS = /* GraphQL */ `
  "A browser signed in to the provider."
  type Session {
    id: ID!
    "When they signed in, as an ISO 8601 string."
    signedInAt: String
    "When it ends unless used, as an ISO 8601 string."
    expiresAt: String
    "The names of the clients it signed in to."
    clientNames: [String!]!
  }

  extend type User {
    "False for an invited user who has not set a password yet."
    hasPassword: Boolean!
    "The browsers signed in as them, newest first."
    sessions: [Session!]!
    "What they can give as a second factor after their password."
    secondFactors: SecondFactors!
    "The URL of their profile picture, which the picture claim holds. Null when they have none or pictures are off."
    pictureUrl: String
  }

  "Whether profile pictures can be set, which needs an S3 bucket."
  type ProfilePictures {
    "True when the server has a bucket configured."
    isEnabled: Boolean!
    "The largest upload, in bytes."
    maxBytes: Int!
  }

  "A user's second factors, without any secret."
  type SecondFactors {
    "Whether an authenticator app is set up."
    hasTotp: Boolean!
    "How many unused recovery codes they have."
    recoveryCodesLeft: Int!
    "How many passkeys they registered."
    passkeyCount: Int!
  }

  "A link a user opens to set their password."
  type PasswordLink {
    url: String!
    "When it stops working, as an ISO 8601 string."
    expiresAt: String!
  }

  input ClaimInput {
    name: String!
    value: String!
  }

  "A user to add. Without a password they are invited, and set one through createPasswordLink's link."
  input NewUserInput {
    username: String!
    password: String
    email: String!
    name: String!
    groups: [String!]!
    claims: [ClaimInput!]
  }

  "A user's new details. The password is changed with setUserPassword; claims left out are kept."
  input UserInput {
    username: String!
    email: String!
    name: String!
    groups: [String!]!
    claims: [ClaimInput!]
  }

  extend type Query {
    "The admin signed in to this UI."
    viewer: User!
    "Whether profile pictures can be set."
    profilePictures: ProfilePictures!
  }

  extend type Mutation {
    "Adds a user."
    createUser(input: NewUserInput!): User!
    "Changes a user's details."
    updateUser(id: ID!, input: UserInput!): User!
    "Sets a user's password."
    setUserPassword(id: ID!, password: String!): User!
    "Removes a user, and ends their sessions and tokens."
    deleteUser(id: ID!): User!
    "Disables or enables a user. Disabling ends their sessions and tokens."
    setUserDisabled(id: ID!, disabled: Boolean!): User!
    "Ends one of a user's sessions, and the tokens it gave clients."
    endUserSession(id: ID!, sessionId: ID!): User!
    "Ends every session and token of a user."
    signOutUser(id: ID!): User!
    "Removes every second factor a user has, as for a lost phone. They sign in with their password alone until they add one again."
    resetSecondFactors(id: ID!): User!
    "Makes a link that sets a user's password, for an invite or a reset. Their previous link stops working."
    createPasswordLink(id: ID!): PasswordLink!
  }
`;

/** What `Session` resolves from. */
interface SessionView extends Omit<SessionInfo, 'clientIds'> {
  clientNames: string[];
}

/** The part of a generated `User` row the hand-written fields read. */
interface UserRow {
  id: string;
}

/**
 * Picks a user's row out by id.
 *
 * @param id - The user.
 * @returns The filter.
 */
export const userById = (id: string) => ({ id: { eq: id } });

/**
 * Ends everything a user is signed in with: the provider's sessions and tokens and the web app's sessions.
 *
 * @param ctx - Request context.
 * @param userId - The user.
 * @returns Once the apps with a back-channel logout URI have been told.
 */
async function signOutEverywhere(ctx: Context, userId: string): Promise<void> {
  await ctx.webSessions.removeUser(userId);
  await ctx.sessions.revokeAccount(userId, ctx.ip);
}

/**
 * Loads a user by id.
 *
 * @param ctx - Request context.
 * @param id - The user's id.
 * @returns The user.
 * @throws NOT_FOUND when there is none.
 */
export function loadUser(ctx: Context, id: string): PublicUser {
  const user = ctx.users.find(id);
  if (user === null) {
    throw notFound(`No user has the ID "${id}".`);
  }
  return user;
}

/** The resolvers for the users, merged with the rest of the schema's. */
export const userResolvers = {
  User: {
    /**
     * Resolves `User.hasPassword`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns False for an invited user who has not set one.
     */
    hasPassword: (row: UserRow, _args: unknown, ctx: Context): boolean => ctx.users.find(row.id)?.hasPassword ?? false,
    /**
     * Resolves `User.pictureUrl`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The URL the picture claim holds, or null.
     */
    pictureUrl: (row: UserRow, _args: unknown, ctx: Context): string | null => {
      const user = ctx.users.find(row.id);
      return user === null ? null : ctx.pictures.urlOf(user);
    },
    /**
     * Resolves `User.sessions`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Their provider sessions, with client names.
     */
    sessions: (row: UserRow, _args: unknown, ctx: Context): SessionView[] =>
      ctx.sessions.sessionsOf(row.id).map(({ clientIds, ...session }) => ({
        ...session,
        clientNames: clientIds.map((clientId) => sessionClientName(clientId, ctx.clients, ctx.branding.read())),
      })),
    /**
     * Resolves `User.secondFactors`.
     *
     * @param row - The user's row.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns What they have set up.
     */
    secondFactors: (row: UserRow, _args: unknown, ctx: Context) => {
      const { hasTotp, recoveryCodesLeft, passkeys } = ctx.factors.summary(row.id);
      return { hasTotp, recoveryCodesLeft, passkeyCount: passkeys.length };
    },
  },
  Query: {
    /**
     * Resolves `Query.profilePictures`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Whether pictures are on, and the largest upload.
     */
    profilePictures: (_parent: unknown, _args: unknown, ctx: Context) => ({
      isEnabled: ctx.pictures.isEnabled,
      maxBytes: PROFILE_DEFAULTS.maxPictureBytes,
    }),
    /**
     * Resolves `Query.viewer`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The signed-in admin.
     */
    viewer: (_parent: unknown, _args: unknown, ctx: Context, info: GraphQLResolveInfo): Promise<GeneratedRow> =>
      requiredRow(ctx, info, GeneratedTable.Users, userById(ctx.viewer.id)),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createUser`.
     *
     * @param _parent - Unused.
     * @param args - The user to add.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The new user.
     */
    createUser: async (_parent: unknown, args: { input: NewUser }, ctx: Context, info: GraphQLResolveInfo) => {
      const { password, username, name, email } = args.input;
      const hasPassword = password !== undefined && password !== null && password !== '';
      if (hasPassword) {
        await ctx.passwordPolicy.check(password, { username, name, email });
      }
      const user = await ctx.users.create(args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserCreated, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.updateUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new details.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The changed user.
     */
    updateUser: async (
      _parent: unknown,
      args: { id: string; input: UserFields },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = await ctx.users.update(args.id, args.input);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserUpdated, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.setUserPassword`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and new password.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    setUserPassword: async (
      _parent: unknown,
      args: { id: string; password: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const owner = loadUser(ctx, args.id);
      await ctx.passwordPolicy.check(args.password, owner);
      const user = await ctx.users.setPassword(args.id, args.password);
      await ctx.passwordLinks.cancelFor(user.id);
      recordAdminChange(ctx, AuditType.UserPasswordSet, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.deleteUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The removed user, as they were.
     */
    deleteUser: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.Users, userById(args.id));
      const user = await ctx.users.remove(args.id);
      await signOutEverywhere(ctx, user.id);
      await ctx.passwordLinks.cancelFor(user.id);
      await ctx.factors.removeAll(user.id);
      await ctx.upstreams.removeUser(user.id);
      await ctx.pictures.discard(user);
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.UserDeleted, userTarget(user));
      return row;
    },
    /**
     * Resolves `Mutation.setUserDisabled`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and whether to disable them.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    setUserDisabled: async (
      _parent: unknown,
      args: { id: string; disabled: boolean },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = await ctx.users.setDisabled(args.id, args.disabled);
      if (user.disabled) {
        await signOutEverywhere(ctx, user.id);
      }
      recordAdminChange(ctx, user.disabled ? AuditType.UserDisabled : AuditType.UserEnabled, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.endUserSession`.
     *
     * @param _parent - Unused.
     * @param args - The user's id and the session's.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     * @throws NOT_FOUND when the user has no such session.
     */
    endUserSession: async (
      _parent: unknown,
      args: { id: string; sessionId: string },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const user = loadUser(ctx, args.id);
      const isEnded = await ctx.sessions.endSession(user.id, args.sessionId, ctx.ip);
      if (isEnded === false) {
        throw notFound(`"${user.username}" has no session "${args.sessionId}".`);
      }
      recordAdminChange(ctx, AuditType.UserSessionEnded, userTarget(user), { sessionId: args.sessionId });
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.signOutUser`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    signOutUser: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const user = loadUser(ctx, args.id);
      await signOutEverywhere(ctx, user.id);
      recordAdminChange(ctx, AuditType.UserSignedOut, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.resetSecondFactors`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @param info - The field, for the row's selection.
     * @returns The user.
     */
    resetSecondFactors: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const user = loadUser(ctx, args.id);
      await ctx.factors.removeAll(user.id);
      recordAdminChange(ctx, AuditType.UserSecondFactorsReset, userTarget(user));
      return requiredRow(ctx, info, GeneratedTable.Users, userById(user.id));
    },
    /**
     * Resolves `Mutation.createPasswordLink`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The link and when it expires.
     */
    createPasswordLink: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ): Promise<{ url: string; expiresAt: string }> => {
      const user = loadUser(ctx, args.id);
      const { token, expiresAt } = await ctx.passwordLinks.issue(user.id);
      const url = `${adminUrls(ctx.issuer).base}${WEB_APP_PAGE.setPassword}#token=${token}`;
      // The URL holds the token, so only that a link was made is kept.
      recordAdminChange(ctx, AuditType.PasswordLinkCreated, userTarget(user));
      return { url, expiresAt: new Date(expiresAt).toISOString() };
    },
  },
};
