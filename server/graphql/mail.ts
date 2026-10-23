import type { Context } from '../core/context.ts';
import { badInput, errorMessage, notFound } from '../core/errors.ts';
import { type MailServerView, MailSource, passwordLinkUrl } from '../mail/mailer.ts';
import { MailKind, passwordLinkContent, testContent } from '../mail/messages.ts';
import {
  type AuditEvent,
  type AuditTarget,
  AuditTargetKind,
  AuditType,
  actorOf,
  recordAdminChange,
  userTarget,
} from '../store/audit.ts';
import type { MailOptions, MailServerInput } from '../store/mail.ts';
import type { PublicUser } from '../store/users.ts';

/** The email part of the admin schema: the SMTP server, the options, the test and sending a password link. */
export const MAIL_TYPE_DEFS = /* GraphQL */ `
  "Where the SMTP server email is sent through is set."
  enum MailSource {
    "SMTP_URL or SMTP_HOST. It wins over Settings, and cannot be changed there."
    ENV
    "Saved under Settings."
    SETTINGS
    "Nowhere: no email is sent, and links are copied by hand."
    NONE
  }

  "An SMTP server, without its password."
  type MailServer {
    host: String!
    port: Int!
    "TLS from the first byte (SMTPS). Off, STARTTLS is used when the server offers it."
    secure: Boolean!
    "Empty sends without signing in."
    user: String!
    hasPassword: Boolean!
    "The sender, such as Heautou <auth@example.home>."
    from: String!
  }

  "Email: the server, and the optional emails, each off until turned on."
  type MailSettings {
    source: MailSource!
    "Whether email can be sent."
    isConfigured: Boolean!
    "The server in use. Null when there is none."
    server: MailServer
    "A Forgot password? link on the sign-in page, which emails a reset link."
    forgotPassword: Boolean!
    "Email a user when their password changes."
    notifyPasswordChanged: Boolean!
    "Email a user when an authenticator app or a passkey is added to their account."
    notifyFactorAdded: Boolean!
    "Email a user when a second factor is removed, by them or by an admin's reset."
    notifyFactorRemoved: Boolean!
  }

  "An SMTP server to save under Settings."
  input MailServerInput {
    host: String!
    "Left out, 465 when secure and 587 otherwise."
    port: Int
    "Left out, on for port 465."
    secure: Boolean
    user: String
    "Left out, null or blank keeps the saved password."
    password: String
    from: String!
  }

  "A password link that was emailed, or that could not be."
  type SentPasswordLink {
    "The link, which works whether or not the email went."
    link: PasswordLink!
    "The address it was sent to."
    sentTo: String!
    "Why the email was not sent. Null when it was."
    error: String
  }

  extend type Query {
    "The SMTP server and the email options."
    mail: MailSettings!
  }

  extend type Mutation {
    "Saves the SMTP server. Refused while SMTP_URL or SMTP_HOST sets it."
    setMailServer(input: MailServerInput!): MailSettings!
    "Removes the SMTP server saved under Settings. Refused while SMTP_URL or SMTP_HOST sets it."
    removeMailServer: MailSettings!
    "Turns the optional emails on or off. One left out keeps its value."
    setMailOptions(
      forgotPassword: Boolean
      notifyPasswordChanged: Boolean
      notifyFactorAdded: Boolean
      notifyFactorRemoved: Boolean
    ): MailSettings!
    "Sends a test email, to the signed-in admin's address unless another is given. Returns where it went."
    sendTestEmail(to: String): String!
    "Makes a user's invite or reset link, as createPasswordLink does, and emails it to them."
    emailPasswordLink(id: ID!): SentPasswordLink!
  }
`;

/** What `MailSettings` resolves from. */
interface MailSettingsView extends MailOptions {
  source: string;
  isConfigured: boolean;
  server: MailServerView | null;
}

/** Each source as the `MailSource` enum names it. */
const SOURCE_NAME: Record<MailSource, string> = {
  [MailSource.Env]: 'ENV',
  [MailSource.Settings]: 'SETTINGS',
  [MailSource.None]: 'NONE',
};

/** What the email settings are recorded against. */
const MAIL_TARGET: AuditTarget = Object.freeze({ kind: AuditTargetKind.Settings, id: 'mail', name: 'Email' });

/** A loose check that an address can be mailed; the SMTP server has the last word. */
const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;

/**
 * Describes email for Settings.
 *
 * @param ctx - Request context.
 * @returns What `MailSettings` resolves from.
 */
function settingsView(ctx: Context): MailSettingsView {
  const { source, server, options } = ctx.mail.status();
  return { ...options, source: SOURCE_NAME[source], isConfigured: server !== null, server };
}

/**
 * Records what the signed-in admin changed, and passes the value on.
 *
 * @param ctx - Request context.
 * @param type - What they did.
 * @param value - What the resolver returns.
 * @param [detail] - What else to keep. Never the password.
 * @returns The value.
 */
function audited<T>(ctx: Context, type: AuditType, value: T, detail?: AuditEvent['detail']): T {
  recordAdminChange(ctx, type, MAIL_TARGET, detail);
  return value;
}

