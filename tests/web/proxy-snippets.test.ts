import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  caddyConfig,
  haproxyConfig,
  haproxyLuaSetup,
  isTested,
  nginxConfig,
  parseUpstream,
  proxySnippet,
  type SnippetInput,
  type SnippetSite,
  traefikConfig,
  type Upstream,
} from '../../web/src/sites/proxy-snippets.ts';

const DOC = readFileSync(path.resolve(import.meta.dirname, '../../docs/forward-auth.md'), 'utf8');

/**
 * Reads the fenced blocks of one language out of the doc.
 *
 * @param language - The fence's language.
 * @returns Each block's text, ending in a newline.
 */
function docBlocks(language: string): string[] {
  const fence = new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, 'gm');
  return [...DOC.matchAll(fence)].map((match) => match[1] ?? '');
}

/**
 * Parses an upstream the test knows is valid.
 *
 * @param text - The address.
 * @returns It, parsed.
 */
function upstream(text: string): Upstream {
  const parsed = parseUpstream(text);
  if (parsed === null) {
    throw new Error(`not an upstream: ${text}`);
  }
  return parsed;
}

const SONARR: SnippetSite = { host: 'sonarr.home.lan', pathPrefix: '', backend: 'sonarr:8989' };
const WIKI: SnippetSite = { host: 'wiki.home.lan', pathPrefix: '', backend: 'wiki:3000' };

/**
 * The doc's example: Heautou at auth.home.lan, reached at heautou:3000.
 *
 * @param sites - The sites.
 * @returns The input.
 */
function example(sites: SnippetSite[]): SnippetInput {
  return { upstream: upstream('http://heautou:3000'), heautouHost: 'auth.home.lan', sites };
}

describe('the snippets match docs/forward-auth.md', () => {
  it('HAProxy: the Lua scripts and haproxy.cfg', () => {
    expect(docBlocks('sh')).toContain(haproxyLuaSetup());
    expect(docBlocks('haproxy')).toEqual([haproxyConfig(example([SONARR, WIKI]))]);
  });

  it('nginx, Caddy and Traefik', () => {
    expect(docBlocks('nginx')).toEqual([nginxConfig(example([SONARR]))]);
    expect(docBlocks('caddy')).toEqual([caddyConfig(example([SONARR]))]);
    expect(docBlocks('yaml').filter((block) => block.startsWith('http:'))).toEqual([traefikConfig(example([SONARR]))]);
  });
});

describe('parseUpstream', () => {
  it('takes a URL or a bare host and port', () => {
    expect(parseUpstream('http://heautou:3000/')).toMatchObject({
      scheme: 'http',
      hostname: 'heautou',
      port: '3000',
      origin: 'http://heautou:3000',
      host: 'heautou:3000',
    });
    expect(parseUpstream('heautou:3000')).toMatchObject({ scheme: 'http', host: 'heautou:3000' });
    expect(parseUpstream('https://auth.home.lan')).toMatchObject({
      scheme: 'https',
      port: '443',
      host: 'auth.home.lan',
    });
  });

  it('refuses anything with more than a scheme, host and port', () => {
    expect(parseUpstream('')).toBeNull();
    expect(parseUpstream('ftp://heautou')).toBeNull();
    expect(parseUpstream('http://heautou:3000/oidc')).toBeNull();
    expect(parseUpstream('http://user:pw@heautou')).toBeNull();
    expect(parseUpstream('http://heautou?x=1')).toBeNull();
  });
});

