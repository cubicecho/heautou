import { type BrandingView, brandingView } from '../admin/admin-client.ts';
import type { Context } from '../core/context.ts';
import { AuditType, BRANDING_TARGET, KEYS_TARGET, recordAdminChange, SETTINGS_TARGET } from '../store/audit.ts';
import type { ProviderKeys } from '../store/keys.ts';
import { type HttpRedirectSetting, MAX_PASSWORD_SCORE, type PasswordRules } from '../store/settings.ts';

/** The settings part of the admin API: the signing keys, branding, plain http redirect URIs and password rules. */
export const SETTINGS_TYPE_DEFS = /* GraphQL */ `
  "One key tokens are signed with."
  type SigningKey {
    kid: ID!
    "Whether it signs new tokens. The others only verify older ones."
    isCurrent: Boolean!
  }

  "The provider's signing and cookie keys."
  type Keys {
    "When they were last made, as an ISO 8601 string."
    rotatedAt: String
    signingKeys: [SigningKey!]!
  }

  "Whether redirect URIs may be plain http on any host. https, loopback http and a native app's own scheme are always allowed."
  type HttpRedirects {
    isAllowed: Boolean!
    "False while the operator has not chosen, so it follows the issuer: allowed when the issuer is plain http."
    isSet: Boolean!
    "Whether ISSUER_URL is plain http."
    isIssuerHttp: Boolean!
  }

  "What a new password must pass besides its length. Existing passwords keep working."
  type PasswordRules {
    "The lowest zxcvbn score a new password may have, from 0 (anything) to ${MAX_PASSWORD_SCORE} (very hard to guess)."
    minScore: Int!
    "Whether a new password is looked up in Have I Been Pwned, by the first 5 characters of its SHA-1."
    checkBreaches: Boolean!
  }

  "What the sign-in page and the sidebar show the provider as."
  type Branding {
    name: String!
    "Where the logo is served. Null when there is none."
    logoUrl: String
  }

  extend type Query {
    "The signing keys."
    keys: Keys!
    "The provider's name and logo."
    branding: Branding!
    "Whether redirect URIs may be plain http."
    httpRedirects: HttpRedirects!
    passwordRules: PasswordRules!
  }

  extend type Mutation {
    "Makes new signing and cookie keys. The previous ones keep verifying what they signed."
    rotateKeys: Keys!
    "Names the provider on the sign-in page and in the sidebar."
    setBrandingName(name: String!): Branding!
    "Sets the logo from a base64 data URL (PNG, JPEG, WebP or SVG), or removes it with null."
    setBrandingLogo(dataUrl: String): Branding!
    "Allows or refuses plain http redirect URIs for clients saved from now on. Null follows the issuer again."
    setHttpRedirects(allowed: Boolean): HttpRedirects!
    "Changes what a new password must pass. A rule left out keeps its value."
    setPasswordRules(minScore: Int, checkBreaches: Boolean): PasswordRules!
  }
`;

/** What `Keys` resolves from. */
interface KeysView {
  rotatedAt: string | null;
  signingKeys: { kid: string; isCurrent: boolean }[];
}

/**
 * Describes the keys without their private parts.
 *
 * @param keys - The provider's keys.
 * @returns The key ids, newest first, and when they were made.
 */
function keysView(keys: ProviderKeys): KeysView {
  return {
    rotatedAt: keys.rotatedAt ?? null,
    signingKeys: keys.jwks.map((jwk, index) => ({ kid: String(jwk.kid), isCurrent: index === 0 })),
  };
}

