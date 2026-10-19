/**
 * Forward auth configuration for the reverse proxies docs/forward-auth.md covers, built from this instance's values.
 *
 * Pure functions from facts to text: the Protected sites page shows what they return, and
 * `tests/web/proxy-snippets.test.ts` checks that, for the doc's example, they return the doc's snippets word for word,
 * so the page and the doc cannot drift apart.
 */

/** The proxies there is a snippet for, in the order the page offers them. */
export const PROXY_KINDS = ['haproxy', 'nginx', 'caddy', 'traefik'] as const;

/** One of {@link PROXY_KINDS}. */
export type ProxyKind = (typeof PROXY_KINDS)[number];

/** What the page says about each proxy. */
export const PROXIES: Readonly<
  Record<ProxyKind, { label: string; endpoint: string; why: string; testedWholeHost: boolean }>
> = {
  haproxy: {
    label: 'HAProxy',
    endpoint: '/auth/verify?redirect=1',
    why: 'The haproxy-auth-request Lua script hands a 302 to HAProxy, which redirects.',
    testedWholeHost: true,
  },
  nginx: {
    label: 'nginx',
    endpoint: '/auth/verify',
    why: 'nginx takes only 2xx, 401 and 403 from an auth subrequest, and turns the 401 into a redirect itself.',
    testedWholeHost: true,
  },
  caddy: {
    label: 'Caddy',
    endpoint: '/auth/verify?redirect=1',
    why: 'Caddy passes any answer other than 2xx, a 302 included, back to the browser.',
    testedWholeHost: false,
  },
  traefik: {
    label: 'Traefik',
    endpoint: '/auth/verify?redirect=1',
    why: 'Traefik passes any answer other than 2xx, a 302 included, back to the browser.',
    testedWholeHost: false,
  },
};

/** The verify endpoint, answering 401 when nobody is signed in. */
const VERIFY_PATH = '/auth/verify';
/** The verify endpoint, answering a browser's GET or HEAD with a redirect to sign in. */
const VERIFY_REDIRECT_PATH = '/auth/verify?redirect=1';
/** The headers Heautou answers with, in the order the snippets copy them. */
const REMOTE_HEADERS = ['Remote-User', 'Remote-Groups', 'Remote-Name', 'Remote-Email'] as const;
/** A backend the page can't know, for the operator to replace. */
export const BACKEND_PLACEHOLDER = '<app-backend>:8080';
/** HAProxy's indentation inside a section, and nginx's and Caddy's inside a block. */
const INDENT = '    ';

/** A protected site, as far as a proxy cares. */
export interface SnippetSite {
  /** The host, such as `sonarr.home.lan`. */
  host: string;
  /** The path prefix, such as `/admin`, or empty for the whole host. */
  pathPrefix: string;
  /** Where the proxy reaches the app, as `host:port`, such as `sonarr:8989`. */
  backend: string;
}

/** Heautou as the proxy reaches it. */
export interface Upstream {
  /** `http` or `https`. */
  scheme: 'http' | 'https';
  /** The host name, such as `heautou`. */
  hostname: string;
  /** The port, the scheme's default when the address left it out. */
  port: string;
  /** The address as typed, minus a default port: `http://heautou:3000`. */
  origin: string;
  /** `heautou:3000`, or `heautou` on the default port. */
  host: string;
}

/** What a snippet is built from. */
export interface SnippetInput {
  /** Where the proxy reaches Heautou, not through itself: `http://heautou:3000` on a Docker network. */
  upstream: Upstream;
  /** Heautou's public host, which HAProxy routes to it: `auth.home.lan`. */
  heautouHost: string;
  /** The sites to protect; at least one. */
  sites: readonly SnippetSite[];
}

/** One file of a snippet. */
export interface SnippetFile {
  /** What the file is, such as `haproxy.cfg`. */
  title: string;
  /** Its language, drawn muted after the title. */
  language: string;
  /** The text to paste. */
  content: string;
}

/** The sites on one host. */
interface HostGroup {
  host: string;
  /** A short name for ACLs, routers and backends: the host's first label, made unique. */
  slug: string;
  /** Where the proxy reaches the app: the first site's backend. */
  backend: string;
  /** Whether a site covers the whole host. */
  wholeHost: boolean;
  /** The path prefixes the host's sites cover when none covers it all, longest first. */
  prefixes: string[];
}

