import { z } from 'zod';
import { ADMIN_DEFAULTS, UPSTREAM_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import { replaceGroupIn } from './claims.ts';
import { redirectUriProblem } from './redirect-uris.ts';
import type { SecretMapper } from './sealed-document.ts';

/** How an upstream provider signs users in. */
export const UpstreamKind = {
  /** An OpenID Connect provider, found by discovery: Google, Microsoft, GitLab, another heautou... */
  Oidc: 'oidc',
  /** GitHub, which is plain OAuth 2.0: who signed in is read from its API. */
  GitHub: 'github',
} as const;
export type UpstreamKind = (typeof UpstreamKind)[keyof typeof UpstreamKind];

/** What happens to an upstream identity no local user is linked to. */
export const UnknownIdentity = {
  /** It is turned away. A user links it from their account page first. */
  Refuse: 'refuse',
  /** A local user is made for it and linked, within the provider's creation rules. */
  Create: 'create',
} as const;
export type UnknownIdentity = (typeof UnknownIdentity)[keyof typeof UnknownIdentity];

/** One upstream group that gives a local group. */
export interface GroupMapping {
  /** A value of the provider's groups claim. */
  upstream: string;
  /** The local group a user holding it is put in. */
  local: string;
}

/** A provider users may sign in through instead of with a password. */
export interface UpstreamProvider {
  /** Lower-case letters, digits and dashes. Part of its redirect URI, so it never changes. */
  id: string;
  /** What the sign-in button says after "Sign in with". */
  name: string;
  kind: UpstreamKind;
  /** The OpenID Connect issuer, discovered from. Null for GitHub. */
  issuer: string | null;
  /** The client ID this server was given there. */
  clientId: string;
  /** The client secret this server was given there, sealed on disk under `SECRET_KEY`. Null for a public client. */
  clientSecret: string | null;
  /** What is asked for. An OpenID Connect provider always gets `openid`. */
  scopes: string[];
  unknownIdentity: UnknownIdentity;
  /**
   * When `unknownIdentity` creates users, the email domains their verified address must be in. Empty creates a
   * user for any identity.
   */
  createDomains: string[];
  /** The groups a user it creates starts in. */
  createGroups: string[];
  /**
   * Whether a sign-in through it counts as both factors, so a user with a second factor here is not asked for it
   * again. Off, they are.
   */
  countsAsBothFactors: boolean;
  /** The claim the provider lists the user's groups in, for `groupMappings`. Null maps nothing. */
  groupsClaim: string | null;
  /** Upstream groups that put a user in a local group each time they sign in through it. */
  groupMappings: GroupMapping[];
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** An upstream identity tied to one local user. */
export interface UpstreamLink {
  userId: string;
  providerId: string;
  /** The issuer that vouched for the identity: the ID token's `iss`, or GitHub's own. */
  issuer: string;
  /** The identity there: the ID token's `sub`, or GitHub's numeric user id. */
  subject: string;
  /** What the user is shown it as: an address or a username. */
  label: string;
  /** When it was linked, as an ISO 8601 string. */
  linkedAt: string;
  /** When it last signed in, as an ISO 8601 string. Null when it never has. */
  lastUsedAt: string | null;
}

/** The upstreams file. */
export interface UpstreamsDocument {
  providers: UpstreamProvider[];
  links: UpstreamLink[];
}

/** The file before anything is added. */
export const EMPTY_UPSTREAMS: Readonly<UpstreamsDocument> = Object.freeze({ providers: [], links: [] });

/** Who an identity is, as the sign-in learned it, without what it says about the person. */
export type IdentityKey = Pick<UpstreamLink, 'providerId' | 'issuer' | 'subject'>;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** A domain an address may end in, such as `example.com`. */
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** What a scope may hold (RFC 6749 section 3.3). */
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
/** The scope every OpenID Connect sign-in asks for. */
const OPENID_SCOPE = 'openid';

const groupName = z
  .string()
  .trim()
  .min(1)
  .refine((group) => group !== ADMIN_DEFAULTS.group, {
    error: `"${ADMIN_DEFAULTS.group}" is given here by an admin, never by an upstream provider`,
  });

/**
 * Keeps each value of a list once.
 *
 * @param values - The list.
 * @returns It without repeats, in order.
 */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** What the admin writes when adding or changing a provider; the secret is handled on its own. */
const upstreamFields = z.object({
  name: z.string().trim().min(1, 'give the provider a name').max(UPSTREAM_DEFAULTS.maxNameLength),
  kind: z.enum(UpstreamKind),
  issuer: z
    .url({ protocol: /^https?$/ })
    .trim()
    .transform((issuer) => issuer.replace(/\/+$/, ''))
    .nullable()
    .default(null),
  clientId: z.string().trim().min(1, 'give the client ID the provider gave you'),
  scopes: z.array(z.string().trim().regex(SCOPE_PATTERN, 'a scope is one word')).transform(unique).default([]),
  unknownIdentity: z.enum(UnknownIdentity).default(UnknownIdentity.Refuse),
  createDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .transform((domain) => domain.replace(/^@/, ''))
        .pipe(z.string().regex(DOMAIN_PATTERN, 'write a domain such as example.com')),
    )
    .transform(unique)
    .default([]),
  createGroups: z.array(groupName).transform(unique).default([]),
  countsAsBothFactors: z.boolean().default(false),
  groupsClaim: z
    .string()
    .trim()
    .transform((claim) => (claim === '' ? null : claim))
    .nullable()
    .default(null),
  groupMappings: z
    .array(z.object({ upstream: z.string().trim().min(1, 'name the upstream group'), local: groupName }))
    .default([]),
});

/**
 * Checks the rules between fields: an OpenID Connect provider has an issuer and GitHub has none, and a mapping
 * needs a claim to read.
 *
 * @param fields - The parsed fields.
 * @param ctx - Where problems are reported.
 */
function checkKind(fields: z.infer<typeof upstreamFields>, ctx: z.RefinementCtx): void {
  if (fields.kind === UpstreamKind.Oidc && fields.issuer === null) {
    ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'give the issuer URL' });
  }
  if (fields.groupMappings.length > 0 && fields.groupsClaim === null) {
    ctx.addIssue({ code: 'custom', path: ['groupsClaim'], message: 'name the claim the mapped groups are in' });
  }
}

