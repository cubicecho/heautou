import { UpstreamKind } from '@/__generated__/graphql';

/** A provider the new sign-in provider form can start from. */
export interface UpstreamPreset {
  /** The picker's value. */
  id: string;
  /** What the picker lists, and the name the form starts with. Blank leaves the name to be typed. */
  name: string;
  kind: UpstreamKind;
  /** The issuer the form starts with, or blank when each install has its own. */
  issuer: string;
  /** What the issuer field shows while it is blank. */
  issuerExample: string;
  /** Where to register Heautou at the provider, shown in step 1. */
  registerAt: string;
}

/** The picker's value for a provider not in the list. */
export const OTHER_UPSTREAM = 'oidc';

/** The generic provider, for one not in the list. */
const GENERIC_UPSTREAM: UpstreamPreset = {
  id: OTHER_UPSTREAM,
  name: '',
  kind: UpstreamKind.Oidc,
  issuer: '',
  issuerExample: 'https://id.example.com',
  registerAt: 'The provider’s client or application settings, as a confidential web client.',
};

/** The providers the picker lists, in its order, and the generic one last. */
export const UPSTREAM_PRESETS: readonly UpstreamPreset[] = [
  {
    id: 'google',
    name: 'Google',
    kind: UpstreamKind.Oidc,
    issuer: 'https://accounts.google.com',
    issuerExample: 'https://accounts.google.com',
    registerAt: 'Google Cloud console, under APIs & Services, Credentials: an OAuth client ID for a web application.',
  },
  {
    id: 'github',
    name: 'GitHub',
    kind: UpstreamKind.Github,
    issuer: '',
    issuerExample: '',
    registerAt: 'GitHub, under Settings, Developer settings, OAuth Apps: the authorization callback URL.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    kind: UpstreamKind.Oidc,
    issuer: 'https://gitlab.com',
    issuerExample: 'https://gitlab.com',
    registerAt: 'GitLab, under Preferences, Applications, with the openid, profile and email scopes.',
  },
  {
    id: 'authentik',
    name: 'Authentik',
    kind: UpstreamKind.Oidc,
    issuer: '',
    issuerExample: 'https://authentik.example.com/application/o/heautou/',
    registerAt: 'Authentik, as an OAuth2/OpenID provider and an application. Its issuer is the application’s URL.',
  },
  GENERIC_UPSTREAM,
];

/** The picker's rows. */
export const UPSTREAM_PRESET_OPTIONS = UPSTREAM_PRESETS.map((preset) => ({
  value: preset.id,
  label: preset.id === OTHER_UPSTREAM ? 'Another OpenID Connect provider' : preset.name,
}));

/**
 * Finds a preset by the picker's value.
 *
 * @param id - The picker's value.
 * @returns The preset, or the generic one for a value not in the list.
 */
export function upstreamPresetById(id: string): UpstreamPreset {
  return UPSTREAM_PRESETS.find((preset) => preset.id === id) ?? GENERIC_UPSTREAM;
}

/** Runs of anything that is not a lower-case letter or a digit, which become one dash. */
const NOT_ID_CHARACTERS = /[^a-z0-9]+/g;
/** Dashes at either end. */
const EDGE_DASHES = /^-+|-+$/g;

/**
 * Makes a provider ID from its name: lower case, with dashes between words.
 *
 * @param name - The provider's name.
 * @returns The ID, or blank when the name has no letters or digits.
 */
export function upstreamIdOf(name: string): string {
  return name.toLowerCase().replace(NOT_ID_CHARACTERS, '-').replace(EDGE_DASHES, '');
}
