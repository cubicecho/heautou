import { useEffect } from 'react';
import type { UserFieldsFragment } from '@/__generated__/graphql';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Spinner } from '@/components/ui/spinner';
import { useCreatePasswordLink } from '@/core/admin';
import { Mail } from '@/core/app-icons';
import { messageOf } from '@/core/lists';
import { useEmailPasswordLink, useMail } from '@/core/mail';
import { formatDateTime } from '@/lib/format';

interface PasswordLinkDialogProps {
  user: UserFieldsFragment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Makes a link that sets a user's password, for the admin to copy or, once email is set up and the user has an
 * address, to send by email. It invites a user who has no password yet and resets one who forgot theirs. Opening
 * it again, or sending it, makes a new link and ends the old one; the link shown is always the one that works.
 *
 * @param props - The user and the dialog's open state.
 */
export function PasswordLinkDialog({ user, open, onOpenChange }: PasswordLinkDialogProps) {
  const { mutate, data: made, error, isPending } = useCreatePasswordLink();
  const email = useEmailPasswordLink();
  const mail = useMail();
  const isInvite = user.hasPassword === false;
  const canEmail = mail.data?.isConfigured === true && user.email !== '';
  const link = email.data?.link ?? made;
  const sendFailure = email.data?.error ?? null;

  useEffect(() => {
    mutate(user.id);
  }, [mutate, user.id]);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isInvite ? `Invite ${user.username}` : `Reset ${user.username}'s password`}
      description={
        isInvite
          ? 'Send them this link. It lets them choose a password, once, and then sign in.'
          : 'Send them this link. It lets them choose a new password, once. Their current one works until then.'
      }
      contentSlot={
        <div className="grid gap-4">
          {isPending ? <Spinner /> : null}
          {link === undefined ? null : (
            <DescriptionList
              contentSlot={[
                <PropertyRow
                  key="url"
                  label="Link"
                  value={link.url}
                  valueClassName="font-mono break-all"
                  actionSlot={
                    <>
                      <CopyButton value={link.url} label="Copy link" />
                      {canEmail ? (
                        <Button
                          aria-label={`Send by email to ${user.email}`}
                          hint={`Send by email to ${user.email}`}
                          variant="ghost"
                          size="icon-sm"
                          iconSlot={<Mail />}
                          loading={email.isPending}
                          onClick={() => email.mutate(user.id)}
                        />
                      ) : null}
                    </>
                  }
                />,
                <PropertyRow key="expires" label="Works until" value={formatDateTime(link.expiresAt)} />,
              ]}
            />
          )}
          {error === null ? null : <Alert variant="destructive" title="No link made" description={messageOf(error)} />}
          {email.data === undefined || sendFailure !== null ? null : (
            <Alert
              variant="info"
              title="Sent"
              description={`The link above went to ${email.data.sentTo}. The one shown before stopped working.`}
            />
          )}
          {sendFailure === null ? null : (
            <Alert
              variant="destructive"
              title="Email not sent"
              description={`${sendFailure} The link above still works: copy it instead.`}
            />
          )}
          {email.error === null ? null : (
            <Alert variant="destructive" title="Email not sent" description={messageOf(email.error)} />
          )}
          <Alert
            variant="info"
            description="Anyone with the link can set the password, so send it to them directly. Making another link ends this one."
          />
        </div>
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Done" />}
    />
  );
}
