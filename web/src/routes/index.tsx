import { createFileRoute } from '@tanstack/react-router';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { PageLayout } from '@/components/page-layout';
import { QueryError } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { CopyButton } from '@/components/ui/copy-button';
import { useProviderInfo } from '@/core/admin';

export const Route = createFileRoute('/')({ component: OverviewPage });

/** Endpoints an application may be configured with one by one, under the issuer. */
const ENDPOINTS = [
  { label: 'Authorization', path: '/auth' },
  { label: 'Token', path: '/token' },
  { label: 'User info', path: '/me' },
  { label: 'JWKS', path: '/jwks' },
  { label: 'End session', path: '/session/end' },
] as const;

/**
 * One URL as a row, with a copy button.
 *
 * @param props - What the URL is called, and the URL.
 */
function UrlRow({ label, url, hint }: { label: string; url: string; hint?: string }) {
  return (
    <PropertyRow
      label={label}
      value={url}
      hint={hint}
      valueClassName="font-mono break-all"
      actionSlot={<CopyButton value={url} label={`Copy ${label.toLowerCase()} URL`} />}
    />
  );
}

/**
 * What an application needs to be pointed at this provider.
 */
function OverviewPage() {
  const query = useProviderInfo();
  const info = query.data;

  return (
    <PageLayout
      title="Overview"
      description="Point an application at the issuer below. Most only need the discovery URL, a client ID and a secret."
      width="prose"
      loading={query.isPending}
      contentClassName="gap-6"
      contentSlot={
        <>
          <Alert
            variant="warning"
            title="Keep this admin page on a trusted network"
            description="It has no sign-in of its own, and the data directory holds client secrets and signing keys in plain text."
          />
          {query.isError ? <QueryError error={query.error} onRetry={query.refetch} what="the provider's URLs" /> : null}
          {info === undefined ? null : (
            <>
              <Section
                title="Provider"
                contentSlot={
                  <DescriptionList
                    contentSlot={[
                      <UrlRow key="issuer" label="Issuer" url={info.issuer} />,
                      <UrlRow
                        key="discovery"
                        label="Discovery"
                        url={info.discoveryUrl}
                        hint="Applications that support OpenID Connect discovery need only this."
                      />,
                      <PropertyRow
                        key="scopes"
                        label="Scopes"
                        value={info.scopes.join(' ')}
                        valueClassName="font-mono"
                      />,
                    ]}
                  />
                }
              />
              <Section
                title="Endpoints"
                description="For applications that ask for each URL on its own."
                contentSlot={
                  <DescriptionList
                    contentSlot={ENDPOINTS.map(({ label, path }) => (
                      <UrlRow key={path} label={label} url={`${info.issuer}${path}`} />
                    ))}
                  />
                }
              />
            </>
          )}
        </>
      }
    />
  );
}
