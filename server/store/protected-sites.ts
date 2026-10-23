import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseInput } from '../core/validation.ts';
import type { DataDocument } from '../db/document.ts';
import { replaceGroupIn } from './claims.ts';

/** A DNS name in lowercase: labels of letters, digits and inner dashes, joined by dots. */
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** A path prefix: one or more `/segment`s of URL path characters, no dot segments. */
const PATH_PREFIX_PATTERN = /^(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+$/;
const PATH_SEPARATOR = '/';

/** A site behind the reverse proxy that only signed-in users may reach. */
export interface ProtectedSite {
  /** A random id. */
  id: string;
  /** What the operator calls it. */
  name: string;
  /** The host the proxy is asked about, lowercase, without a port. */
  host: string;
  /** Only paths under this one, at a `/` boundary, such as `/admin`. Empty for the whole host. */
  pathPrefix: string;
  /** Only users in one of these groups may reach it. Empty lets every enabled user in. */
  allowedGroups: string[];
  /** Whether the user must have signed in with a second factor (`acr` `mfa`). */
  requireSecondFactor: boolean;
  /** When it was added, as an ISO 8601 string. */
  createdAt: string;
}

/** The forward auth settings and sites, as the file holds them. */
export interface ProtectedSitesDocument {
  /** The parent domain the proxy session cookie is set on, without a leading dot. Left out for Heautou's own host. */
  cookieDomain?: string;
  sites: ProtectedSite[];
}

/** A new site's empty file. */
export const EMPTY_PROTECTED_SITES: ProtectedSitesDocument = Object.freeze({ sites: [] });

const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOST_PATTERN, 'a host name such as sonarr.home.lan, with no scheme, port or path');

const siteFieldsSchema = z.object({
  name: z.string().trim().min(1, 'give the site a name').max(FORWARD_AUTH_DEFAULTS.maxNameLength),
  host: hostSchema,
  pathPrefix: z
    .string()
    .trim()
    .transform((prefix) => prefix.replace(/\/+$/, ''))
    .refine((prefix) => prefix === '' || PATH_PREFIX_PATTERN.test(prefix), 'a path such as /admin, or empty')
    .default(''),
  allowedGroups: z
    .array(z.string().trim().min(1))
    .transform((groups) => [...new Set(groups)])
    .default([]),
  requireSecondFactor: z.boolean().default(false),
});

/** What the operator sets on a site. Left out, the path is the whole host, every user may in and no second factor is asked. */
export type SiteFields = z.input<typeof siteFieldsSchema>;

/**
 * Says whether a path is under a site's prefix, at a segment boundary: `/admin` covers `/admin` and `/admin/x`,
 * not `/administrator`.
 *
 * @param prefix - The site's prefix; empty covers everything.
 * @param path - The request's path, without the query.
 * @returns Whether it is covered.
 */
export function isUnderPrefix(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(`${prefix}${PATH_SEPARATOR}`);
}

/**
 * Says what is wrong with a cookie domain for this issuer: the browser only takes a cookie for the host it came from
 * or a parent of it.
 *
 * @param domain - The domain, without a leading dot.
 * @param issuerHost - The host Heautou is reached at.
 * @returns The problem, or null when the browser will take it.
 */
export function cookieDomainProblem(domain: string, issuerHost: string): string | null {
  if (HOST_PATTERN.test(domain) === false) {
    return `"${domain}" is not a domain name such as home.lan`;
  }
  if (domain.includes('.') === false) {
    return `"${domain}" is a single label; browsers refuse cookies for a top-level domain, so use one such as home.lan`;
  }
  const host = issuerHost.toLowerCase();
  const isCovered = host === domain || host.endsWith(`.${domain}`);
  return isCovered
    ? null
    : `Heautou is at ${host}, which is not under ${domain}, so the browser would refuse a cookie for it`;
}