const upstreamFieldsSchema = upstreamFields.superRefine(checkKind);

/** A provider's fields as the admin sends them. A secret left out, null or blank keeps the one saved. */
export type UpstreamFields = z.input<typeof upstreamFields> & { clientSecret?: string | null };

/** A provider to add. */
export type NewUpstream = UpstreamFields & { id: string };

const idSchema = z
  .string()
  .trim()
  .min(1, 'give the provider an id')
  .max(UPSTREAM_DEFAULTS.maxIdLength)
  .regex(ID_PATTERN, 'use lower-case letters, digits and "-", starting with a letter or digit');

/** The upstream providers and the identities linked to users, kept in one JSON file. */
export interface UpstreamStore {
  list: () => UpstreamProvider[];
  find: (id: string) => UpstreamProvider | null;
  create: (input: NewUpstream) => Promise<UpstreamProvider>;
  update: (id: string, input: UpstreamFields) => Promise<UpstreamProvider>;
  /**
   * Removes a provider and every identity linked through it.
   *
   * @param id - The provider.
   * @returns It, and how many links went with it.
   */
  remove: (id: string) => Promise<{ provider: UpstreamProvider; unlinked: number }>;
  /** Every identity linked to a user, oldest first. */
  linksOf: (userId: string) => UpstreamLink[];
  /** How many identities are linked through a provider. */
  linkCount: (providerId: string) => number;
  /**
   * Finds the link of an identity.
   *
   * @param key - The provider, the issuer and the subject.
   * @returns It, or null when the identity is linked to nobody.
   */
  findLink: (key: IdentityKey) => UpstreamLink | null;
  /**
   * Links an identity to a user. An identity belongs to one user, and a user has one identity per provider.
   *
   * @param userId - The user.
   * @param key - The identity.
   * @param label - What the user is shown it as.
   * @returns The link.
   * @throws BAD_USER_INPUT when the identity is someone else's, or the user already has one there.
   */
  link: (userId: string, key: IdentityKey, label: string) => Promise<UpstreamLink>;
  /**
   * Records a sign-in through a link.
   *
   * @param key - The identity.
   */
  usedLink: (key: IdentityKey) => Promise<void>;
  /**
   * Unlinks a user's identity at a provider.
   *
   * @param userId - The user.
   * @param providerId - The provider.
   * @returns The link that was removed.
   * @throws NOT_FOUND when they have none there.
   */
  unlink: (userId: string, providerId: string) => Promise<UpstreamLink>;
  /**
   * Unlinks everything of a user, as for a deleted user.
   *
   * @param userId - The user.
   * @returns How many links they had.
   */
  removeUser: (userId: string) => Promise<number>;
  /**
   * Renames a local group in every provider's created groups and mappings, or takes it out of them.
   *
   * @param from - The group.
   * @param to - Its new name, or null to remove it.
   */
  replaceGroup: (from: string, to: string | null) => Promise<void>;
}