/**
 * Reads where the proxy reaches Heautou, as an http or https URL or a bare `host:port`.
 *
 * @param text - What the operator typed, such as `http://heautou:3000` or `heautou:3000`.
 * @returns The parsed address, or null when it isn't one with nothing but a scheme, host and port.
 */
export function parseUpstream(text: string): Upstream | null {
  const trimmed = text.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  const scheme = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : null;
  const bare = url.pathname === '/' && url.search === '' && url.hash === '';
  if (scheme === null || bare === false || url.username !== '' || url.password !== '' || url.hostname === '') {
    return null;
  }
  return {
    scheme,
    hostname: url.hostname,
    port: url.port === '' ? (scheme === 'https' ? '443' : '80') : url.port,
    origin: url.origin,
    host: url.host,
  };
}

/**
 * Groups the sites by host, in the order they come, each with a short unique name.
 *
 * @param sites - The sites.
 * @returns One group per host.
 */
function groupByHost(sites: readonly SnippetSite[]): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  // `heautou` names Heautou's own ACL and backend.
  const taken = new Set(['heautou']);
  for (const site of sites) {
    const group = groups.get(site.host);
    if (group !== undefined) {
      group.wholeHost = group.wholeHost || site.pathPrefix === '';
      group.prefixes.push(site.pathPrefix);
      continue;
    }
    const label = (site.host.split('.')[0] ?? site.host).replace(/[^a-z0-9]+/gi, '_');
    let slug = label;
    for (let n = 2; taken.has(slug); n += 1) {
      slug = `${label}_${n}`;
    }
    taken.add(slug);
    groups.set(site.host, {
      host: site.host,
      slug,
      backend: site.backend,
      wholeHost: site.pathPrefix === '',
      prefixes: [site.pathPrefix],
    });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    prefixes: group.wholeHost
      ? []
      : [...new Set(group.prefixes)].sort((a, b) => b.length - a.length || a.localeCompare(b)),
  }));
}

/**
 * Pads a name to a column, as the doc lines up its ACLs and backends.
 *
 * @param name - The name.
 * @param width - The column's width.
 * @returns The name and the spaces after it.
 */
function pad(name: string, width: number): string {
  return name.padEnd(width, ' ');
}

/**
 * Indents every line that isn't empty.
 *
 * @param lines - The lines.
 * @param depth - How many levels.
 * @returns The lines, indented.
 */
function indent(lines: readonly string[], depth = 1): string[] {
  return lines.map((line) => (line === '' ? line : `${INDENT.repeat(depth)}${line}`));
}

/**
 * The shell commands that fetch haproxy-auth-request and the two Lua libraries it needs, at the versions the doc
 * tested.
 *
 * @returns The commands.
 */
export function haproxyLuaSetup(): string {
  return [
    'mkdir -p lua',
    'curl -fsSL -o lua/auth-request.lua \\',
    '  https://raw.githubusercontent.com/TimWolla/haproxy-auth-request/9fe6049577cfcb5c159ed7d3a2bb72465a5c11ab/auth-request.lua',
    'curl -fsSL -o lua/haproxy-lua-http.lua \\',
    '  https://raw.githubusercontent.com/haproxytech/haproxy-lua-http/670d0d278182902f252faffc17eeb51a7ecb4b9d/http.lua',
    'curl -fsSL -o lua/json.lua https://raw.githubusercontent.com/rxi/json.lua/v0.1.2/json.lua',
    '',
  ].join('\n');
}

/**
 * A `server` line's address and, for https, the TLS options.
 *
 * @param upstream - Heautou as the proxy reaches it.
 * @returns What follows the server's name.
 */
function haproxyServer(upstream: Upstream): string {
  const address = `${upstream.hostname}:${upstream.port}`;
  return upstream.scheme === 'https' ? `${address} ssl verify required ca-file @system-ca` : address;
}

/**
 * A complete `haproxy.cfg` with haproxy-auth-request: Heautou's host and each site's routed to its backend, the
 * `Remote-*` headers dropped from the browser's request, the original request described in `X-Forwarded-*`, and a
 * protected request asked about, then let through with the user's headers, redirected to sign in, or refused.
 *
 * @param input - The facts.
 * @returns The file.
 */
