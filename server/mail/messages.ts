import type { Branding } from '../store/branding.ts';

/** What an email is for. It is the `kind` detail of the audit entry that records it. */
export const MailKind = {
  /** An admin sent an invite link. */
  Invite: 'invite',
  /** An admin sent a password reset link. */
  Reset: 'reset',
  /** The user asked for a reset link on the sign-in page. */
  ForgotPassword: 'forgot_password',
  /** An admin's test from Settings. */
  Test: 'test',
  PasswordChanged: 'password_changed',
  /** An authenticator app or a passkey was added. */
  FactorAdded: 'factor_added',
  /** A second factor was removed, or an admin reset them all. */
  FactorRemoved: 'factor_removed',
} as const;
export type MailKind = (typeof MailKind)[keyof typeof MailKind];

/** A file sent with an email, such as the logo the HTML part shows. */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  /** The id the HTML part refers to it by, as `cid:<id>`. */
  cid: string;
}

/** One email, ready to hand to the transport. The sender is the server's. */
export interface MailMessage {
  to: string;
  subject: string;
  /** The plain-text part, which every mail client can show. */
  text: string;
  /** The HTML part: the same words, the brand's logo and a button for the link. */
  html: string;
  attachments: MailAttachment[];
}

/** What a message says: its paragraphs, and the link it carries, if any. */
export interface MailContent {
  subject: string;
  /** Plain sentences; each is a paragraph. */
  paragraphs: string[];
  /** A link to press, shown as a button in HTML and on its own line in text. */
  action?: { label: string; url: string };
  /** A closing line in smaller type, such as "If it wasn't you, …". */
  footnote?: string;
}

/** The id the logo is attached under. */
const LOGO_CID = 'logo@heautou';
/** How the logo's file is named in the email, by type. */
const LOGO_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
/** The logo's size in the HTML part, in CSS pixels. */
const LOGO_SIZE_PX = 40;

/** The characters HTML gives a meaning, and what each is written as. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes text for an HTML element or a quoted attribute.
 *
 * @param text - Any text, such as a brand name or a URL.
 * @returns The text with `&`, `<`, `>`, `"` and `'` escaped.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Lays out an email in plain text and HTML, under the brand's name and logo.
 *
 * @param to - Where it goes.
 * @param content - What it says.
 * @param branding - The provider's name and logo.
 * @returns The message.
 */
export function composeMail(to: string, content: MailContent, branding: Branding): MailMessage {
  const { subject, paragraphs, action, footnote } = content;
  const name = escapeHtml(branding.name);
  const text = [
    branding.name,
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(action === undefined ? [] : [`${action.label}: ${action.url}`, '']),
    ...(footnote === undefined ? [] : [footnote]),
  ]
    .join('\n')
    .trimEnd();
  const logo = branding.logo;
  const logoTag =
    logo === null
      ? ''
      : `<img src="cid:${LOGO_CID}" alt="" width="${LOGO_SIZE_PX}" height="${LOGO_SIZE_PX}" style="vertical-align:middle;margin-right:8px">`;
  const button =
    action === undefined
      ? ''
      : `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#111;color:#fff;text-decoration:none">${escapeHtml(action.label)}</a></p>` +
        `<p style="font-size:12px;color:#555;word-break:break-all">${escapeHtml(action.url)}</p>`;
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
    `<p style="font-size:18px;font-weight:600">${logoTag}${name}</p>`,
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    button,
    footnote === undefined ? '' : `<p style="font-size:12px;color:#555">${escapeHtml(footnote)}</p>`,
    '</body></html>',
  ].join('');
  const attachments: MailAttachment[] =
    logo === null
      ? []
      : [
          {
            filename: `logo.${LOGO_EXTENSIONS[logo.type] ?? 'img'}`,
            content: Buffer.from(logo.data, 'base64'),
            contentType: logo.type,
            cid: LOGO_CID,
          },
        ];
  // A header is one line: a name with a line break in it must not start another header.
  return { to, subject: subject.replace(/[\r\n]+/g, ' '), text, html, attachments };
}

/** A user, as an email names them. */
interface Recipient {
  username: string;
  name: string;
}

/**
 * Greets a user by name, or by username when they have none.
 *
 * @param user - The user.
 * @returns "Hello Ada,".
 */
function greeting(user: Recipient): string {
  return `Hello ${user.name.trim() === '' ? user.username : user.name},`;
}

/** The closing line of a notice: what to do when it was not them. */
const NOT_YOU = 'If this was not you, tell your administrator at once.';

/**
 * Words an invite or a reset link.
 *
 * @param kind - An admin's invite or reset, or a reset the user asked for.
 * @param user - Whose link it is.
 * @param brandName - The provider's name.
 * @param url - The link.
 * @param expiresAt - When it stops working.
 * @returns What the email says.
 */
export function passwordLinkContent(
  kind: typeof MailKind.Invite | typeof MailKind.Reset | typeof MailKind.ForgotPassword,
  user: Recipient,
  brandName: string,
  url: string,
  expiresAt: Date,
): MailContent {
  const until = `The link works once, until ${expiresAt.toUTCString()}.`;
  if (kind === MailKind.Invite) {
    return {
      subject: `Your ${brandName} account`,
      paragraphs: [
        greeting(user),
        `An account was made for you on ${brandName}, with the username ${user.username}. Choose a password to start using it.`,
        until,
      ],
      action: { label: 'Choose a password', url },
    };
  }
  return {
    subject: `Reset your ${brandName} password`,
    paragraphs: [
      greeting(user),
      kind === MailKind.ForgotPassword
        ? `Someone asked to reset the password of ${user.username} on ${brandName}.`
        : `An administrator sent you a link to choose a new password for ${user.username} on ${brandName}.`,
      `${until} Your current password keeps working until you use it.`,
    ],
    action: { label: 'Choose a new password', url },
    footnote: kind === MailKind.ForgotPassword ? 'If you did not ask for this, you can ignore this email.' : undefined,
  };
}

/**
 * Words the test email.
 *
 * @param brandName - The provider's name.
 * @returns What the email says.
 */
export function testContent(brandName: string): MailContent {
  return {
    subject: `Test email from ${brandName}`,
    paragraphs: [`This is a test from ${brandName}'s settings. Email is set up and working.`],
  };
}

/**
 * Words the notice that a user's password changed.
 *
 * @param user - Whose it was.
 * @param brandName - The provider's name.
 * @returns What the email says.
 */
export function passwordChangedContent(user: Recipient, brandName: string): MailContent {
  return {
    subject: `Your ${brandName} password was changed`,
    paragraphs: [greeting(user), `The password of ${user.username} on ${brandName} was just changed.`],
    footnote: NOT_YOU,
  };
}

/**
 * Words the notice that a second factor was added to or removed from a user's account.
 *
 * @param isAdded - Added, or removed.
 * @param user - Whose account it is.
 * @param brandName - The provider's name.
 * @param what - What it was, such as "An authenticator app" or `The passkey "Laptop"`.
 * @returns What the email says.
 */
export function factorContent(isAdded: boolean, user: Recipient, brandName: string, what: string): MailContent {
  const change = isAdded ? 'added to' : 'removed from';
  return {
    subject: `${what} was ${change} your ${brandName} account`,
    paragraphs: [greeting(user), `${what} was just ${change} ${user.username} on ${brandName}.`],
    footnote: NOT_YOU,
  };
}
