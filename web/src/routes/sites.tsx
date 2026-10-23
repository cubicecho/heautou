import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import type { ForwardAuthFieldsFragment, ProtectedSiteFieldsFragment } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { DescriptionList, PropertyRow } from '@/components/description-list';
import { Disclosure } from '@/components/disclosure';
import { DisclosureRow } from '@/components/disclosure-row';
import { List } from '@/components/list';
import { EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { QueryError, QueryState } from '@/components/query-state';
import { Section } from '@/components/section';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { ExternalLink, ShieldCheck } from '@/core/app-icons';
import { messageOf } from '@/core/errors';
import {
  useDeleteProtectedSite,
  useForwardAuth,
  useProtectedSites,
  useSetForwardAuthCookieDomain,
} from '@/core/protected-sites';
import { formatDateTime } from '@/lib/format';
import { ProxySnippet } from '@/sites/proxy-snippet';
import { SiteFormDialog } from '@/sites/site-form-dialog';

export const Route = createFileRoute('/sites')({ component: SitesPage });

/** Which dialog is up: none, a new site, or one site's edit. */
type Editing = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; site: ProtectedSiteFieldsFragment };

/**
 * One address to copy into the proxy's configuration.
 *
 * @param props - The row's label, the address and what it is for.
 * @param props.label - What the row is called.
 * @param props.value - The address.
 * @param props.hint - Which proxies use it.
 */
function AddressRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <PropertyRow
      label={label}
      value={value}
      hint={hint}
      valueClassName="font-mono break-all"
      actionSlot={<CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />}
    />
  );
}

/**
 * The cookie domain, as a small form, or read-only when the environment sets it.
 *
 * @param props - Forward auth's settings.
 * @param props.settings - As the server reports them.
 */
function CookieDomainForm({ settings }: { settings: ForwardAuthFieldsFragment }) {
  const save = useSetForwardAuthCookieDomain();
  const form = useAppForm({
    defaultValues: { domain: settings.cookieDomain ?? '' },
    onSubmit: async ({ value, formApi }) => {
      const saved = await save.mutateAsync(value.domain.trim() === '' ? null : value.domain.trim());
      formApi.reset({ domain: saved.cookieDomain ?? '' });
    },
  });

  if (settings.isCookieDomainFromEnvironment) {
    return (
      <PropertyRow
        label="Cookie domain"
        value={settings.cookieDomain ?? ''}
        hint="Set by FORWARD_AUTH_COOKIE_DOMAIN. Change it there."
        valueClassName="font-mono"
      />
    );
  }
  return (
    <div className="grid gap-2">
      <FormElement onSubmit={() => form.handleSubmit()} className="flex flex-wrap items-end gap-2">
        <InputField
          form={form}
          name="domain"
          label="Cookie domain"
          className="min-w-48 flex-1"
          placeholder="home.lan"
          autoComplete="off"
          description="The parent domain of Heautou and the sites, so one sign-in covers them all. Blank keeps the cookie on Heautou's own host."
        />
        <form.AppForm>
          <form.SubmitButton variant="outline" content="Save domain" />
        </form.AppForm>
      </FormElement>
      {save.error !== null && (
        <Alert variant="destructive" title="Domain not saved" description={messageOf(save.error)} />
      )}
    </div>
  );
}

/** The forward auth guide in the repository, which the snippets are held to. */
const FORWARD_AUTH_GUIDE = 'https://github.com/cubicecho/heautou/blob/main/docs/forward-auth.md';

/**
 * What the reverse proxy is pointed at, the cookie domain, and a configuration to paste, behind a disclosure that
 * starts open while there is something left to set up.
 *
 * @param props - The sites, for the snippet.
 * @param props.sites - The protected sites.
 */
function ProxySetupSection({ sites }: { sites: readonly ProtectedSiteFieldsFragment[] }) {
  const query = useForwardAuth();
  const settings = query.data;
  if (query.isError) {
    return <QueryError error={query.error} onRetry={query.refetch} what="the proxy setup" />;
  }
  if (settings === undefined) {
    return null;
  }
  const hasCookieDomain = settings.cookieDomain !== null && settings.cookieDomain !== undefined;
  const lacksCookieDomain = hasCookieDomain === false;
  const isSetUp = sites.length > 0 && hasCookieDomain;

  return (
    <Section
      surface="card"
      contentSlot={
        <Disclosure
          title="Proxy setup"
          titleClassName="text-foreground"
          description="Point the reverse proxy's forward auth at these addresses, from where it reaches Heautou, or paste the snippet below."
          defaultOpen={isSetUp === false}
          actionSlot={
            <Button
              variant="outline"
              size="sm"
              iconSlot={<ExternalLink />}
              content="Guide"
              linkSlot={
                <a
                  href={FORWARD_AUTH_GUIDE}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="The forward auth guide, on GitHub"
                />
              }
            />
          }
          contentClassName="gap-4 pt-2"
          contentSlot={
            <>
              <DescriptionList
                contentSlot={[
                  <AddressRow
                    key="verify"
                    label="Verify endpoint"
                    value={settings.verifyUrl}
                    hint="Answers 401 to send the browser to sign in: nginx."
                  />,
                  <AddressRow
                    key="redirect"
                    label="Verify with redirect"
                    value={settings.verifyRedirectUrl}
                    hint="Answers a browser with a redirect to sign in: HAProxy, Caddy and Traefik."
                  />,
                  <AddressRow
                    key="sign-out"
                    label="Sign-out link"
                    value={settings.signOutUrl}
                    hint="Signs the user out of every protected site and of Heautou."
                  />,
                  <PropertyRow
                    key="trusted"
                    label="Trusted proxies"
                    value={
                      settings.trustedProxies === null || settings.trustedProxies === undefined
                        ? 'This machine, and those TRUST_PROXY trusts'
                        : settings.trustedProxies.join(', ')
                    }
                    hint="Only these may ask about a request. Set FORWARD_AUTH_TRUSTED_PROXIES to your proxy's address."
                  />,
                ]}
              />
              <CookieDomainForm key={settings.cookieDomain ?? ''} settings={settings} />
              {lacksCookieDomain && (
                <Alert
                  variant="warning"
                  title="No cookie domain"
                  description="Only sites on Heautou's own host share the sign-in. Set the domain the sites and Heautou have in common, such as home.lan."
                />
              )}
              <ProxySnippet settings={settings} sites={sites} />
            </>
          }
        />
      }
    />
  );
}

