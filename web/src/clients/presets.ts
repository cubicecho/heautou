// Client presets: what common apps need from their client, and what to set in each app afterwards.
// Adding an app is one entry in PRESETS. Each one links to the docs it was checked against.
// No imports: tests/web/clients/presets.test.ts loads this next to the server's client store, to check each preset saves.

/** How the client proves itself: the GraphQL `ClientAuthMethod`, written out so this file stands alone. */
export type ClientAuthMethod = 'CLIENT_SECRET_BASIC' | 'CLIENT_SECRET_POST' | 'NONE';

/** What the "Configure the app" panel fills its values from. */
export interface PresetContext {
  /** The provider's issuer, ending in `/oidc`. */
  issuer: string;
  /** The issuer's OpenID discovery document. */
  discoveryUrl: string;
  clientId: string;
  /** Null for a public client. */
  clientSecret: string | null;
  /** The app's address as the admin gave it, without a trailing slash. */
  baseUrl: string;
  /** The client's allowed groups. Empty lets every user in. */
  allowedGroups: readonly string[];
}

/** One value to set in the app. */
export interface PresetSetting {
  /** The env var, config key or field label, as the app names it. */
  name: string;
  value: string;
  /** Shown under it: what it is for, or what to change. */
  note?: string;
}

/**
 * What to set in the app: env vars (one `NAME=value` block), a config file to paste (YAML, say), or fields in the
 * app's own UI (a row each, with a copy button).
 */
export type PresetConfig =
  | { format: 'env'; settings: readonly PresetSetting[] }
  | { format: 'fields'; settings: readonly PresetSetting[] }
  | { format: 'file'; fileName: string; language: string; text: string };

/** The section a preset is listed under in the picker. */
export type PresetSection = 'apps' | 'cubicecho';

/** What a preset puts in the client form. */
export interface PresetClient {
  authMethod: ClientAuthMethod;
  /** Callback paths under the app's address. */
  redirectPaths: readonly string[];
  /** Redirect URIs that are not under the app's address, such as a mobile app's own scheme. */
  extraRedirectUris?: readonly string[];
  /** Post-logout paths under the app's address. */
  postLogoutPaths: readonly string[];
  /** Where the app takes a back-channel logout token, under its address. Left out for an app that has none. */
  backchannelLogoutPath?: string;
  /** Left out, the default `groups`. */
  groupsClaim?: string;
}

/** An app the client form can start from. */
export interface ClientPreset {
  /** Stored on the client as `preset`: lowercase words joined by dashes. */
  id: string;
  name: string;
  section: PresetSection;
  /** The app's own OIDC docs, which the preset was checked against. */
  docsUrl: string;
  /** What the address field shows before anything is typed. */
  baseUrlExample: string;
  client: PresetClient;
  /** Where the settings go in the app, as one sentence. */
  where: string;
  /**
   * What to set in the app, filled in for one client.
   *
   * @param context - The provider and the client.
   * @returns The settings, in the order the app's docs list them, or the file to paste.
   */
  configure: (context: PresetContext) => PresetConfig;
  /** Steps or caveats shown above the settings: a plugin to install, a version needed. */
  notes?: readonly string[];
}

/** What a setting shows in place of a secret the client does not have. */
const NO_SECRET = '(none: a public client)';

/**
 * A client's secret, or what stands in for it.
 *
 * @param context - The client.
 * @returns The secret.
 */
function secretOf(context: PresetContext): string {
  return context.clientSecret ?? NO_SECRET;
}

/**
 * The groups a setting that names one group takes.
 *
 * @param context - The client.
 * @param fallback - What to show when the client lets every user in.
 * @returns The client's first allowed group, or the fallback.
 */
function firstGroupOr(context: PresetContext, fallback: string): string {
  return context.allowedGroups[0] ?? fallback;
}

/** How a cubicecho app names the variable its own address goes in. */
type CubicechoBaseUrlVar = 'SERVER_URL' | 'APP_URL' | 'BETTER_AUTH_URL';

