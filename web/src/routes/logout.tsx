import { createFileRoute } from '@tanstack/react-router';
import { CenteredLayout } from '@/components/centered-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LogOut } from '@/core/app-icons';
import { goBack, LOGOUT_CONFIRM_ACTION, logoutSearchSchema } from '@/provider/search';

export const Route = createFileRoute('/logout')({
  validateSearch: (search) => logoutSearchSchema.parse(search),
  component: LogoutPage,
});

const FORM_ID = 'logout-form';

/**
 * "Sign out of Heautou?" The provider sends a browser here when an app asks to sign its user out.
 *
 * @remarks
 * The form is a plain HTML form, not a `FormElement`: the provider answers the post with a redirect
 * back to the app, which only a real navigation follows. `xsrf` is the secret the provider checks to
 * know this page, and not another site, sent the post.
 */
function LogoutPage() {
  const { xsrf, client } = Route.useSearch();
  const where = client === undefined ? 'Heautou' : `${client} and Heautou`;

  return (
    <CenteredLayout
      level={1}
      iconSlot={<LogOut />}
      title="Sign out?"
      description={`You'll be signed out of ${where}. Other apps you signed in to with Heautou ask for your password again next time.`}
      contentSlot={
        xsrf === undefined ? (
          <Alert
            variant="destructive"
            title="This sign-out link is incomplete"
            description="Sign out from the app instead, so Heautou knows the request is genuine."
          />
        ) : (
          <form id={FORM_ID} method="post" action={LOGOUT_CONFIRM_ACTION}>
            <input type="hidden" name="xsrf" value={xsrf} />
          </form>
        )
      }
      footerActionsSlot={
        <>
          <Button variant="outline" content="Cancel" onClick={goBack} />
          {xsrf !== undefined && (
            <Button
              variant="destructive"
              type="submit"
              form={FORM_ID}
              name="logout"
              value="yes"
              content="Sign out"
              autoFocus
            />
          )}
        </>
      }
    />
  );
}
