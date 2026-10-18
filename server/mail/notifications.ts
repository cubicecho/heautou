import { type AuditEntry, type AuditLog, AuditTargetKind, AuditType, userTarget } from '../store/audit.ts';
import type { BrandingStore } from '../store/branding.ts';
import type { MailOptions } from '../store/mail.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import type { Mailer } from './mailer.ts';
import { factorContent, type MailContent, MailKind, passwordChangedContent } from './messages.ts';

/** Which user an entry is about: the one who did it, or the one it was done to. */
const Whose = { Actor: 'actor', Target: 'target' } as const;
type Whose = (typeof Whose)[keyof typeof Whose];

/** A notice one kind of audit entry sends. */
interface Notice {
  /** The option that turns it on. */
  option: keyof MailOptions;
  kind: MailKind;
  whose: Whose;
  /**
   * Words the notice.
   *
   * @param user - Who it goes to.
   * @param brandName - The provider's name.
   * @param entry - The entry, whose detail may name the passkey.
   * @returns What the email says, or null when this entry sends nothing.
   */
  content: (user: PublicUser, brandName: string, entry: AuditEntry) => MailContent | null;
}

/** An authenticator app, as a notice names it. */
const TOTP = 'An authenticator app';

/**
 * Names a passkey, as a notice names it.
 *
 * @param entry - The `passkey_added` or `passkey_removed` entry.
 * @returns `The passkey "Laptop"`, or "A passkey" when it has no name.
 */
function passkeyOf(entry: AuditEntry): string {
  const name = entry.detail?.name ?? '';
  return name === '' ? 'A passkey' : `The passkey "${name}"`;
}

/** The notice each kind of entry sends. A type not here sends none. */
const NOTICES: Partial<Record<AuditType, Notice>> = {
  [AuditType.AccountPasswordChanged]: {
    option: 'notifyPasswordChanged',
    kind: MailKind.PasswordChanged,
    whose: Whose.Actor,
    content: (user, brandName) => passwordChangedContent(user, brandName),
  },
  [AuditType.UserPasswordSet]: {
    option: 'notifyPasswordChanged',
    kind: MailKind.PasswordChanged,
    whose: Whose.Target,
    content: (user, brandName) => passwordChangedContent(user, brandName),
  },
  [AuditType.PasswordLinkUsed]: {
    option: 'notifyPasswordChanged',
    kind: MailKind.PasswordChanged,
    whose: Whose.Actor,
    // An invite sets the first password, which is nothing to warn about.
    content: (user, brandName, entry) =>
      entry.detail?.link === 'reset' ? passwordChangedContent(user, brandName) : null,
  },
  [AuditType.TotpAdded]: {
    option: 'notifyFactorAdded',
    kind: MailKind.FactorAdded,
    whose: Whose.Actor,
    content: (user, brandName) => factorContent(true, user, brandName, TOTP),
  },
  [AuditType.PasskeyAdded]: {
    option: 'notifyFactorAdded',
    kind: MailKind.FactorAdded,
    whose: Whose.Actor,
    content: (user, brandName, entry) => factorContent(true, user, brandName, passkeyOf(entry)),
  },
  [AuditType.TotpRemoved]: {
    option: 'notifyFactorRemoved',
    kind: MailKind.FactorRemoved,
    whose: Whose.Actor,
    content: (user, brandName) => factorContent(false, user, brandName, TOTP),
  },
  [AuditType.PasskeyRemoved]: {
    option: 'notifyFactorRemoved',
    kind: MailKind.FactorRemoved,
    whose: Whose.Actor,
    content: (user, brandName, entry) => factorContent(false, user, brandName, passkeyOf(entry)),
  },
  [AuditType.UserSecondFactorsReset]: {
    option: 'notifyFactorRemoved',
    kind: MailKind.FactorRemoved,
    whose: Whose.Target,
    content: (user, brandName) =>
      factorContent(false, user, brandName, 'Every second factor (authenticator app, passkeys and recovery codes)'),
  },
};

/**
 * Finds the user an entry is about.
 *
 * @param entry - The entry.
 * @param whose - Whether that is its actor or its target.
 * @returns Their id, or null when the entry names no user there.
 */
function userIdOf(entry: AuditEntry, whose: Whose): string | null {
  if (whose === Whose.Actor) {
    return entry.actor?.userId ?? null;
  }
  return entry.target?.kind === AuditTargetKind.User ? entry.target.id : null;
}

/** What the notifications are sent with. */
export interface NotificationDeps {
  audit: AuditLog;
  mailer: Mailer;
  users: UserStore;
  branding: BrandingStore;
}

/**
 * Emails a user when their password or second factors change, each kind only while its option is on. It follows
 * the audit log, so every route that records the change sends the notice.
 *
 * @param deps - The audit log, the mailer and the stores.
 * @returns A function that stops it.
 */
export function sendNotifications(deps: NotificationDeps): () => void {
  const { audit, mailer, users, branding } = deps;
  return audit.onRecord((entry) => {
    const notice = NOTICES[entry.type];
    if (notice === undefined || mailer.isOn(notice.option) === false) {
      return;
    }
    const userId = userIdOf(entry, notice.whose);
    const user = userId === null ? null : users.find(userId);
    if (user === null || user.email === '') {
      return;
    }
    const content = notice.content(user, branding.read().name, entry);
    if (content === null) {
      return;
    }
    mailer.sendInBackground(notice.kind, user.email, content, { actor: null, ip: null, target: userTarget(user) });
  });
}
