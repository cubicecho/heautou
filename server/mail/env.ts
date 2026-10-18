import { readFileSync } from 'node:fs';
import { MAIL_DEFAULTS } from '../core/defaults.ts';
import { isSender, type MailServer } from '../store/mail.ts';

/** The URL schemes `SMTP_URL` may have: STARTTLS when offered, or TLS from the first byte. */
const SMTP_SCHEME = 'smtp:';
const SMTPS_SCHEME = 'smtps:';
/** What `SMTP_SECURE` reads as on. */
const TRUE_WORDS = new Set(['true', '1', 'yes']);
/** Digits only. */
const PORT_PATTERN = /^\d+$/;
/** Highest TCP port. */
const MAX_PORT = 65_535;

/**
 * Reads a variable, or the file its `_FILE` variable names (a Docker secret). The file wins.
 *
 * @param env - The environment.
 * @param name - The variable, such as `SMTP_PASSWORD`.
 * @returns The value, trimmed of a trailing newline, or an empty string when neither is set.
 */
function valueOrFile(env: NodeJS.ProcessEnv, name: string): string {
  const filePath = (env[`${name}_FILE`] ?? '').trim();
  if (filePath !== '') {
    return readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  }
  return env[name] ?? '';
}

/**
 * Reads a port.
 *
 * @param raw - The text, such as `SMTP_PORT`.
 * @param name - Where it came from, for the error.
 * @returns The port, or null when the text is empty.
 * @throws When it is not a number from 1 to 65535.
 */
function portOf(raw: string, name: string): number | null {
  const text = raw.trim();
  if (text === '') {
    return null;
  }
  const port = Number(text);
  const isPort = PORT_PATTERN.test(text) && port >= 1 && port <= MAX_PORT;
  if (isPort === false) {
    throw new Error(`${name} is "${text}". Expected a port from 1 to ${MAX_PORT}, such as ${MAIL_DEFAULTS.port}.`);
  }
  return port;
}

/**
 * Reads the server from `SMTP_URL`.
 *
 * @param raw - The URL, such as `smtp://user:password@mail.example.home:587`.
 * @returns The server's connection, without the sender.
 * @throws When it is not an smtp:// or smtps:// URL with a host.
 */
function serverFromUrl(raw: string): Omit<MailServer, 'from'> {
  const isUrl = URL.canParse(raw);
  const url = isUrl ? new URL(raw) : null;
  const isSmtp = url !== null && (url.protocol === SMTP_SCHEME || url.protocol === SMTPS_SCHEME) && url.hostname !== '';
  if (url === null || isSmtp === false) {
    // The URL may hold the password, so it is not repeated.
    throw new Error(
      'SMTP_URL is not an smtp:// or smtps:// URL with a host. Expected, for example, SMTP_URL=smtp://user:password@mail.example.home:587.',
    );
  }
  const secure = url.protocol === SMTPS_SCHEME;
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port: portOf(url.port, 'The port in SMTP_URL') ?? (secure ? MAIL_DEFAULTS.implicitTlsPort : MAIL_DEFAULTS.port),
    secure,
    user: decodeURIComponent(url.username),
    password: password === '' ? null : password,
  };
}

/**
 * Reads the SMTP server the environment sets. When it sets one, it wins over Settings, which then shows it locked.
 *
 * @param [env] - The environment.
 * @returns The server, or null when neither `SMTP_URL` (or `SMTP_URL_FILE`) nor `SMTP_HOST` is set.
 * @throws With a sentence naming the variable, when one is malformed or `SMTP_FROM` is missing.
 */
export function mailServerFromEnv(env: NodeJS.ProcessEnv = process.env): MailServer | null {
  const url = valueOrFile(env, 'SMTP_URL').trim();
  const host = (env.SMTP_HOST ?? '').trim();
  if (url === '' && host === '') {
    return null;
  }
  const from = (env.SMTP_FROM ?? '').trim();
  if (isSender(from) === false) {
    throw new Error(
      `SMTP_FROM is "${from}". With ${url === '' ? 'SMTP_HOST' : 'SMTP_URL'} set it is required: the address email is sent from, such as SMTP_FROM="Heautou <auth@example.home>".`,
    );
  }
  if (url !== '') {
    return { ...serverFromUrl(url), from };
  }
  const port = portOf(env.SMTP_PORT ?? '', 'SMTP_PORT');
  const secureText = (env.SMTP_SECURE ?? '').trim().toLowerCase();
  const secure = secureText === '' ? port === MAIL_DEFAULTS.implicitTlsPort : TRUE_WORDS.has(secureText);
  const password = valueOrFile(env, 'SMTP_PASSWORD');
  return {
    host,
    port: port ?? (secure ? MAIL_DEFAULTS.implicitTlsPort : MAIL_DEFAULTS.port),
    secure,
    user: (env.SMTP_USER ?? '').trim(),
    password: password === '' ? null : password,
    from,
  };
}