/** The sites forward auth protects, and the domain its session cookie is set on. */
export interface ProtectedSiteStore {
  /** Every site, oldest first. */
  list: () => ProtectedSite[];
  /**
   * Looks a site up.
   *
   * @param id - The site's id.
   * @returns It, or null.
   */
  find: (id: string) => ProtectedSite | null;
  /**
   * Finds the site a request is for: the one on its host with the longest path prefix covering its path.
   *
   * @param host - The request's host, without a port.
   * @param path - The request's path, without the query.
   * @returns The site, or null when no site covers it.
   */
  match: (host: string, path: string) => ProtectedSite | null;
  /**
   * Adds a site.
   *
   * @param fields - Its settings.
   * @returns The site.
   * @throws BAD_USER_INPUT when a field is wrong, or another site has the same host and path.
   */
  create: (fields: SiteFields) => Promise<ProtectedSite>;
  /**
   * Changes a site.
   *
   * @param id - The site's id.
   * @param fields - Its new settings.
   * @returns The site.
   * @throws NOT_FOUND when there is no such site; BAD_USER_INPUT as for `create`.
   */
  update: (id: string, fields: SiteFields) => Promise<ProtectedSite>;
  /**
   * Removes a site.
   *
   * @param id - The site's id.
   * @returns The removed site.
   * @throws NOT_FOUND when there is no such site.
   */
  remove: (id: string) => Promise<ProtectedSite>;
  /**
   * Renames or removes a group in every site's allowed groups.
   *
   * @param from - The group.
   * @param to - Its new name, or null to remove it.
   */
  replaceGroup: (from: string, to: string | null) => Promise<void>;
  /** The cookie domain the admin chose, or null for Heautou's own host. */
  cookieDomain: () => string | null;
  /**
   * Chooses the cookie domain.
   *
   * @param domain - The domain, with or without a leading dot, or null for Heautou's own host.
   * @returns The domain as kept.
   * @throws BAD_USER_INPUT when the browser would refuse a cookie for it from Heautou's host.
   */
  setCookieDomain: (domain: string | null) => Promise<string | null>;
}

/**
 * Opens the protected site store on its file.
 *
 * @param document - The document.
 * @param options - Where Heautou is, to check the cookie domain against, and the clock.
 * @param options.issuerHost - The issuer's host.
 * @param [options.now] - The clock, in epoch milliseconds.
 * @returns The store.
 */
export function createProtectedSiteStore(
  document: DataDocument<ProtectedSitesDocument>,
  { issuerHost, now = Date.now }: { issuerHost: string; now?: () => number },
): ProtectedSiteStore {
  const sites = (): ProtectedSite[] => document.read().sites ?? [];
  const find = (id: string): ProtectedSite | null => sites().find((site) => site.id === id) ?? null;
  const load = (id: string): ProtectedSite => {
    const site = find(id);
    if (site === null) {
      throw notFound(`No protected site has the id "${id}".`);
    }
    return site;
  };
  const checked = (input: SiteFields, id: string | null): z.infer<typeof siteFieldsSchema> => {
    const fields = parseInput(siteFieldsSchema, input);
    const twin = sites().find(
      (site) => site.id !== id && site.host === fields.host && site.pathPrefix === fields.pathPrefix,
    );
    if (twin !== undefined) {
      throw badInput(`host: "${twin.name}" already covers ${fields.host}${fields.pathPrefix}.`);
    }
    return fields;
  };
  const write = async (next: ProtectedSite[]): Promise<void> => {
    await document.update((current) => ({ ...current, sites: next }));
  };

  return {
    list: sites,
    find,
    match: (host, path) => {
      const name = host.toLowerCase();
      const covering = sites().filter((site) => site.host === name && isUnderPrefix(site.pathPrefix, path));
      return covering.reduce<ProtectedSite | null>(
        (best, site) => (best === null || site.pathPrefix.length > best.pathPrefix.length ? site : best),
        null,
      );
    },
    create: async (input) => {
      const site: ProtectedSite = {
        ...checked(input, null),
        id: randomUUID(),
        createdAt: new Date(now()).toISOString(),
      };
      await write([...sites(), site]);
      return site;
    },
    update: async (id, input) => {
      const current = load(id);
      const site: ProtectedSite = { ...current, ...checked(input, id) };
      await write(sites().map((other) => (other.id === id ? site : other)));
      return site;
    },
    remove: async (id) => {
      const site = load(id);
      await write(sites().filter((other) => other.id !== id));
      return site;
    },
    replaceGroup: async (from, to) => {
      const isUsed = sites().some((site) => site.allowedGroups.includes(from));
      if (isUsed) {
        await write(sites().map((site) => ({ ...site, allowedGroups: replaceGroupIn(site.allowedGroups, from, to) })));
      }
    },
    cookieDomain: () => document.read().cookieDomain ?? null,
    setCookieDomain: async (input) => {
      const domain = input === null ? '' : input.trim().toLowerCase().replace(/^\.+/, '');
      if (domain === '') {
        await document.update(({ cookieDomain: _previous, ...rest }) => rest);
        return null;
      }
      const problem = cookieDomainProblem(domain, issuerHost);
      if (problem !== null) {
        throw badInput(`cookieDomain: ${problem}.`);
      }
      await document.update((current) => ({ ...current, cookieDomain: domain }));
      return domain;
    },
  };
}
