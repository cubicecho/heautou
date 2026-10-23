import { createTransport } from 'nodemailer';
import { adminUrls, WEB_APP_PAGE } from '../admin/admin-client.ts';
import { MAIL_DEFAULTS } from '../core/defaults.ts';
import { badInput, errorMessage } from '../core/errors.ts';
import { type AuditActor, type AuditLog, type AuditTarget, AuditType } from '../store/audit.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { MailOptions, MailServer, MailServerInput, MailStore } from '../store/mail.ts';
import { composeMail, type MailContent, type MailKind, type MailMessage } from './messages.ts';

/** Sends one message through an SMTP server. */
export interface MailTransport {
  /**
   * Sends a message.
   *
   * @param from - The sender.
   * @param message - The message.
   * @throws Whatever the server or the connection answered.
   */
  send: (from: string, message: MailMessage) => Promise<void>;
}

/** Makes the transport for a server. Tests pass a fake that keeps the messages. */
export type MailTransportFactory = (server: MailServer) => MailTransport;

/**
 * Sends through the server with nodemailer, one connection per message: the provider sends a few emails a day.
 *
 * @param server - The SMTP server.
 * @returns The transport.
 */
export const smtpTransport: MailTransportFactory = (server) => {
  const transporter = createTransport({
    host: server.host,
    port: server.port,
    secure: server.secure,
    auth: server.user === '' ? undefined : { user: server.user, pass: server.password ?? '' },
    connectionTimeout: MAIL_DEFAULTS.connectionTimeoutMs,
    greetingTimeout: MAIL_DEFAULTS.socketTimeoutMs,
    socketTimeout: MAIL_DEFAULTS.socketTimeoutMs,
  });
  return {
    send: async (from, message) => {
      await transporter.sendMail({ from, ...message });
    },
  };
};

/** Where the server email goes through comes from. */
export const MailSource = {
  /** `SMTP_URL` or `SMTP_HOST`: it wins, and Settings shows it locked. */
  Env: 'env',
  /** Saved under Settings. */
  Settings: 'settings',
  /** Nowhere: no email is sent. */
  None: 'none',
} as const;
export type MailSource = (typeof MailSource)[keyof typeof MailSource];

/** A server as Settings shows it: without its password. */
export type MailServerView = Omit<MailServer, 'password'> & { hasPassword: boolean };

/** Where email stands, for Settings. */
export interface MailStatus {
  source: MailSource;
  /** The server in use, or the saved one; null when there is none. */
  server: MailServerView | null;
  options: MailOptions;
}

/** Who an email is sent for, and what it is about, for its audit entry. */
export interface MailAudit {
  /** The admin who sent it, the user it is about, or null for the provider itself. */
  actor: AuditActor | null;
  ip: string | null;
  target?: AuditTarget;
}

/** Sends the provider's emails, and keeps the SMTP settings. */
export interface Mailer {
  /**
   * Says where email stands.
   *
   * @returns The source, the server without its password, and the options.
   */
  status: () => MailStatus;
  /**
   * Says whether email can be sent.
   *
   * @returns True when the environment or Settings names a server.
   */
  isConfigured: () => boolean;
  /**
   * Says whether an optional email is on. Each one also needs a server.
   *
   * @param option - The option, such as `forgotPassword`.
   * @returns True when there is a server and the operator turned the option on.
   */
  isOn: (option: keyof MailOptions) => boolean;
  /**
   * Saves the server under Settings.
   *
   * @param input - The server; a blank password keeps the saved one.
   * @returns The server.
   * @throws BAD_USER_INPUT while the environment sets the server, or for a server the store refuses.
   */
  setServer: (input: MailServerInput) => Promise<MailServer>;
  /**
   * Forgets the server saved under Settings.
   *
   * @throws BAD_USER_INPUT while the environment sets the server.
   */
  removeServer: () => Promise<void>;
  /**
   * Changes the options.
   *
   * @param changes - The options to change.
   * @returns The options.
   */
  setOptions: (changes: Partial<MailOptions>) => Promise<MailOptions>;
  /**
   * Sends an email and records it as `mail_sent`, or as `mail_failed` with the error.
   *
   * @param kind - What it is for.
   * @param to - Where it goes.
   * @param content - What it says.
   * @param audit - Who it is for, for the audit entry.
   * @throws BAD_USER_INPUT when no server is set up, and the transport's error when sending fails.
   */
  send: (kind: MailKind, to: string, content: MailContent, audit: MailAudit) => Promise<void>;
  /**
   * Sends an email without waiting, for the ones nobody is there to see fail. A failure is only recorded.
   *
   * @param kind - What it is for.
   * @param to - Where it goes.
   * @param content - What it says.
   * @param audit - Who it is for, for the audit entry.
   */
  sendInBackground: (kind: MailKind, to: string, content: MailContent, audit: MailAudit) => void;
}