/** The resolvers for the settings, merged with the rest of the schema's. */
export const settingsResolvers = {
  Query: {
    /**
     * Resolves `Query.keys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The key ids and when they were made.
     */
    keys: (_parent: unknown, _args: unknown, ctx: Context): KeysView => keysView(ctx.keys.current()),
    /**
     * Resolves `Query.branding`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The name and logo URL.
     */
    branding: (_parent: unknown, _args: unknown, ctx: Context): BrandingView => brandingView(ctx.branding.read()),
    /**
     * Resolves `Query.httpRedirects`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns Whether plain http redirect URIs are allowed, and why.
     */
    httpRedirects: (_parent: unknown, _args: unknown, ctx: Context): HttpRedirectSetting =>
      ctx.settings.httpRedirects(),
    /**
     * Resolves `Query.passwordRules`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The strength and breach rules.
     */
    passwordRules: (_parent: unknown, _args: unknown, ctx: Context): PasswordRules => ctx.settings.passwordRules(),
  },
  Mutation: {
    /**
     * Resolves `Mutation.rotateKeys`.
     *
     * @param _parent - Unused.
     * @param _args - Unused.
     * @param ctx - Request context.
     * @returns The keys after the rotation.
     */
    rotateKeys: async (_parent: unknown, _args: unknown, ctx: Context): Promise<KeysView> => {
      const keys = keysView(await ctx.keys.rotate());
      ctx.host.refresh();
      recordAdminChange(ctx, AuditType.KeysRotated, KEYS_TARGET, { kid: keys.signingKeys[0]?.kid ?? '' });
      return keys;
    },
    /**
     * Resolves `Mutation.setBrandingName`.
     *
     * @param _parent - Unused.
     * @param args - The name.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingName: async (_parent: unknown, args: { name: string }, ctx: Context): Promise<BrandingView> => {
      const branding = await ctx.branding.setName(args.name);
      recordAdminChange(ctx, AuditType.BrandingNameSet, BRANDING_TARGET, { name: branding.name });
      return brandingView(branding);
    },
    /**
     * Resolves `Mutation.setBrandingLogo`.
     *
     * @param _parent - Unused.
     * @param args - The image as a data URL, or null.
     * @param ctx - Request context.
     * @returns The branding.
     */
    setBrandingLogo: async (
      _parent: unknown,
      args: { dataUrl?: string | null },
      ctx: Context,
    ): Promise<BrandingView> => {
      const branding = await ctx.branding.setLogo(args.dataUrl ?? null);
      recordAdminChange(ctx, AuditType.BrandingLogoSet, BRANDING_TARGET, {
        logo: branding.logo === null ? 'removed' : 'set',
      });
      return brandingView(branding);
    },
    /**
     * Resolves `Mutation.setHttpRedirects`.
     *
     * @param _parent - Unused.
     * @param args - Whether to allow them, or null to follow the issuer.
     * @param ctx - Request context.
     * @returns The setting.
     */
    setHttpRedirects: async (
      _parent: unknown,
      args: { allowed?: boolean | null },
      ctx: Context,
    ): Promise<HttpRedirectSetting> => {
      const setting = await ctx.settings.setHttpRedirects(args.allowed ?? null);
      recordAdminChange(ctx, AuditType.HttpRedirectsSet, SETTINGS_TARGET, {
        httpRedirects: setting.isAllowed ? 'allowed' : 'refused',
        chosenBy: setting.isSet ? 'operator' : 'issuer',
      });
      return setting;
    },
    /**
     * Resolves `Mutation.setPasswordRules`.
     *
     * @param _parent - Unused.
     * @param args - The rules to change; null or left out keeps one.
     * @param ctx - Request context.
     * @returns The rules.
     */
    setPasswordRules: async (
      _parent: unknown,
      args: { minScore?: number | null; checkBreaches?: boolean | null },
      ctx: Context,
    ): Promise<PasswordRules> => {
      const rules = await ctx.settings.setPasswordRules({
        ...(args.minScore === undefined || args.minScore === null ? {} : { minScore: args.minScore }),
        ...(args.checkBreaches === undefined || args.checkBreaches === null
          ? {}
          : { checkBreaches: args.checkBreaches }),
      });
      recordAdminChange(ctx, AuditType.PasswordRulesSet, SETTINGS_TARGET, {
        minScore: String(rules.minScore),
        breachCheck: rules.checkBreaches ? 'on' : 'off',
      });
      return rules;
    },
  },
};
