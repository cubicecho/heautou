import type { GraphQLResolveInfo } from 'graphql';
import { adminUrls } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { FORWARD_AUTH_DEFAULTS } from '../core/defaults.ts';
import { badInput } from '../core/errors.ts';
import { FLAG_ON, FORWARD_AUTH_PARAM, FORWARD_AUTH_PATH } from '../forward-auth/client.ts';
import {
  type AuditEvent,
  AuditType,
  PROXY_COOKIE_DOMAIN_TARGET,
  recordAdminChange,
  siteTarget,
} from '../store/audit.ts';
import type { ProtectedSite, SiteFields } from '../store/protected-sites.ts';
import { GeneratedTable, requiredRow, rowWhere } from './rows.ts';

/** The protected sites and forward auth settings, beside the rest of the admin API. */
export const FORWARD_AUTH_TYPE_DEFS = /* GraphQL */ `
  "How a reverse proxy is pointed at forward auth."
  type ForwardAuth {
    "The domain the session cookie is set on, so every site under it shares the sign-in. Null for Heautou's own host."
    cookieDomain: String
    "Whether FORWARD_AUTH_COOKIE_DOMAIN sets it, which wins over setForwardAuthCookieDomain."
    isCookieDomainFromEnvironment: Boolean!
    "The verify endpoint at Heautou's public address. Answers 401 when nobody is signed in (nginx)."
    verifyUrl: String!
    "The same, answering a browser with a redirect to sign in (HAProxy, Caddy, Traefik)."
    verifyRedirectUrl: String!
    "Where a user signs out of the protected sites."
    signOutUrl: String!
    "FORWARD_AUTH_TRUSTED_PROXIES. Null when TRUST_PROXY and loopback decide which callers are proxies."
    trustedProxies: [String!]
    "Most characters a site's name may have."
    maxNameLength: Int!
  }

  "A protected site's settings. Left out, the whole host, every user, and no second factor."
  input ProtectedSiteInput {
    name: String!
    host: String!
    pathPrefix: String
    allowedGroups: [String!]
    requireSecondFactor: Boolean
  }

  extend type Query {
    "Forward auth's addresses and cookie domain."
    forwardAuth: ForwardAuth!
  }

  extend type Mutation {
    "Adds a protected site."
    createProtectedSite(input: ProtectedSiteInput!): ProtectedSite!
    "Changes a protected site."
    updateProtectedSite(id: ID!, input: ProtectedSiteInput!): ProtectedSite!
    "Removes a protected site. The proxy then refuses requests to it."
    deleteProtectedSite(id: ID!): ProtectedSite!
    "Sets the domain the session cookie is set on, or null for Heautou's own host. Refused while the environment sets it."
    setForwardAuthCookieDomain(domain: String): ForwardAuth!
  }
`;

/** What `ForwardAuth` resolves from. */
interface ForwardAuthView {
  cookieDomain: string | null;
  isCookieDomainFromEnvironment: boolean;
  verifyUrl: string;
  verifyRedirectUrl: string;
  signOutUrl: string;
  trustedProxies: readonly string[] | null;
  maxNameLength: number;
}

/** What `ProtectedSiteInput` arrives as: GraphQL sends null for a field left out. */
interface SiteInputArgs {
  name: string;
  host: string;
  pathPrefix?: string | null;
  allowedGroups?: string[] | null;
  requireSecondFactor?: boolean | null;
}

/**
 * Reads a `ProtectedSiteInput` as the store takes it: a null field is left out, so it takes its default.
 *
 * @param input - What GraphQL sent.
 * @returns The fields.
 */
function siteFieldsOf({ name, host, pathPrefix, allowedGroups, requireSecondFactor }: SiteInputArgs): SiteFields {
  return {
    name,
    host,
    ...(pathPrefix === null || pathPrefix === undefined ? {} : { pathPrefix }),
    ...(allowedGroups === null || allowedGroups === undefined ? {} : { allowedGroups }),
    ...(requireSecondFactor === null || requireSecondFactor === undefined ? {} : { requireSecondFactor }),
  };
}

/**
 * Describes forward auth for the admin UI.
 *
 * @param ctx - Request context.
 * @returns What `ForwardAuth` resolves from.
 */