/** What the mailer is built from. */
export interface MailerDeps {
  store: MailStore;
  /** The server the environment sets, which wins over Settings, or null. */
  envServer: MailServer | null;
  transport: MailTransportFactory;
  branding: BrandingStore;
  audit: AuditLog;
}

/** Where the mailer reports a background email it could not record. */
const LOG_TAG = '[mail]';

/**
 * Hides a server's password.
 *
 * @param server - The server.
 * @returns It as Settings shows it.
 */
function viewOf(server: MailServer): MailServerView {
  const { password, ...rest } = server;
  return { ...rest, hasPassword: password !== null };
}

/**
 * Builds the link a password link's token opens.
 *
 * @param issuer - The provider's public URL.
 * @param token - The link's token. It goes in the fragment, which never reaches a server's logs.
 * @param [uid] - The sign-in it was asked for from, which the page goes back to when it is still open.
 * @returns The URL.
 */
export function passwordLinkUrl(issuer: string, token: string, uid?: string): string {
  const fragment = new URLSearchParams({ token, ...(uid === undefined ? {} : { uid }) });
  return `${adminUrls(issuer).base}${WEB_APP_PAGE.setPassword}#${fragment.toString()}`;
}

/**
 * Builds the mailer.
 *
 * @param deps - The stores, the environment's server and the transport.
 * @returns The mailer.
 */
export function createMailer(deps: MailerDeps): Mailer {
  const { store, envServer, transport, branding, audit } = deps;
  const isLocked = envServer !== null;
  const server = (): MailServer | null => envServer ?? store.server();
  const refuseWhenLocked = (): void => {
    if (isLocked) {
      throw badInput('The SMTP server is set by SMTP_URL or SMTP_HOST. Change it there.');
    }
  };

  const send = async (kind: MailKind, to: string, content: MailContent, about: MailAudit): Promise<void> => {
    const current = server();
    if (current === null) {
      throw badInput('Email is not set up. Set up an SMTP server under Settings first.');
    }
    const message = composeMail(to, content, branding.read());
    try {
      await transport(current).send(current.from, message);
      audit.record({ type: AuditType.MailSent, ...about, detail: { kind, to } });
    } catch (error) {
      // The error is the server's or the connection's answer; the message, which may hold a link, is not kept.
      audit.record({ type: AuditType.MailFailed, ...about, detail: { kind, to, error: errorMessage(error) } });
      throw error;
    }
  };

  return {
    status: () => {
      const current = server();
      const source = isLocked ? MailSource.Env : current === null ? MailSource.None : MailSource.Settings;
      return { source, server: current === null ? null : viewOf(current), options: store.options() };
    },
    isConfigured: () => server() !== null,
    isOn: (option) => server() !== null && store.options()[option],
    setServer: async (input) => {
      refuseWhenLocked();
      return store.setServer(input);
    },
    removeServer: async () => {
      refuseWhenLocked();
      await store.removeServer();
    },
    setOptions: store.setOptions,
    send,
    sendInBackground: (kind, to, content, about) => {
      send(kind, to, content, about).catch((error: unknown) => {
        // Already recorded as `mail_failed`; this is for the server log, without the message.
        console.warn(LOG_TAG, `could not send the ${kind} email:`, errorMessage(error));
      });
    },
  };
}