export function haproxyConfig(input: SnippetInput): string {
  const hosts = groupByHost(input.sites);
  const partial = hosts.filter((group) => group.wholeHost === false);
  const aclNames = ['host_heautou', 'protected', ...hosts.map((group) => `host_${group.slug}`)].concat(
    partial.map((group) => `prefix_${group.slug}`),
  );
  const aclWidth = Math.max(...aclNames.map((name) => name.length)) + 1;
  const acl = (name: string, rest: string): string => `acl ${pad(name, aclWidth)}${rest}`;
  const hostMatch = (names: readonly string[]): string => `hdr(host),field(1,:) -i ${names.join(' ')}`;
  const backendWidth = Math.max('be_heautou'.length, ...hosts.map((group) => `be_${group.slug}`.length)) + 1;
  const wholeHosts = hosts.filter((group) => group.wholeHost).map((group) => group.host);
  const condition = 'protected !{ var(txn.auth_response_successful) -m bool }';

  const frontend = [
    'bind :80',
    'bind :443 ssl crt /usr/local/etc/haproxy/certs/',
    'http-request redirect scheme https unless { ssl_fc }',
    '',
    acl('host_heautou', hostMatch([input.heautouHost])),
    ...hosts.map((group) => acl(`host_${group.slug}`, hostMatch([group.host]))),
    ...(wholeHosts.length === 0
      ? []
      : [
          '# Every host Heautou guards. Each needs a site under Protected sites too.',
          acl('protected', hostMatch(wholeHosts)),
        ]),
    ...(partial.length === 0
      ? []
      : [
          '# A site on part of a host: its path prefix, and anything under it. Each needs a site under Protected',
          '# sites too.',
          ...partial.flatMap((group) => [
            acl(`prefix_${group.slug}`, `path ${group.prefixes.join(' ')}`),
            acl(`prefix_${group.slug}`, `path_beg ${group.prefixes.map((prefix) => `${prefix}/`).join(' ')}`),
          ]),
          ...partial.map(
            (group) =>
              `http-request set-var(txn.heautou_protected) bool(true) if host_${group.slug} prefix_${group.slug}`,
          ),
          acl('protected', 'var(txn.heautou_protected) -m bool'),
        ]),
    '',
    '# Only Heautou says who the user is.',
    ...['Remote-User', 'Remote-Name', 'Remote-Email', 'Remote-Groups'].map(
      (header) => `http-request del-header ${header}`,
    ),
    'http-request del-header X-Original-URL',
    '',
    '# Describe the request, for Heautou and for TRUST_PROXY.',
    'http-request set-header X-Forwarded-For %[src]',
    'http-request set-header X-Forwarded-Proto https if { ssl_fc }',
    'http-request set-header X-Forwarded-Proto http unless { ssl_fc }',
    'http-request set-header X-Forwarded-Host %[req.hdr(host)]',
    'http-request set-header X-Forwarded-Uri %[pathq]',
    'http-request set-header X-Forwarded-Method %[method]',
    '',
    '# Ask Heautou, sending only the X-Forwarded-* headers and the cookies. On 200 the Remote-* headers are copied',
    '# onto the request; otherwise a sign-in redirect, a 401 or a 403. If Heautou is down, the request is refused.',
    `http-request lua.auth-intercept be_heautou ${VERIFY_REDIRECT_PATH} HEAD x-forwarded-*,cookie remote-user,remote-name,remote-email,remote-groups - if protected`,
    `http-request redirect location %[var(txn.auth_response_location)] code 302 if ${condition} { var(txn.auth_response_location) -m found }`,
    `http-request deny deny_status 401 if ${condition} { var(txn.auth_response_code) -m int 401 }`,
    `http-request deny deny_status 403 if ${condition}`,
    '',
    `use_backend ${pad('be_heautou', backendWidth)}if host_heautou`,
    ...hosts.map((group) => `use_backend ${pad(`be_${group.slug}`, backendWidth)}if host_${group.slug}`),
  ];

  return [
    'global',
    ...indent([
      '# HAProxy 3.1 and later; remove this line on older versions.',
      'tune.lua.bool-sample-conversion normal',
      'lua-prepend-path /usr/local/etc/haproxy/lua/?.lua',
      'lua-load /usr/local/etc/haproxy/lua/auth-request.lua',
    ]),
    '',
    'defaults',
    ...indent(['mode http', 'timeout connect 5s', 'timeout client  30s', 'timeout server  30s']),
    '',
    'frontend web',
    ...indent(frontend),
    '',
    'backend be_heautou',
    ...indent([`server heautou ${haproxyServer(input.upstream)}`]),
    ...hosts.flatMap((group) => ['', `backend be_${group.slug}`, ...indent([`server ${group.slug} ${group.backend}`])]),
    '',
  ].join('\n');
}