/** What the upstream store is built with besides its file. */
export interface UpstreamStoreOptions {
  /** The clock, for `createdAt` and the link times. */
  now?: () => Date;
  /** Whether a plain http issuer is allowed on any host. Asked on every save; refused when left out. */
  allowsHttp?: () => boolean;
}

/**
 * Finds the secrets in the upstreams file: each provider's client secret.
 *
 * @param document - The file as stored.
 * @param change - Seals or opens one secret.
 * @returns The file with its secrets changed.
 */
export const upstreamSecretsIn: SecretMapper<UpstreamsDocument> = (document, change) => ({
  ...document,
  providers: (document.providers ?? []).map((provider) =>
    typeof provider.clientSecret === 'string' ? { ...provider, clientSecret: change(provider.clientSecret) } : provider,
  ),
});

/**
 * Says whether two identities are the same one.
 *
 * @param link - A stored link.
 * @param key - The identity looked for.
 * @returns Whether the provider, the issuer and the subject all match.
 */
function isSameIdentity(link: IdentityKey, key: IdentityKey): boolean {
  return link.providerId === key.providerId && link.issuer === key.issuer && link.subject === key.subject;
}

/**
 * Builds the upstream store over a JSON file. An issuer is held to the https rule redirect URIs are
 * (`redirect-uris.ts`) when a provider is saved.
 *
 * @param file - The file holding the providers and the links.
 * @param [options] - The clock and whether plain http issuers are allowed.
 * @returns The store.
 */