/** What differs between the cubicecho apps: they all follow the `cubicecho_backend` skill's `sso.md`. */
interface CubicechoApp {
  id: string;
  name: string;
  port: number;
  baseUrlVar: CubicechoBaseUrlVar;
  /** Its README's sign-in section, or the repo when it has none. */
  docsUrl: string;
}

/** The cubicecho apps' callback, under their address. */
const CUBICECHO_CALLBACK = '/api/auth/callback/oidc';

/**
 * Builds the preset for one cubicecho app. They share env vars and a callback, and pair too.
 *
 * @param app - What differs.
 * @returns The preset.
 */
function cubicechoPreset(app: CubicechoApp): ClientPreset {
  return {
    id: app.id,
    name: app.name,
    section: 'cubicecho',
    docsUrl: app.docsUrl,
    baseUrlExample: `http://${app.id}.lan:${app.port}`,
    client: { authMethod: 'CLIENT_SECRET_BASIC', redirectPaths: [CUBICECHO_CALLBACK], postLogoutPaths: [] },
    where: `${app.name}'s environment (.env or docker-compose.yml). Restart it afterwards.`,
    notes: [
      `${app.name} can also pair itself: Pair an app gives a setup URL to paste on its sign-in page (a new instance) or under its Settings.`,
      `The first account to sign in becomes ${app.name}'s admin. Allowed groups here decide who may sign in at all.`,
    ],
    configure: (context) => ({
      format: 'env',
      settings: [
        { name: 'OIDC_ISSUER', value: context.issuer, note: 'The issuer, not the discovery URL.' },
        { name: 'OIDC_CLIENT_ID', value: context.clientId },
        { name: 'OIDC_CLIENT_SECRET', value: secretOf(context) },
        { name: 'OIDC_NAME', value: 'heautou', note: 'The sign-in button says "Sign in with" this.' },
        { name: app.baseUrlVar, value: context.baseUrl, note: 'Its own address, which the callback is built from.' },
      ],
    }),
  };
}

/** Where the cubicecho repos are. */
const REPOS = 'https://github.com/cubicecho/';

/** The cubicecho apps, listed under their own heading. */
const CUBICECHO_PRESETS: readonly ClientPreset[] = [
  cubicechoPreset({
    id: 'telos',
    name: 'Telos',
    port: 3001,
    baseUrlVar: 'SERVER_URL',
    docsUrl: `${REPOS}telos#signing-in-with-an-oidc-provider`,
  }),
  cubicechoPreset({ id: 'ethos', name: 'Ethos', port: 3000, baseUrlVar: 'SERVER_URL', docsUrl: `${REPOS}ethos` }),
  cubicechoPreset({
    id: 'engrafo',
    name: 'Engrafo',
    port: 3004,
    baseUrlVar: 'APP_URL',
    docsUrl: `${REPOS}engrafo#signing-in-with-an-oidc-provider`,
  }),
  cubicechoPreset({
    id: 'eunomia',
    name: 'Eunomia',
    port: 4000,
    baseUrlVar: 'BETTER_AUTH_URL',
    docsUrl: `${REPOS}eunomia#single-sign-on-oidc`,
  }),
  cubicechoPreset({
    id: 'philotes',
    name: 'Philotes',
    port: 3000,
    baseUrlVar: 'SERVER_URL',
    docsUrl: `${REPOS}philotes#sign-in-with-your-identity-provider`,
  }),
];

/** The provider name the Jellyfin plugin is set up with, which its callbacks end in. */
const JELLYFIN_PROVIDER = 'heautou';

/** The group name the settings suggest for an app's admins, when the client names no group of its own. */
const ADMINS_EXAMPLE = 'admins';

