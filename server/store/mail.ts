import { z } from 'zod';
import { MAIL_DEFAULTS } from '../core/defaults.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import type { SecretMapper } from './sealed-document.ts';

/** Highest TCP port. */
const MAX_PORT = 65_535;

/** An SMTP server email is sent through, with the address it is sent from. */
export interface MailServer {
  host: string;
  port: number;
  /** TLS from the first byte (SMTPS, usually port 465). Off, the connection is upgraded with STARTTLS when offered. */
  secure: boolean;
  /** The SMTP user. Empty sends without signing in. */
  user: string;
  /** The SMTP password. Null without one. Sealed under `SECRET_KEY` on disk. */
  password: string | null;
  /** The sender, such as `Heautou <auth@example.home>`. */
  from: string;
}

/** Which optional emails the operator turned on. Each is off until they do. */
export interface MailOptions {
  /** A "Forgot password?" link on the sign-in page that emails a reset link. */
  forgotPassword: boolean;
  /** Email a user when their password changes. */
  notifyPasswordChanged: boolean;
  /** Email a user when an authenticator app or a passkey is added to their account. */
  notifyFactorAdded: boolean;
  /** Email a user when a second factor is removed, by them or by an admin's reset. */
  notifyFactorRemoved: boolean;
}

/** Every option off: email only goes out when an admin sends a link or a test. */
export const MAIL_OPTIONS_OFF: Readonly<MailOptions> = Object.freeze({
  forgotPassword: false,
  notifyPasswordChanged: false,
  notifyFactorAdded: false,
  notifyFactorRemoved: false,
});

/** The `mail` document: the server saved under Settings, and the options. */
export interface MailDocument {
  server?: MailServer;
  options?: Partial<MailOptions>;
}

/** A server as Settings saves it. The password left out, null or blank keeps the saved one. */
export interface MailServerInput {
  host: string;
  port?: number | null;
  secure?: boolean | null;
  user?: string | null;
  password?: string | null;
  from: string;
}

/**
 * Finds the SMTP password in the mail document.
 *
 * @param document - The document.
 * @param change - What to do to the password.
 * @returns The document with the password changed.
 */
export const mailSecretsIn: SecretMapper<MailDocument> = (document, change) => {
  const server = document.server;
  if (server === undefined || typeof server.password !== 'string') {
    return document;
  }
  return { ...document, server: { ...server, password: change(server.password) } };
};

/** A sender: an address, or a name with the address in angle brackets. */
const SENDER_PATTERN = /^(?:[^<>\r\n]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/;

/**
 * Checks a sender address the way Settings and `SMTP_FROM` take it.
 *
 * @param from - The sender.
 * @returns Whether it is an address, or a name and an address in angle brackets.
 */
export function isSender(from: string): boolean {
  return SENDER_PATTERN.test(from.trim());
}

const field = z.string().trim().max(MAIL_DEFAULTS.maxFieldLength);
const serverSchema = z.object({
  host: field.min(1, 'name the SMTP server'),
  port: z.number().int().min(1).max(MAX_PORT, `a port is 1 to ${MAX_PORT}`).nullish(),
  secure: z.boolean().nullish(),
  user: field.nullish(),
  password: z.string().nullish(),
  from: field.refine(isSender, 'give an address, such as auth@example.home or "Heautou <auth@example.home>"'),
});
const optionsSchema = z.object({
  forgotPassword: z.boolean().optional(),
  notifyPasswordChanged: z.boolean().optional(),
  notifyFactorAdded: z.boolean().optional(),
  notifyFactorRemoved: z.boolean().optional(),
});

/** The SMTP server saved under Settings and the email options, kept in one document. */
export interface MailStore {
  /**
   * Reads the server saved under Settings.
   *
   * @returns It, or null when none is saved.
   */
  server: () => MailServer | null;
  /**
   * Saves the server.
   *
   * @param input - The server. A port left out follows `secure`; a password left out or blank keeps the saved one.
   * @returns The server.
   * @throws BAD_USER_INPUT for a missing host, a port out of range or a sender that is not an address.
   */
  setServer: (input: MailServerInput) => Promise<MailServer>;
  /**
   * Forgets the saved server, so email is off unless the environment sets one.
   */
  removeServer: () => Promise<void>;
  /**
   * Reads the options.
   *
   * @returns Each option, off while unset.
   */
  options: () => MailOptions;
  /**
   * Changes the options.
   *
   * @param changes - The options to change; one left out keeps its value.
   * @returns The options.
   */
  setOptions: (changes: Partial<MailOptions>) => Promise<MailOptions>;
}

/**
 * Opens the mail store on its document.
 *
 * @param document - The document, sealed so the password is plain in memory only. Missing, there is no server and every
 * option is off.
 * @returns The store.
 */
export function createMailStore(document: DataDocument<MailDocument>): MailStore {
  const options = (): MailOptions => ({ ...MAIL_OPTIONS_OFF, ...document.read().options });
  return {
    server: () => document.read().server ?? null,
    setServer: async (input) => {
      const parsed = parseInput(serverSchema, input);
      const secure = parsed.secure ?? parsed.port === MAIL_DEFAULTS.implicitTlsPort;
      const port = parsed.port ?? (secure ? MAIL_DEFAULTS.implicitTlsPort : MAIL_DEFAULTS.port);
      const typed = parsed.password ?? '';
      const saved = document.read().server?.password ?? null;
      const server: MailServer = {
        host: parsed.host,
        port,
        secure,
        user: parsed.user ?? '',
        password: typed === '' ? saved : typed,
        from: parsed.from,
      };
      await document.update((current) => ({ ...current, server }));
      return server;
    },
    removeServer: async () => {
      await document.update(({ server: _removed, ...rest }) => rest);
    },
    options,
    setOptions: async (changes) => {
      const parsed = parseInput(optionsSchema, changes);
      const given = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
      await document.update((current) => ({ ...current, options: { ...current.options, ...given } }));
      return options();
    },
  };
}