export function createUpstreamStore(
  file: DataDocument<UpstreamsDocument>,
  options: UpstreamStoreOptions = {},
): UpstreamStore {
  const { now = () => new Date(), allowsHttp = () => false } = options;
  const read = (): UpstreamsDocument => {
    const { providers = [], links = [] } = file.read();
    return { providers, links };
  };
  const find = (id: string): UpstreamProvider | null => read().providers.find((provider) => provider.id === id) ?? null;
  const load = (id: string): UpstreamProvider => {
    const provider = find(id);
    if (provider === null) {
      throw notFound(`No upstream provider has the id "${id}".`);
    }
    return provider;
  };
  const write = async (change: (document: UpstreamsDocument) => UpstreamsDocument): Promise<void> => {
    await file.update(() => change(read()));
  };

  /**
   * Checks a provider's fields and settles what they leave to the kind.
   *
   * @param input - What the admin sent.
   * @param current - The provider as saved, or null for a new one.
   * @returns Every field but the id and the creation time.
   */
  const settle = (
    input: UpstreamFields,
    current: UpstreamProvider | null,
  ): Omit<UpstreamProvider, 'id' | 'createdAt'> => {
    const { clientSecret: sentSecret, ...rest } = input;
    const fields = parseInput(upstreamFieldsSchema, rest);
    const isOidc = fields.kind === UpstreamKind.Oidc;
    const issuer = isOidc ? fields.issuer : null;
    const issuerProblem =
      issuer === null ? null : redirectUriProblem(issuer, { allowsHttp: allowsHttp(), isPublic: false });
    if (issuerProblem !== null) {
      throw badInput(`issuer: ${issuerProblem}.`);
    }
    const typedSecret = sentSecret?.trim() ?? '';
    const clientSecret = typedSecret === '' ? (current?.clientSecret ?? null) : typedSecret;
    if (fields.kind === UpstreamKind.GitHub && clientSecret === null) {
      throw badInput('clientSecret: GitHub gives every OAuth app a client secret; paste it here.');
    }
    const defaultScopes = isOidc ? UPSTREAM_DEFAULTS.oidcScopes : UPSTREAM_DEFAULTS.githubScopes;
    const asked = fields.scopes.length === 0 ? [...defaultScopes] : fields.scopes;
    const scopes = isOidc && asked.includes(OPENID_SCOPE) === false ? [OPENID_SCOPE, ...asked] : asked;
    return { ...fields, issuer, clientSecret, scopes };
  };

  return {
    list: () => read().providers,
    find,
    create: async (input) => {
      const { id: sentId, ...fields } = input;
      const id = parseInput(idSchema, sentId);
      if (find(id) !== null) {
        throw badInput(`id: "${id}" is already taken.`);
      }
      const provider: UpstreamProvider = { id, ...settle(fields, null), createdAt: now().toISOString() };
      await write((document) => ({ ...document, providers: [...document.providers, provider] }));
      return provider;
    },
    update: async (id, input) => {
      const current = load(id);
      const next: UpstreamProvider = { ...current, ...settle(input, current) };
      await write((document) => ({
        ...document,
        providers: document.providers.map((provider) => (provider.id === id ? next : provider)),
      }));
      return next;
    },
    remove: async (id) => {
      const provider = load(id);
      const unlinked = read().links.filter((link) => link.providerId === id).length;
      await write((document) => ({
        providers: document.providers.filter((each) => each.id !== id),
        links: document.links.filter((link) => link.providerId !== id),
      }));
      return { provider, unlinked };
    },
    linksOf: (userId) => read().links.filter((link) => link.userId === userId),
    linkCount: (providerId) => read().links.filter((link) => link.providerId === providerId).length,
    findLink: (key) => read().links.find((link) => isSameIdentity(link, key)) ?? null,
    link: async (userId, key, label) => {
      const { providers, links } = read();
      const provider = providers.find((each) => each.id === key.providerId);
      if (provider === undefined) {
        throw notFound(`No upstream provider has the id "${key.providerId}".`);
      }
      const owner = links.find((link) => isSameIdentity(link, key));
      if (owner !== undefined && owner.userId !== userId) {
        throw badInput(`That ${provider.name} account is already linked to another user.`);
      }
      if (owner !== undefined) {
        return owner;
      }
      const hasOne = links.some((link) => link.userId === userId && link.providerId === key.providerId);
      if (hasOne) {
        throw badInput(`You already have a ${provider.name} account linked. Unlink it first.`);
      }
      const linked: UpstreamLink = { userId, ...key, label, linkedAt: now().toISOString(), lastUsedAt: null };
      await write((document) => ({ ...document, links: [...document.links, linked] }));
      return linked;
    },
    usedLink: async (key) => {
      const at = now().toISOString();
      await write((document) => ({
        ...document,
        links: document.links.map((link) => (isSameIdentity(link, key) ? { ...link, lastUsedAt: at } : link)),
      }));
    },
    unlink: async (userId, providerId) => {
      const found = read().links.find((link) => link.userId === userId && link.providerId === providerId);
      if (found === undefined) {
        throw notFound(`Nothing is linked at "${providerId}".`);
      }
      await write((document) => ({ ...document, links: document.links.filter((link) => link !== found) }));
      return found;
    },
    removeUser: async (userId) => {
      const count = read().links.filter((link) => link.userId === userId).length;
      if (count > 0) {
        await write((document) => ({ ...document, links: document.links.filter((link) => link.userId !== userId) }));
      }
      return count;
    },
    replaceGroup: async (from, to) => {
      const isUsed = read().providers.some(
        (provider) =>
          provider.createGroups.includes(from) || provider.groupMappings.some((mapping) => mapping.local === from),
      );
      if (isUsed === false) {
        return;
      }
      await write((document) => ({
        ...document,
        providers: document.providers.map((provider) => ({
          ...provider,
          createGroups: replaceGroupIn(provider.createGroups, from, to),
          groupMappings: provider.groupMappings.flatMap((mapping) =>
            mapping.local === from ? (to === null ? [] : [{ ...mapping, local: to }]) : [mapping],
          ),
        })),
      }));
    },
  };
}