/** Third-party apps, in the order the picker lists them. */
const APP_PRESETS: readonly ClientPreset[] = [
  {
    id: 'mealie',
    name: 'Mealie',
    section: 'apps',
    docsUrl: 'https://mealie.io/documentation/getting-started/authentication/oidc-v2/',
    baseUrlExample: 'http://mealie.lan:9000',
    client: { authMethod: 'CLIENT_SECRET_BASIC', redirectPaths: ['/login'], postLogoutPaths: ['/login?direct=1'] },
    where: "Mealie's environment (docker-compose.yml or .env). Restart it afterwards.",
    notes: [
      'Mealie v2 or later. Add every address Mealie is opened at as a redirect URI.',
      'Behind a reverse proxy, set BASE_URL to the https address, or the callback comes out as http.',
    ],
    configure: (context) => ({
      format: 'env',
      settings: [
        { name: 'OIDC_AUTH_ENABLED', value: 'true' },
        {
          name: 'OIDC_CONFIGURATION_URL',
          value: context.discoveryUrl,
          note: 'The whole discovery URL, not the issuer.',
        },
        { name: 'OIDC_CLIENT_ID', value: context.clientId },
        { name: 'OIDC_CLIENT_SECRET', value: secretOf(context) },
        { name: 'OIDC_PROVIDER_NAME', value: 'heautou', note: 'The sign-in button says "Login with" this.' },
        {
          name: 'OIDC_USER_GROUP',
          value: firstGroupOr(context, ''),
          note: 'Optional: only this group may sign in. Blank lets in everyone Heautou does.',
        },
        {
          name: 'OIDC_ADMIN_GROUP',
          value: ADMINS_EXAMPLE,
          note: 'Optional: the group whose members are Mealie admins. Use one of your groups.',
        },
        { name: 'BASE_URL', value: context.baseUrl },
      ],
    }),
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    section: 'apps',
    docsUrl: 'https://github.com/christiaangoossens/hass-oidc-auth/blob/main/docs/configuration.md',
    baseUrlExample: 'http://homeassistant.lan:8123',
    client: { authMethod: 'NONE', redirectPaths: ['/auth/oidc/callback'], postLogoutPaths: [] },
    where: "Home Assistant's configuration.yaml. Restart it afterwards.",
    notes: [
      'Home Assistant has no OIDC of its own: install the "OpenID Connect" integration (hass-oidc-auth) from HACS first, then restart.',
      'It is a public client: the integration uses PKCE and no secret.',
      "Only Home Assistant's web UI signs in this way; the companion apps follow it on the same page.",
    ],
    configure: (context) => ({
      format: 'file',
      fileName: 'configuration.yaml',
      language: 'yaml',
      text: [
        'auth_oidc:',
        `  client_id: ${context.clientId}`,
        `  discovery_url: ${context.discoveryUrl}`,
        '  display_name: heautou',
        '  roles:',
        `    admin: ${ADMINS_EXAMPLE}  # members of this group are Home Assistant admins`,
        ...(context.allowedGroups.length === 0 ? [] : [`    user: ${context.allowedGroups[0]}`]),
      ].join('\n'),
    }),
  },
  {
    id: 'immich',
    name: 'Immich',
    section: 'apps',
    docsUrl: 'https://docs.immich.app/administration/oauth',
    baseUrlExample: 'http://immich.lan:2283',
    client: {
      authMethod: 'CLIENT_SECRET_POST',
      redirectPaths: ['/auth/login', '/user-settings', '/api/oauth/mobile-redirect'],
      postLogoutPaths: [],
      backchannelLogoutPath: '/api/oauth/backchannel-logout',
    },
    where: "Immich's Administration → Settings → OAuth. Turn on Enable, then fill in these.",
    notes: [
      'For the mobile app, turn on Mobile Redirect URI Override with the URI below: a confidential client here cannot take the app.immich:// scheme.',
      'Immich reads roles from an immich_role claim (user or admin), not groups. Give admins a custom claim immich_role = admin on their user.',
      'Immich expects an https issuer.',
    ],
    configure: (context) => ({
      format: 'fields',
      settings: [
        { name: 'Issuer URL', value: context.issuer },
        { name: 'Client ID', value: context.clientId },
        { name: 'Client Secret', value: secretOf(context) },
        { name: 'Token Endpoint Auth Method', value: 'client_secret_post' },
        { name: 'Scope', value: 'openid email profile' },
        { name: 'Button Text', value: 'Sign in with heautou' },
        { name: 'Mobile Redirect URI', value: `${context.baseUrl}/api/oauth/mobile-redirect` },
      ],
    }),
  },
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    section: 'apps',
    docsUrl: 'https://github.com/K0lin/jellyfin-plugin-sso',
    baseUrlExample: 'http://jellyfin.lan:8096',
    client: {
      authMethod: 'CLIENT_SECRET_POST',
      redirectPaths: [`/sso/OID/redirect/${JELLYFIN_PROVIDER}`, `/sso/OID/r/${JELLYFIN_PROVIDER}`],
      postLogoutPaths: [],
    },
    where: `The SSO plugin's settings (Dashboard → Plugins → SSO Authentication), as a provider named ${JELLYFIN_PROVIDER}.`,
    notes: [
      'Jellyfin has no OIDC of its own: add the plugin repository https://raw.githubusercontent.com/k0lin/jellyfin-plugin-sso/manifest-release/manifest.json under Dashboard → Plugins → Repositories, install SSO Authentication and restart. Plugin 5.1 needs Jellyfin 12; use 5.0 for 10.8 to 10.11.',
      `Name the provider ${JELLYFIN_PROVIDER}: the redirect URIs end in that name.`,
      "Jellyfin's sign-in page gets no button: put the sign-in link below on it, for example in the login disclaimer.",
      'A Heautou username that matches an existing Jellyfin account signs in as that account.',
    ],
    configure: (context) => ({
      format: 'fields',
      settings: [
        { name: 'Name of the OpenID Provider', value: JELLYFIN_PROVIDER },
        { name: 'OpenID Endpoint', value: context.issuer, note: 'The issuer: the plugin reads discovery from it.' },
        { name: 'OpenID Client ID', value: context.clientId },
        { name: 'OpenID Secret', value: secretOf(context) },
        { name: 'Enabled', value: 'on' },
        { name: 'Enable Authorization by Plugin', value: 'on' },
        {
          name: 'Roles',
          value: context.allowedGroups.join(', '),
          note: 'Groups that may sign in. Blank lets in everyone.',
        },
        { name: 'Admin Roles', value: ADMINS_EXAMPLE, note: 'Groups whose members are Jellyfin admins.' },
        { name: 'Role Claim', value: 'groups' },
        { name: 'Request Additional Scopes', value: 'email groups' },
        {
          name: 'Sign-in link',
          value: `${context.baseUrl}/sso/OID/start/${JELLYFIN_PROVIDER}`,
          note: 'Where a sign-in starts. Put it on the login page.',
        },
      ],
    }),
  },
];