/**
 * An nginx `location` for a path prefix: the prefix itself and anything under it, not `/administrator` for `/admin`.
 *
 * @param prefix - The prefix, such as `/admin`.
 * @returns The location's match.
 */
function nginxPrefixLocation(prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `~ "^${escaped}(/|$)"`;
}

/**
 * The lines that ask Heautou about a request and pass the user on to the app.
 *
 * @param backend - Where nginx reaches the app.
 * @returns The location's body.
 */
function nginxProtectedLocation(backend: string): string[] {
  return [
    'auth_request /internal/heautou-verify;',
    'auth_request_set $heautou_sign_in $upstream_http_location;',
    'auth_request_set $heautou_user $upstream_http_remote_user;',
    'auth_request_set $heautou_groups $upstream_http_remote_groups;',
    'auth_request_set $heautou_name $upstream_http_remote_name;',
    'auth_request_set $heautou_email $upstream_http_remote_email;',
    'error_page 401 =302 $heautou_sign_in;',
    '',
    '# Set, so whatever the browser sent is replaced.',
    'proxy_set_header Remote-User $heautou_user;',
    'proxy_set_header Remote-Groups $heautou_groups;',
    'proxy_set_header Remote-Name $heautou_name;',
    'proxy_set_header Remote-Email $heautou_email;',
    `proxy_pass http://${backend};`,
  ];
}

/**
 * nginx `server` blocks with `auth_request`, one per host: an internal location that asks Heautou with the original
 * URL, and the protected locations that send a 401 to sign in and pass the `Remote-*` headers on.
 *
 * @param input - The facts.
 * @returns The configuration.
 */
export function nginxConfig(input: SnippetInput): string {
  const verify = [
    'internal;',
    `proxy_pass ${input.upstream.origin}${VERIFY_PATH};`,
    ...(input.upstream.scheme === 'https' ? ['proxy_ssl_server_name on;'] : []),
    'proxy_pass_request_body off;',
    'proxy_set_header Content-Length "";',
    'proxy_set_header X-Original-URL $scheme://$http_host$request_uri;',
    'proxy_set_header X-Forwarded-Method $request_method;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header X-Forwarded-Host $http_host;',
    'proxy_set_header X-Forwarded-Uri $request_uri;',
  ];
  const block = (group: HostGroup): string[] => {
    const locations = group.wholeHost
      ? [['location / {', ...indent(nginxProtectedLocation(group.backend)), '}']]
      : [
          ...group.prefixes.map((prefix) => [
            `location ${nginxPrefixLocation(prefix)} {`,
            ...indent(nginxProtectedLocation(group.backend)),
            '}',
          ]),
          [
            'location / {',
            ...indent([
              '# The rest of the host is not protected, and nobody may say who they are to it.',
              ...REMOTE_HEADERS.map((header) => `proxy_set_header ${header} "";`),
              `proxy_pass http://${group.backend};`,
            ]),
            '}',
          ],
        ];
    return [
      'server {',
      ...indent([
        'listen 443 ssl;',
        `server_name ${group.host};`,
        '',
        'location = /internal/heautou-verify {',
        ...indent(verify),
        '}',
        ...locations.flatMap((location) => ['', ...location]),
      ]),
      '}',
    ];
  };
  return `${groupByHost(input.sites)
    .map((group) => block(group).join('\n'))
    .join('\n\n')}\n`;
}

/**
 * A Caddyfile with `forward_auth`, one site block per host, the prefixes matched when a site covers part of one.
 *
 * @param input - The facts.
 * @returns The Caddyfile.
 */
