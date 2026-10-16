import { z } from 'zod';

/** The claim a client gets the user's groups in unless it is told otherwise. */
export const DEFAULT_GROUPS_CLAIM = 'groups';

/**
 * Claims the provider sets itself or that OpenID Connect gives a meaning. A custom claim or a client's groups claim
 * may not take one of these names.
 */
const RESERVED_CLAIMS: ReadonlySet<string> = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'iat',
  'nbf',
  'jti',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'azp',
  'at_hash',
  'c_hash',
  's_hash',
  'sid',
  'scope',
  'client_id',
  'cnf',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'email',
  'email_verified',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'phone_number',
  'phone_number_verified',
  'address',
  'updated_at',
  DEFAULT_GROUPS_CLAIM,
]);

/** What a claim name may look like: a word, or a namespaced one such as `app.role` or `urn:app:role`. */
const CLAIM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const CLAIM_NAME_MESSAGE = 'start with a letter or "_", then use letters, digits, "_", ".", ":" and "-"';

/** A claim name of the operator's own, which the provider does not already set. */
export const claimNameSchema = z
  .string()
  .trim()
  .regex(CLAIM_NAME_PATTERN, CLAIM_NAME_MESSAGE)
  .refine((name) => RESERVED_CLAIMS.has(name) === false, { error: 'that claim is set by the provider' });

/** The claim a client reads groups from: `groups`, or a name of the operator's own such as `roles`. */
export const groupsClaimSchema = z
  .string()
  .trim()
  .regex(CLAIM_NAME_PATTERN, CLAIM_NAME_MESSAGE)
  .refine((name) => name === DEFAULT_GROUPS_CLAIM || RESERVED_CLAIMS.has(name) === false, {
    error: 'that claim is set by the provider',
  });

/** Custom claims as the admin UI sends them: a list of names and values, each name once. */
export const customClaimsSchema = z
  .array(z.object({ name: claimNameSchema, value: z.string() }))
  .refine((claims) => new Set(claims.map((claim) => claim.name)).size === claims.length, {
    error: 'give each claim once',
  })
  .transform((claims) => Object.fromEntries(claims.map((claim) => [claim.name, claim.value])));

/** One custom claim, as GraphQL sends and receives it. */
export interface ClaimEntry {
  name: string;
  value: string;
}

/**
 * Lists stored claims the way GraphQL sends them.
 *
 * @param claims - Claim values by name.
 * @returns Them as name and value pairs, by name.
 */
export function claimEntries(claims: Record<string, string>): ClaimEntry[] {
  return Object.entries(claims)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Drops the keys an input left out or set to null, so they keep what is stored.
 *
 * @param input - What the caller sent.
 * @returns The same object without null or undefined values.
 */
export function withoutBlanks<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/**
 * Removes or renames a group in a list of groups.
 *
 * @param groups - The list.
 * @param from - The group to change.
 * @param to - Its new name, or null to remove it.
 * @returns The list, each group once.
 */
export function replaceGroupIn(groups: string[], from: string, to: string | null): string[] {
  const next = groups.flatMap((group) => (group === from ? (to === null ? [] : [to]) : [group]));
  return [...new Set(next)];
}
