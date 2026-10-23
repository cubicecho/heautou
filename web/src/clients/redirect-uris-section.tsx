import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { messageOf } from '@/core/errors';
import { useHttpRedirects, useSetHttpRedirects } from '@/core/settings';

/**
 * Whether clients may be sent back to plain http redirect URIs.
 */
export function RedirectUrisSection() {
  const setting = useHttpRedirects();
  const save = useSetHttpRedirects();
  const current = setting.data;
  const issuerNote = current?.isIssuerHttp
    ? 'Left alone it follows the issuer, which is plain http, so it is allowed.'
    : 'Left alone it follows the issuer, which is https, so it is refused.';

  return (
    <Section
      title="Redirect URIs"
      description="Where an application may be sent back to after a sign-in or sign-out. https is always allowed, and so is plain http on localhost."
      surface="card"
      contentSlot={
        <div className="grid gap-4">
          {setting.isError && (
            <QueryError error={setting.error} onRetry={setting.refetch} what="the redirect URI setting" />
          )}
          <SettingRow
            title="Allow plain http"
            description={`Lets a client be saved with an http:// redirect URI on any host. Clients saved before it was turned off keep working, and are marked in the list. ${issuerNote}`}
            actionSlot={({ titleId }) => (
              <div className="flex items-center gap-2">
                {current?.isSet && (
                  <Button
                    variant="ghost"
                    size="sm"
                    content="Follow the issuer"
                    disabled={save.isPending}
                    onClick={() => save.mutate(null)}
                  />
                )}
                <Switch
                  aria-labelledby={titleId}
                  checked={current?.isAllowed ?? false}
                  disabled={current === undefined || save.isPending}
                  onCheckedChange={(checked) => save.mutate(checked)}
                />
              </div>
            )}
          />
          {save.error !== null && (
            <Alert variant="destructive" title="Setting not saved" description={messageOf(save.error)} />
          )}
        </div>
      }
    />
  );
}