/** What a forward-auth guide fills its values from. */
export interface SitePresetContext {
  /** Where Heautou itself is served: the issuer without `/oidc`. */
  heautouUrl: string;
}

/**
 * An app with no OIDC that trusts the headers a reverse proxy adds: it goes behind forward auth (a protected site)
 * rather than getting a client.
 */
export interface SitePreset {
  id: string;
  name: string;
  section: PresetSection;
  docsUrl: string;
  /** Where the settings go in the app, as one sentence. */
  where: string;
  notes: readonly string[];
  /**
   * What to set in the app.
   *
   * @param context - Where Heautou is.
   * @returns The file to paste.
   */
  configure: (context: SitePresetContext) => PresetConfig;
}

/** Apps that sign in through forward auth instead of a client. */
export const SITE_PRESETS: readonly SitePreset[] = [
  {
    id: 'frigate',
    name: 'Frigate',
    section: 'apps',
    docsUrl: 'https://docs.frigate.video/configuration/authentication/',
    where: "Frigate's config.yml (or Settings → System → Proxy). Restart it afterwards.",
    notes: [
      "Frigate has no OIDC: add it under Protected sites and point your reverse proxy's forward auth at Heautou. Frigate then trusts the Remote-User and Remote-Groups headers Heautou answers with.",
      "Point the proxy at Frigate's port 8971. Port 5000 ignores the headers and lets everyone in as admin.",
      "Frigate's own sign-in has to be off for it to read the headers.",
    ],
    configure: (context) => ({
      format: 'file',
      fileName: 'config.yml',
      language: 'yaml',
      text: [
        'auth:',
        '  enabled: false',
        'proxy:',
        '  header_map:',
        '    user: remote-user',
        '    role: remote-groups',
        '    role_map:',
        `      admin: [${ADMINS_EXAMPLE}]  # your groups whose members are Frigate admins`,
        '  default_role: viewer',
        '  separator: ","',
        `  logout_url: ${context.heautouUrl}/auth/sign-out`,
      ].join('\n'),
    }),
  },
];

