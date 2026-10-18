import { createFileRoute, Link } from '@tanstack/react-router';
import { LinkedAccountsSection } from '@/account/linked-accounts';
import { ProfilePictureSection } from '@/account/profile-picture';
import { TwoFactorSection } from '@/account/two-factor';
import { auditTypeLabel } from '@/activity/audit-types';
import { useAppForm } from '@/components/app-form';
import { CenteredLayout } from '@/components/centered-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { EmptyState } from '@/components/page';
import { PasswordField } from '@/components/password-field';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { Spinner } from '@/components/ui/spinner';
import { useAccount, useAccountActivity, useChangePassword, useSignOutEverywhere } from '@/core/account';
import { signOut } from '@/core/admin';
import { LogOut } from '@/core/app-icons';
import { BrandIcon, useBrandName } from '@/core/brand';
import { messageOf } from '@/core/lists';
import { formatAgo, formatDateTime, joinStats } from '@/lib/format';
import { PasswordStrengthMeter } from '@/passwords/strength-meter';
import { passwordProblem } from '@/users/user-form-dialog';

export const Route = createFileRoute('/account')({ component: AccountPage });

const PASSWORD_FORM_ID = 'password-form';

/**
 * Changes the signed-in user's password. The current one is asked for, so a browser left signed in is not enough.
 */
function ChangePassword() {
  const change = useChangePassword();
  const account = useAccount();
  const { username = '', name = '', email = '' } = account.data ?? {};
  const form = useAppForm({
    defaultValues: { currentPassword: '', newPassword: '' },
    onSubmit: async ({ value, formApi }) => {
      await change.mutateAsync(value);
      formApi.reset();
    },
  });

  return (
    <Section
      title="Password"
      contentSlot={
        <FormElement id={PASSWORD_FORM_ID} onSubmit={() => form.handleSubmit()} className="grid gap-4">
          <PasswordField
            form={form}
            name="currentPassword"
            label="Current password"
            required
            autoComplete="current-password"
          />
          <PasswordField
            form={form}
            name="newPassword"
            label="New password"
            required
            autoComplete="new-password"
            validators={{ onChange: ({ value }) => passwordProblem(value) }}
          />
          <form.Subscribe selector={(state) => state.values.newPassword}>
            {(password) => <PasswordStrengthMeter password={password} owner={[username, name, email]} />}
          </form.Subscribe>
          {change.error === null ? null : (
            <Alert variant="destructive" title="Password not changed" description={messageOf(change.error)} />
          )}
          {change.isSuccess ? (
            <Alert variant="info" description="Your password is changed. Signed-in browsers stay signed in." />
          ) : null}
          <div className="flex justify-end">
            <form.AppForm>
              <form.SubmitButton variant="outline" content="Change password" />
            </form.AppForm>
          </div>
        </FormElement>
      }
    />
  );
}

/**
 * The signed-in user's recent sign-ins, failed ones too, so a guess at their password shows.
 */
function RecentSignIns() {
  const activity = useAccountActivity();
  const entries = activity.data ?? [];

  return (
    <Section
      title="Recent sign-ins"
      description="Where your account signed in lately, and the attempts that failed."
      contentSlot={
        activity.isError ? (
          <QueryError error={activity.error} onRetry={activity.refetch} what="your sign-ins" />
        ) : activity.isPending ? (
          <Spinner />
        ) : (
          <div className="grid gap-2">
            {entries.length === 0 ? <EmptyState compact title="No sign-ins recorded yet." /> : null}
            <List
              label="Recent sign-ins"
              contentSlot={entries.map((entry) => (
                <ListItem
                  key={entry.id}
                  title={joinStats(auditTypeLabel(entry.type), entry.clientName)}
                  description={joinStats(formatDateTime(entry.at), entry.ip !== null && `from ${entry.ip}`)}
                  meta={formatAgo(entry.at)}
                />
              ))}
            />
          </div>
        )
      }
    />
  );
}

/**
 * A user's own page: who they are, their password and where they are signed in. Every user can reach it, not only
 * admins.
 */
function AccountPage() {
  const account = useAccount();
  const signOutEverywhere = useSignOutEverywhere();
  const brandName = useBrandName();
  const me = account.data;

  return (
    <CenteredLayout
      level={1}
      iconSlot={<BrandIcon className="size-5" />}
      title={me === undefined ? 'Your account' : me.name || me.username}
      description={`Your ${brandName} account, which signs you in to its applications.`}
      cardClassName="max-w-lg"
      contentSlot={
        me === undefined ? (
          account.isError ? (
            <QueryError error={account.error} onRetry={account.refetch} what="your account" />
          ) : (
            <Spinner />
          )
        ) : (
          <div className="grid gap-6">
            <DescriptionList
              contentSlot={[
                <PropertyRow key="username" label="Username" value={me.username} valueClassName="font-mono" />,
                <PropertyRow key="email" label="Email" value={me.email || '—'} />,
                <PropertyRow key="groups" label="Groups" value={me.groups.join(', ') || '—'} />,
              ]}
            />
            <ProfilePictureSection />
            <ChangePassword />
            <TwoFactorSection />
            <LinkedAccountsSection />
            <RecentSignIns />
            <Section
              title="Where you are signed in"
              description="Each browser signed in as you. Signing out everywhere ends them all, this one too."
              contentSlot={
                <div className="grid gap-2">
                  {me.sessions.length === 0 ? <EmptyState compact title="Not signed in anywhere else." /> : null}
                  <List
                    label="Sessions"
                    contentSlot={me.sessions.map((session) => (
                      <ListItem
                        key={session.id}
                        title={session.clientNames.join(', ') || 'No applications yet'}
                        description={joinStats(
                          session.signedInAt && `Signed in ${formatAgo(session.signedInAt)}`,
                          session.expiresAt && `ends ${formatDateTime(session.expiresAt)}`,
                        )}
                      />
                    ))}
                  />
                  {signOutEverywhere.error === null ? null : (
                    <Alert
                      variant="destructive"
                      title="Not signed out"
                      description={messageOf(signOutEverywhere.error)}
                    />
                  )}
                </div>
              }
            />
          </div>
        )
      }
      footerActionsSlot={
        me === undefined ? undefined : (
          <>
            <ConfirmButton
              variant="destructive-outline"
              content="Sign out everywhere"
              title="Sign out everywhere?"
              description="Every browser and application signed in as you has to sign in again, this one too."
              confirmLabel="Sign out"
              onConfirm={() => signOutEverywhere.mutate()}
            />
            <Button variant="outline" iconSlot={<LogOut />} content="Sign out" onClick={signOut} />
            {me.isAdmin ? <Button variant="info" content="Admin" linkSlot={<Link to="/" />} /> : null}
          </>
        )
      }
    />
  );
}