export function caddyConfig(input: SnippetInput): string {
  const upstream = input.upstream.scheme === 'https' ? input.upstream.origin : input.upstream.host;
  const block = (group: HostGroup): string[] => {
    const paths = group.prefixes.flatMap((prefix) => [prefix, `${prefix}/*`]).join(' ');
    // `request_header` runs after `forward_auth`, so it strips only where Heautou didn't set the headers.
    const matcher = group.wholeHost
      ? []
      : [
          `@heautou path ${paths}`,
          `@open not path ${paths}`,
          '# Nobody may say who they are to the parts Heautou does not guard.',
          ...REMOTE_HEADERS.map((header) => `request_header @open -${header}`),
        ];
    const target = group.wholeHost ? upstream : `@heautou ${upstream}`;
    return [
      `${group.host} {`,
      ...indent([
        ...matcher,
        `forward_auth ${target} {`,
        ...indent([`uri ${VERIFY_REDIRECT_PATH}`, `copy_headers ${REMOTE_HEADERS.join(' ')}`]),
        '}',
        `reverse_proxy ${group.backend}`,
      ]),
      '}',
    ];
  };
  return `${groupByHost(input.sites)
    .map((group) => block(group).join('\n'))
    .join('\n\n')}\n`;
}

/**
 * A Traefik dynamic configuration with a `forwardAuth` middleware, a router per host on it (and an open one for the
 * rest of a host only part of which is protected), and the services.
 *
 * @param input - The facts.
 * @returns The YAML.
 */
export function traefikConfig(input: SnippetInput): string {
  const hosts = groupByHost(input.sites);
  const routers = hosts.flatMap((group) => {
    const host = `Host(\`${group.host}\`)`;
    const paths = group.prefixes.map((prefix) => `Path(\`${prefix}\`) || PathPrefix(\`${prefix}/\`)`).join(' || ');
    const guarded = [
      `${group.slug}:`,
      `  rule: ${group.wholeHost ? host : `${host} && (${paths})`}`,
      '  middlewares: [heautou]',
      `  service: ${group.slug}`,
    ];
    const open = [
      `${group.slug}-open:`,
      `  rule: ${host}`,
      '  middlewares: [heautou-strip]',
      `  service: ${group.slug}`,
    ];
    return group.wholeHost ? guarded : [...guarded, ...open];
  });
  const services = hosts.flatMap((group) => [
    `${group.slug}:`,
    '  loadBalancer:',
    '    servers:',
    `      - url: http://${group.backend}`,
  ]);
  return [
    'http:',
    '  middlewares:',
    '    heautou:',
    '      forwardAuth:',
    `        address: ${input.upstream.origin}${VERIFY_REDIRECT_PATH}`,
    '        trustForwardHeader: false',
    `        authResponseHeaders: [${REMOTE_HEADERS.join(', ')}]`,
    // An empty value removes the header, so nobody may say who they are to the parts Heautou doesn't guard.
    ...(hosts.every((group) => group.wholeHost)
      ? []
      : [
          '    heautou-strip:',
          '      headers:',
          '        customRequestHeaders:',
          ...REMOTE_HEADERS.map((header) => `          ${header}: ""`),
        ]),
    '  routers:',
    ...routers.map((line) => `    ${line}`),
    '  services:',
    ...services.map((line) => `    ${line}`),
    '',
  ].join('\n');
}

/**
 * The files to paste for one proxy.
 *
 * @param kind - Which proxy.
 * @param input - The facts.
 * @returns The files, in the order to set them up.
 */
export function proxySnippet(kind: ProxyKind, input: SnippetInput): SnippetFile[] {
  switch (kind) {
    case 'haproxy':
      return [
        { title: 'Fetch the Lua scripts', language: 'sh', content: haproxyLuaSetup() },
        { title: 'haproxy.cfg', language: 'haproxy', content: haproxyConfig(input) },
      ];
    case 'nginx':
      return [{ title: 'nginx.conf', language: 'nginx', content: nginxConfig(input) }];
    case 'caddy':
      return [{ title: 'Caddyfile', language: 'caddy', content: caddyConfig(input) }];
    case 'traefik':
      return [{ title: 'dynamic.yml', language: 'yaml', content: traefikConfig(input) }];
  }
}

/**
 * Whether a snippet is one the doc ran end to end: HAProxy and nginx, protecting whole hosts.
 *
 * @param kind - Which proxy.
 * @param sites - The sites it protects.
 * @returns Whether it was tested.
 */
export function isTested(kind: ProxyKind, sites: readonly SnippetSite[]): boolean {
  return PROXIES[kind].testedWholeHost && sites.every((site) => site.pathPrefix === '');
}