/** Apps people ask for that cannot sign in through Heautou, and why. Listed in the picker, but not choosable. */
export const UNSUPPORTED_APPS: readonly { id: string; name: string; reason: string }[] = [
  {
    id: 'music-assistant',
    name: 'Music Assistant',
    reason: 'No OIDC: it signs in with its own accounts or through Home Assistant.',
  },
  { id: 'omada-controller', name: 'Omada Controller', reason: 'SAML only, which Heautou does not speak.' },
];

/**
 * Finds a forward-auth guide by ID.
 *
 * @param id - The ID.
 * @returns The guide, or undefined for none.
 */
export function sitePresetById(id: string | null | undefined): SitePreset | undefined {
  return SITE_PRESETS.find((preset) => preset.id === id);
}

/**
 * Where Heautou is served, from its issuer.
 *
 * @param issuer - The issuer, ending in `/oidc`.
 * @returns The issuer without it.
 */
export function heautouUrlOf(issuer: string): string {
  return issuer.replace(/\/oidc\/?$/, '');
}

/** Every preset: the apps first, then the cubicecho apps. */
export const PRESETS: readonly ClientPreset[] = [...APP_PRESETS, ...CUBICECHO_PRESETS];

/** The headings the picker shows over each section. */
export const PRESET_SECTION_LABELS: Record<PresetSection, string> = {
  apps: 'Apps',
  cubicecho: 'cubicecho apps',
};

/**
 * Finds a preset by the ID a client stores.
 *
 * @param id - The ID, or null for none.
 * @returns The preset, or undefined for none or one this version does not have.
 */
export function presetById(id: string | null | undefined): ClientPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * Tidies the address the admin typed.
 *
 * @param text - What was typed.
 * @returns The http(s) origin and path without a trailing slash, or null when it is not such a URL.
 */
export function baseUrlFrom(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
  if (isWeb === false || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** The client fields a preset fills in. */
export interface PresetFields {
  name: string;
  authMethod: ClientAuthMethod;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** Empty for none, as the form's field takes it. */
  backchannelLogoutUri: string;
  groupsClaim: string;
}

/**
 * Builds the client a preset describes for an app at one address.
 *
 * @param preset - The preset.
 * @param baseUrl - The app's address, from `baseUrlFrom`.
 * @returns The fields to put in the form.
 */
export function presetFields(preset: ClientPreset, baseUrl: string): PresetFields {
  const { client } = preset;
  return {
    name: preset.name,
    authMethod: client.authMethod,
    redirectUris: [...client.redirectPaths.map((path) => `${baseUrl}${path}`), ...(client.extraRedirectUris ?? [])],
    postLogoutRedirectUris: client.postLogoutPaths.map((path) => `${baseUrl}${path}`),
    backchannelLogoutUri: client.backchannelLogoutPath === undefined ? '' : `${baseUrl}${client.backchannelLogoutPath}`,
    groupsClaim: client.groupsClaim ?? 'groups',
  };
}

/**
 * Works out the app's address from a saved client, so the panel can show it again.
 *
 * @param preset - The preset the client was started from.
 * @param redirectUris - The client's redirect URIs.
 * @returns The address, or null when no redirect URI ends in one of the preset's callback paths.
 */
export function baseUrlOfClient(preset: ClientPreset, redirectUris: readonly string[]): string | null {
  for (const uri of redirectUris) {
    const path = preset.client.redirectPaths.find((candidate) => uri.endsWith(candidate));
    if (path !== undefined) {
      return uri.slice(0, uri.length - path.length);
    }
  }
  return null;
}

/**
 * Writes settings as an env file.
 *
 * @param settings - The settings.
 * @returns One `NAME=value` line each.
 */
export function envText(settings: readonly PresetSetting[]): string {
  return settings.map(({ name, value }) => `${name}=${value}`).join('\n');
}