/**
 * Finds a user by id.
 *
 * @param ctx - Request context.
 * @param id - The user's id.
 * @returns The user.
 * @throws NOT_FOUND when there is none.
 */
function loadUser(ctx: Context, id: string): PublicUser {
  const user = ctx.users.find(id);
  if (user === null) {
    throw notFound(`No user has the ID "${id}".`);
  }
  return user;
}

/** The email resolvers, merged with the rest of the schema's. */
export const mailResolvers = {
  Query: {
    /**
     * Resolves `Query.mail`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The email settings.
     */
    mail: (_parent: unknown, _args: unknown, ctx: Context): MailSettingsView => settingsView(ctx),
  },
  Mutation: {
    /**
     * Resolves `Mutation.setMailServer`.
     *
     * @param _parent - Unused.
     * @param args - The server.
     * @param ctx - Request context.
     * @returns The email settings.
     */
    setMailServer: async (
      _parent: unknown,
      args: { input: MailServerInput },
      ctx: Context,
    ): Promise<MailSettingsView> => {
      const isNewPassword = (args.input.password ?? '') !== '';
      const server = await ctx.mail.setServer(args.input);
      return audited(ctx, AuditType.MailServerSet, settingsView(ctx), {
        host: `${server.host}:${server.port}`,
        password: isNewPassword ? 'replaced' : 'kept',
      });
    },
    /**
     * Resolves `Mutation.removeMailServer`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The email settings.
     */
    removeMailServer: async (_parent: unknown, _args: unknown, ctx: Context): Promise<MailSettingsView> => {
      await ctx.mail.removeServer();
      return audited(ctx, AuditType.MailServerRemoved, settingsView(ctx));
    },
    /**
     * Resolves `Mutation.setMailOptions`.
     *
     * @param _parent - Unused.
     * @param args - The options to change.
     * @param ctx - Request context.
     * @returns The email settings.
     */
    setMailOptions: async (_parent: unknown, args: Partial<MailOptions>, ctx: Context): Promise<MailSettingsView> => {
      const changes = Object.fromEntries(
        Object.entries(args).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      );
      await ctx.mail.setOptions(changes);
      const detail = Object.fromEntries(Object.entries(changes).map(([name, isOn]) => [name, isOn ? 'on' : 'off']));
      return audited(ctx, AuditType.MailOptionsSet, settingsView(ctx), detail);
    },
    /**
     * Resolves `Mutation.sendTestEmail`.
     *
     * @param _parent - Unused.
     * @param args - Where to send it; left out, the admin's own address.
     * @param ctx - Request context.
     * @returns The address it went to.
     * @throws BAD_USER_INPUT with no address, and the SMTP server's error when it was not sent.
     */
    sendTestEmail: async (_parent: unknown, args: { to?: string | null }, ctx: Context): Promise<string> => {
      const to = (args.to ?? '').trim() || ctx.viewer.email;
      if (ADDRESS_PATTERN.test(to) === false) {
        throw badInput('Give an address to send the test to: your account has none.');
      }
      try {
        await ctx.mail.send(MailKind.Test, to, testContent(ctx.branding.read().name), {
          actor: actorOf(ctx.viewer),
          ip: ctx.ip,
          target: MAIL_TARGET,
        });
      } catch (error) {
        throw badInput(`The test email was not sent: ${errorMessage(error)}`);
      }
      return to;
    },
    /**
     * Resolves `Mutation.emailPasswordLink`.
     *
     * @param _parent - Unused.
     * @param args - The user's id.
     * @param ctx - Request context.
     * @returns The link, where it was sent, and why not when it was not.
     * @throws BAD_USER_INPUT when email is not set up or the user has no address.
     */
    emailPasswordLink: async (
      _parent: unknown,
      args: { id: string },
      ctx: Context,
    ): Promise<{ link: { url: string; expiresAt: string }; sentTo: string; error: string | null }> => {
      const user = loadUser(ctx, args.id);
      if (ctx.mail.isConfigured() === false) {
        throw badInput('Email is not set up. Set up an SMTP server under Settings first.');
      }
      if (user.email === '') {
        throw badInput(`"${user.username}" has no email address. Add one, or copy the link instead.`);
      }
      const { token, expiresAt } = await ctx.passwordLinks.issue(user.id);
      const url = passwordLinkUrl(ctx.issuer, token);
      const kind = user.hasPassword ? MailKind.Reset : MailKind.Invite;
      const content = passwordLinkContent(kind, user, ctx.branding.read().name, url, new Date(expiresAt));
      // The URL holds the token, so only that a link was made is kept.
      recordAdminChange(ctx, AuditType.PasswordLinkCreated, userTarget(user), { sent: 'email' });
      let error: string | null = null;
      try {
        await ctx.mail.send(kind, user.email, content, {
          actor: actorOf(ctx.viewer),
          ip: ctx.ip,
          target: userTarget(user),
        });
      } catch (caught) {
        error = errorMessage(caught);
      }
      return { link: { url, expiresAt: new Date(expiresAt).toISOString() }, sentTo: user.email, error };
    },
  },
};