/**
 * Where a site is: its host and path prefix.
 *
 * @param site - The site.
 * @returns The address.
 */
function addressOf(site: ProtectedSiteFieldsFragment): string {
  return `${site.host}${site.pathPrefix}`;
}

/**
 * The protected sites, with add, edit and delete, and the proxy's setup.
 */
function SitesPage() {
  const query = useProtectedSites();
  const remove = useDeleteProtectedSite();
  const sites = query.data ?? [];
  const isLoaded = query.isPending === false;
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ kind: 'closed' });
  const isFormOpen = editing.kind !== 'closed';
  const close = (next: boolean): void => {
    if (next === false) {
      setEditing({ kind: 'closed' });
    }
  };
  const newSite = (
    <Button
      variant="info"
      size="sm"
      iconSlot={<Plus />}
      content="New site"
      onClick={() => setEditing({ kind: 'new' })}
    />
  );

  return (
    <PageLayout
      title="Protected sites"
      description="Sites behind your reverse proxy that have no sign-in of their own. The proxy asks Heautou about each request (forward auth) and sends the browser here to sign in."
      actionSlot={newSite}
      contentClassName="gap-4"
      contentSlot={
        <>
          {remove.error !== null && (
            <Alert variant="destructive" title="Site not deleted" description={messageOf(remove.error)} />
          )}
          <QueryState
            query={query}
            what="the protected sites"
            count={sites.length}
            emptySlot={
              <EmptyState
                iconSlot={<ShieldCheck />}
                title="No protected sites yet"
                description="Add one for each host, or host and path, the proxy should ask about. The proxy refuses requests to anything not listed."
                actionSlot={newSite}
              />
            }
          />
          <List
            label="Protected sites"
            contentSlot={sites.map((site) => (
              <DisclosureRow
                key={site.id}
                open={openId === site.id}
                onOpenChange={(next) => setOpenId(next ? site.id : null)}
                title={site.name}
                meta={
                  <>
                    <span className="font-mono text-foreground/60 text-xs">{addressOf(site)}</span>
                    {site.allowedGroups.length > 0 && <Badge variant="secondary">Limited</Badge>}
                    {site.requireSecondFactor && <Badge variant="outline">Second factor</Badge>}
                  </>
                }
                actionSlot={
                  <>
                    <Button
                      aria-label={`Edit ${site.name}`}
                      variant="outline"
                      size="icon-sm"
                      iconSlot={<Pencil />}
                      onClick={() => setEditing({ kind: 'edit', site })}
                    />
                    <ConfirmButton
                      aria-label={`Delete ${site.name}`}
                      variant="destructive-outline"
                      size="icon-sm"
                      iconSlot={<Trash2 />}
                      title={`Delete ${site.name}?`}
                      description="The proxy refuses every request to it until it is added again."
                      onConfirm={() => remove.mutate(site.id)}
                    />
                  </>
                }
                contentSlot={
                  <DescriptionList
                    contentSlot={[
                      <PropertyRow key="host" label="Host" value={site.host} valueClassName="font-mono" />,
                      <PropertyRow
                        key="path"
                        label="Path prefix"
                        value={site.pathPrefix === '' ? 'The whole host' : site.pathPrefix}
                        valueClassName={site.pathPrefix === '' ? undefined : 'font-mono'}
                      />,
                      <PropertyRow
                        key="groups"
                        label="Allowed groups"
                        value={site.allowedGroups.length === 0 ? 'Every user' : site.allowedGroups.join(', ')}
                      />,
                      <PropertyRow
                        key="factor"
                        label="Second factor"
                        value={site.requireSecondFactor ? 'Required' : 'Not required'}
                      />,
                      <PropertyRow key="added" label="Added" value={formatDateTime(site.createdAt)} />,
                    ]}
                  />
                }
              />
            ))}
          />
          {/* Drawn once the sites are in, since whether it starts open depends on them. */}
          {isLoaded && <ProxySetupSection sites={sites} />}
          {isFormOpen && (
            <SiteFormDialog
              key={editing.kind === 'edit' ? editing.site.id : 'new'}
              site={editing.kind === 'edit' ? editing.site : null}
              open={isFormOpen}
              onOpenChange={close}
              onSaved={(saved) => setOpenId(saved.id)}
            />
          )}
        </>
      }
    />
  );
}
