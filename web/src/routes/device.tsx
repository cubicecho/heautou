import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { CenteredLayout } from '@/components/centered-layout';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CircleCheck } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { MonitorSmartphone } from '@/core/app-icons';
import { useBrandName } from '@/core/brand';
import { DEVICE_ACTION, deviceSearchSchema } from '@/provider/search';

export const Route = createFileRoute('/device')({
  validateSearch: (search) => deviceSearchSchema.parse(search),
  component: DevicePage,
});

const FORM_ID = 'device-form';

/** The steps the provider sends the browser back here for. With none, the page asks for the code. */
const STEP_CONFIRM = 'confirm';
const STEP_DONE = 'done';

/** What the page says when the provider asks for the code again, by the reason it gives. */
const ERROR_COPY: Readonly<Record<string, { title: string; description: string }>> = {
  no_code: { title: 'Type the code', description: 'Type the code the device shows.' },
  not_found: { title: 'That code was not found', description: 'Check the code the device shows and type it again.' },
  expired: { title: 'That code has expired', description: 'Start again on the device to get a new code.' },
  used: { title: 'That code has been used', description: 'Start again on the device to get a new code.' },
};
const FALLBACK_ERROR = { title: 'Something went wrong', description: 'Type the code again.' };
/** The user cancelled: not a failure, so it is said quietly. */
const ABORTED = 'aborted';

/**
 * The device flow's page (RFC 8628): a device with no browser of its own, such as Home Assistant, shows a code and
 * this address. The user types the code here, signs in, and confirms.
 *
 * @remarks
 * The forms are plain HTML forms posted to the provider's `/device`, which answers with a redirect back here, to the
 * sign-in, or to the next step, as the logout page's form does. `xsrf` is the secret the provider checks to know this
 * page sent the post; with none (someone typed the address) the page fetches one by going to the provider's
 * `/device` first, which sends the browser straight back.
 */
function DevicePage() {
  const { step, xsrf, user_code: userCode, client, error } = Route.useSearch();
  const brandName = useBrandName();
  const needsSecret = step !== STEP_DONE && xsrf === undefined;

  useEffect(() => {
    if (needsSecret) {
      const query = userCode === undefined ? '' : `?${new URLSearchParams({ user_code: userCode })}`;
      window.location.replace(`${DEVICE_ACTION}${query}`);
    }
  }, [needsSecret, userCode]);

  if (step === STEP_DONE) {
    return (
      <CenteredLayout
        level={1}
        iconSlot={<CircleCheck />}
        title="Device connected"
        description={`${client ?? 'The device'} is signed in with your ${brandName} account. You can close this tab and go back to it.`}
      />
    );
  }

  if (needsSecret) {
    return (
      <CenteredLayout level={1} iconSlot={<MonitorSmartphone />} title="Connect a device" contentSlot={<Spinner />} />
    );
  }

  const secretInput = <input type="hidden" name="xsrf" value={xsrf} />;

  if (step === STEP_CONFIRM) {
    return (
      <CenteredLayout
        level={1}
        iconSlot={<MonitorSmartphone />}
        title={`Connect ${client ?? 'this device'}?`}
        description={`It will be signed in with your ${brandName} account. Check that the device shows this code; if it doesn't, or you didn't start this, cancel.`}
        contentSlot={
          <form id={FORM_ID} method="post" action={DEVICE_ACTION} className="flex justify-center">
            {secretInput}
            <input type="hidden" name="user_code" value={userCode ?? ''} />
            <span className="rounded-md bg-foreground/10 px-4 py-2 font-mono text-2xl tracking-widest">{userCode}</span>
          </form>
        }
        footerActionsSlot={
          <>
            <Button variant="outline" type="submit" form={FORM_ID} name="abort" value="yes" content="Cancel" />
            <Button
              variant="positive"
              type="submit"
              form={FORM_ID}
              name="confirm"
              value="yes"
              content="Continue"
              autoFocus
            />
          </>
        }
      />
    );
  }

  const wasAborted = error === ABORTED;
  const failure = error === undefined || wasAborted ? null : (ERROR_COPY[error] ?? FALLBACK_ERROR);
  return (
    <CenteredLayout
      level={1}
      iconSlot={<MonitorSmartphone />}
      title="Connect a device"
      description="Type the code the device shows. You'll sign in next if you haven't already."
      contentSlot={
        <form id={FORM_ID} method="post" action={DEVICE_ACTION} className="flex flex-col gap-4">
          {secretInput}
          <FormField
            label="Code"
            controlSlot={
              <Input
                name="user_code"
                defaultValue={userCode ?? ''}
                placeholder="BCDF-GHJK"
                className="text-center font-mono uppercase tracking-widest"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                autoFocus
              />
            }
          />
          {wasAborted && <Alert variant="info" title="Cancelled" description="The device was not connected." />}
          {failure !== null && <Alert variant="destructive" title={failure.title} description={failure.description} />}
        </form>
      }
      footerActionsSlot={<Button type="submit" form={FORM_ID} content="Continue" />}
    />
  );
}
