import { useState } from 'react';
import type { ForwardAuthFieldsFragment, ProtectedSiteFieldsFragment } from '@/__generated__/graphql';
import { Combobox } from '@/components/combobox';
import { FieldRow } from '@/components/field-row';
import { FormField } from '@/components/form-field';
import { EmptyState } from '@/components/page';
import { Section } from '@/components/section';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import {
  BACKEND_PLACEHOLDER,
  isTested,
  PROXIES,
  PROXY_KINDS,
  type ProxyKind,
  parseUpstream,
  proxySnippet,
  type SnippetSite,
} from '@/sites/proxy-snippets';

/** The site picker's value for every site at once. */
const ALL_SITES = 'all';

/**
 * A backend to replace, named after the host's first label so each host's is told apart.
 *
 * @param host - The site's host.
 * @returns The placeholder.
 */
function placeholderBackend(host: string): string {
  return `<${host.split('.')[0] ?? host}-backend>:8080`;
}

/**
 * Heautou's address as the browser sees it, from the verify URL the server reports.
 *
 * @param verifyUrl - The verify endpoint.
 * @returns The origin and the host, or the URL itself when it does not parse.
 */
function publicAddress(verifyUrl: string): { origin: string; hostname: string } {
  try {
    const url = new URL(verifyUrl);
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return { origin: verifyUrl, hostname: verifyUrl };
  }
}

/**
 * What the page says under the snippet about which endpoint it uses and whether it was tested.
 *
 * @param kind - The proxy.
 * @param sites - The sites the snippet covers.
 * @returns The note.
 */
function noteFor(kind: ProxyKind, sites: readonly SnippetSite[]): string {
  const proxy = PROXIES[kind];
  const uses = `Uses ${proxy.endpoint}: ${proxy.why}`;
  if (isTested(kind, sites)) {
    return `${uses} Run end to end with this configuration.`;
  }
  if (proxy.testedWholeHost) {
    return `${uses} The whole-host form was run end to end; the path prefix lines are untested.`;
  }
  return `${uses} Untested here; it follows the shape Authelia documents.`;
}

/**
 * The proxy setup helper: pick the proxy and a site, and get a configuration to paste, filled in with this
 * instance's addresses. The text comes from `proxy-snippets.ts`, which the tests hold to docs/forward-auth.md.
 *
 * @param props - Forward auth's settings and the sites.
 * @param props.settings - As the server reports them.
 * @param props.sites - The protected sites.
 */
export function ProxySnippet({
  settings,
  sites,
}: {
  settings: ForwardAuthFieldsFragment;
  sites: readonly ProtectedSiteFieldsFragment[];
}) {
  const heautou = publicAddress(settings.verifyUrl);
  const [kind, setKind] = useState<ProxyKind>('haproxy');
  const [siteId, setSiteId] = useState<string>(ALL_SITES);
  const [upstreamText, setUpstreamText] = useState(heautou.origin);
  const [backend, setBackend] = useState(BACKEND_PLACEHOLDER);

  const chosen = sites.find((site) => site.id === siteId);
  const covered = chosen === undefined ? sites : [chosen];
  const snippetSites: SnippetSite[] = covered.map((site) => ({
    host: site.host,
    pathPrefix: site.pathPrefix,
    backend: chosen === undefined ? placeholderBackend(site.host) : backend.trim() || BACKEND_PLACEHOLDER,
  }));
  const upstream = parseUpstream(upstreamText);
  const files =
    upstream === null || snippetSites.length === 0
      ? []
      : proxySnippet(kind, { upstream, heautouHost: heautou.hostname, sites: snippetSites });
  const siteOptions = [
    { value: ALL_SITES, label: 'All sites' },
    ...sites.map((site) => ({ value: site.id, label: site.name, meta: `${site.host}${site.pathPrefix}` })),
  ];

  return (
    <Section
      title="Config snippet"
      level={3}
      description="A configuration for your proxy with this instance's addresses filled in. Replace the placeholders in angle brackets, and add your TLS settings."
      contentSlot={
        <div className="grid gap-4">
          <FieldRow
            contentSlot={
              <>
                <FormField
                  asGroup
                  label="Proxy"
                  controlSlot={(props) => (
                    <SegmentedGroup {...props} value={kind} onValueChange={setKind}>
                      {PROXY_KINDS.map((proxy) => (
                        <SegmentedButton key={proxy} value={proxy}>
                          {PROXIES[proxy].label}
                        </SegmentedButton>
                      ))}
                    </SegmentedGroup>
                  )}
                />
                <FormField
                  label="Sites"
                  controlSlot={(props) => (
                    <Combobox
                      {...props}
                      options={siteOptions}
                      value={chosen === undefined ? ALL_SITES : chosen.id}
                      disabled={sites.length === 0}
                      onValueChange={setSiteId}
                    />
                  )}
                />
              </>
            }
          />
          <FieldRow
            contentSlot={
              <>
                <FormField
                  label="Heautou, from the proxy"
                  description="Where the proxy reaches Heautou directly, not through itself, such as http://heautou:3000 on a Docker network."
                  error={
                    upstream === null
                      ? 'An http or https address such as http://heautou:3000, with no path.'
                      : undefined
                  }
                  controlSlot={
                    <Input
                      value={upstreamText}
                      onChangeText={setUpstreamText}
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  }
                />
                {chosen === undefined ? null : (
                  <FormField
                    label="App backend"
                    description={`Where the proxy reaches ${chosen.name}, as host:port.`}
                    controlSlot={
                      <Input
                        value={backend}
                        onChangeText={setBackend}
                        className="font-mono"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    }
                  />
                )}
              </>
            }
          />
          {sites.length === 0 ? (
            <EmptyState compact title="Add a protected site to get a snippet for it." />
          ) : (
            <>
              {files.map((file) => (
                <CodeBlock
                  key={file.title}
                  title={file.title}
                  language={file.language}
                  content={file.content}
                  maxHeight="lg"
                  actionSlot={<CopyButton value={file.content} label={`Copy ${file.title}`} />}
                />
              ))}
              <p className="text-foreground/60 text-sm">{noteFor(kind, snippetSites)}</p>
            </>
          )}
        </div>
      }
    />
  );
}