describe('a site on part of a host', () => {
  const admin: SnippetSite = { host: 'wiki.home.lan', pathPrefix: '/admin', backend: 'wiki:3000' };
  const input = example([SONARR, admin, { ...admin, pathPrefix: '/api.v2' }]);

  it('HAProxy asks only under the prefixes, at a segment boundary', () => {
    const config = haproxyConfig(input);
    expect(config).toContain('acl protected    hdr(host),field(1,:) -i sonarr.home.lan\n');
    expect(config).toContain('acl prefix_wiki  path /api.v2 /admin\n');
    expect(config).toContain('acl prefix_wiki  path_beg /api.v2/ /admin/\n');
    expect(config).toContain('http-request set-var(txn.heautou_protected) bool(true) if host_wiki prefix_wiki\n');
    expect(config).toContain('acl protected    var(txn.heautou_protected) -m bool\n');
    expect(config.match(/^backend be_wiki$/gm)).toHaveLength(1);
  });

  it('nginx guards the prefix with an escaped regex and passes the rest through', () => {
    const config = nginxConfig(input);
    expect(config).toContain('location ~ "^/api\\.v2(/|$)" {');
    expect(config).toContain('location ~ "^/admin(/|$)" {');
    expect(config).toContain('        proxy_set_header Remote-User "";\n');
    expect(config.match(/server_name /g)).toHaveLength(2);
  });

  it('Caddy matches the prefix and below', () => {
    const config = caddyConfig(input);
    expect(config).toContain('    @heautou path /api.v2 /api.v2/* /admin /admin/*\n');
    expect(config).toContain('    @open not path /api.v2 /api.v2/* /admin /admin/*\n');
    expect(config).toContain('    request_header @open -Remote-User\n');
    expect(config).toContain('    forward_auth @heautou heautou:3000 {');
  });

  it('Traefik guards the prefix and opens the rest', () => {
    const config = traefikConfig(input);
    expect(config).toContain(
      'rule: Host(`wiki.home.lan`) && (Path(`/api.v2`) || PathPrefix(`/api.v2/`) || Path(`/admin`) || PathPrefix(`/admin/`))',
    );
    expect(config).toContain(
      '    wiki-open:\n      rule: Host(`wiki.home.lan`)\n      middlewares: [heautou-strip]\n      service: wiki\n',
    );
    expect(config).toContain('          Remote-User: ""\n');
  });

  it('is not what the doc tested', () => {
    expect(isTested('haproxy', [SONARR])).toBe(true);
    expect(isTested('nginx', [SONARR])).toBe(true);
    expect(isTested('haproxy', [SONARR, admin])).toBe(false);
    expect(isTested('caddy', [SONARR])).toBe(false);
  });
});

describe('names and addresses', () => {
  it('gives hosts sharing a first label, or named heautou, names of their own', () => {
    const config = haproxyConfig(
      example([
        { host: 'wiki.a.lan', pathPrefix: '', backend: 'a:1' },
        { host: 'wiki.b.lan', pathPrefix: '', backend: 'b:1' },
        { host: 'heautou.c.lan', pathPrefix: '', backend: 'c:1' },
      ]),
    );
    expect(config).toContain('backend be_wiki\n    server wiki a:1');
    expect(config).toContain('backend be_wiki_2\n    server wiki_2 b:1');
    expect(config).toContain('backend be_heautou_2\n    server heautou_2 c:1');
  });

  it('reaches an https Heautou over TLS', () => {
    const input = { ...example([SONARR]), upstream: upstream('https://auth.home.lan') };
    expect(haproxyConfig(input)).toContain('server heautou auth.home.lan:443 ssl verify required ca-file @system-ca');
    expect(nginxConfig(input)).toContain(
      'proxy_pass https://auth.home.lan/auth/verify;\n        proxy_ssl_server_name on;',
    );
    expect(caddyConfig(input)).toContain('forward_auth https://auth.home.lan {');
    expect(traefikConfig(input)).toContain('address: https://auth.home.lan/auth/verify?redirect=1');
  });

  it('gives HAProxy two files and the others one', () => {
    const input = example([SONARR]);
    expect(proxySnippet('haproxy', input).map((file) => file.title)).toEqual(['Fetch the Lua scripts', 'haproxy.cfg']);
    expect(proxySnippet('traefik', input)).toHaveLength(1);
  });
});