function forwardAuthView(ctx: Context): ForwardAuthView {
  const { base } = adminUrls(ctx.issuer);
  const verifyUrl = `${base}${FORWARD_AUTH_PATH.verify}`;
  return {
    cookieDomain: ctx.forwardAuth.cookieDomain(),
    isCookieDomainFromEnvironment: ctx.forwardAuth.environmentCookieDomain !== null,
    verifyUrl,
    verifyRedirectUrl: `${verifyUrl}?${FORWARD_AUTH_PARAM.redirect}=${FLAG_ON}`,
    signOutUrl: `${base}${FORWARD_AUTH_PATH.signOut}`,
    trustedProxies: ctx.forwardAuth.trustedProxies,
    maxNameLength: FORWARD_AUTH_DEFAULTS.maxNameLength,
  };
}

/**
 * Records what the signed-in admin did to a site, and passes the site on.
 *
 * @param ctx - Request context.
 * @param type - What they did.
 * @param site - The site.
 * @param [detail] - What else to keep.
 * @returns The site.
 */
function auditedSite(ctx: Context, type: AuditType, site: ProtectedSite, detail?: AuditEvent['detail']): ProtectedSite {
  recordAdminChange(ctx, type, siteTarget(site), detail);
  return site;
}

/**
 * Describes where a site is, for the audit log.
 *
 * @param site - The site.
 * @returns Its host and path prefix.
 */
function siteDetail(site: ProtectedSite): Record<string, string> {
  return { address: `${site.host}${site.pathPrefix}` };
}

/**
 * Picks a site's row out by its id.
 *
 * @param id - The site.
 * @returns The filter.
 */
const byId = (id: string) => ({ id: { eq: id } });

export const forwardAuthResolvers = {
  Query: {
    /**
     * Resolves `Query.forwardAuth`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The addresses and the cookie domain.
     */
    forwardAuth: (_parent: unknown, _args: unknown, ctx: Context): ForwardAuthView => forwardAuthView(ctx),
  },
  Mutation: {
    /**
     * Resolves `Mutation.createProtectedSite`.
     *
     * @param _parent - Unused.
     * @param args - The site's settings.
     * @param ctx - Request context.
     * @returns The site.
     */
    createProtectedSite: async (
      _parent: unknown,
      args: { input: SiteInputArgs },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const site = await ctx.protectedSites.create(siteFieldsOf(args.input));
      auditedSite(ctx, AuditType.ProtectedSiteCreated, site, siteDetail(site));
      return requiredRow(ctx, info, GeneratedTable.ProtectedSites, byId(site.id));
    },
    /**
     * Resolves `Mutation.updateProtectedSite`.
     *
     * @param _parent - Unused.
     * @param args - The site's id and its new settings.
     * @param ctx - Request context.
     * @returns The site.
     */
    updateProtectedSite: async (
      _parent: unknown,
      args: { id: string; input: SiteInputArgs },
      ctx: Context,
      info: GraphQLResolveInfo,
    ) => {
      const site = await ctx.protectedSites.update(args.id, siteFieldsOf(args.input));
      auditedSite(ctx, AuditType.ProtectedSiteUpdated, site, siteDetail(site));
      return requiredRow(ctx, info, GeneratedTable.ProtectedSites, byId(site.id));
    },
    /**
     * Resolves `Mutation.deleteProtectedSite`.
     *
     * @param _parent - Unused.
     * @param args - The site's id.
     * @param ctx - Request context.
     * @returns The removed site.
     */
    deleteProtectedSite: async (_parent: unknown, args: { id: string }, ctx: Context, info: GraphQLResolveInfo) => {
      const row = await rowWhere(ctx, info, GeneratedTable.ProtectedSites, byId(args.id));
      const site = await ctx.protectedSites.remove(args.id);
      auditedSite(ctx, AuditType.ProtectedSiteDeleted, site, siteDetail(site));
      return row;
    },
    /**
     * Resolves `Mutation.setForwardAuthCookieDomain`.
     *
     * @param _parent - Unused.
     * @param args - The domain, or null for Heautou's own host.
     * @param ctx - Request context.
     * @returns Forward auth's settings.
     * @throws BAD_USER_INPUT while `FORWARD_AUTH_COOKIE_DOMAIN` is set, or for a domain the browser would refuse.
     */
    setForwardAuthCookieDomain: async (
      _parent: unknown,
      args: { domain?: string | null },
      ctx: Context,
    ): Promise<ForwardAuthView> => {
      if (ctx.forwardAuth.environmentCookieDomain !== null) {
        throw badInput('FORWARD_AUTH_COOKIE_DOMAIN sets the cookie domain. Change it there, or unset it.');
      }
      const domain = await ctx.protectedSites.setCookieDomain(args.domain ?? null);
      recordAdminChange(ctx, AuditType.ProxyCookieDomainSet, PROXY_COOKIE_DOMAIN_TARGET, {
        domain: domain ?? '(Heautou’s host)',
      });
      return forwardAuthView(ctx);
    },
  },
};
