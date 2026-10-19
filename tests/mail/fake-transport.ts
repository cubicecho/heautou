import type { MailTransportFactory } from '../../server/mail/mailer.ts';
import type { MailMessage } from '../../server/mail/messages.ts';
import type { MailServer } from '../../server/store/mail.ts';

/** One message the fake transport was handed. */
export interface SentMail extends MailMessage {
  from: string;
  /** The server it would have gone through. */
  server: MailServer;
}

/** A transport that keeps what it is handed instead of sending it. */
export interface FakeTransport {
  factory: MailTransportFactory;
  sent: SentMail[];
  /** While set, every send fails with this message, as an unreachable server would. */
  failWith: string | null;
}

/** An SMTP server as Settings saves it, for the tests. */
export const TEST_SERVER = {
  host: 'mail.example.home',
  port: 587,
  user: 'heautou',
  password: 'smtp secret',
  from: 'Heautou <auth@example.home>',
};

/**
 * Makes a fake transport for the services' `mailTransport`.
 *
 * @returns The transport and what it was handed.
 */
export function createFakeTransport(): FakeTransport {
  const fake: FakeTransport = {
    sent: [],
    failWith: null,
    factory: (server) => ({
      send: async (from, message) => {
        if (fake.failWith !== null) {
          throw new Error(fake.failWith);
        }
        fake.sent.push({ ...message, from, server });
      },
    }),
  };
  return fake;
}

/** How long `waitFor` keeps trying, in milliseconds. */
const WAIT_MS = 2000;
/** How often it tries, in milliseconds. */
const POLL_MS = 10;

/**
 * Waits for something sent after a reply, such as a forgot-password email.
 *
 * @param check - True once it has happened.
 * @throws When it has not within two seconds.
 */
export async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + WAIT_MS;
  while (check() === false) {
    if (Date.now() > until) {
      throw new Error('It never happened.');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
