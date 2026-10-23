import { type AuditLog, AuditType, actorOf, upstreamTarget, userTarget } from '../store/audit.ts';
import { UnknownIdentity, type UpstreamProvider, type UpstreamStore } from '../store/upstreams.ts';
import type { PublicUser, UserStore } from '../store/users.ts';
import type { UpstreamIdentity } from './client.ts';

/** Why an upstream identity was not let in, in the `SignInRefused` entry's `reason`. */
export const UpstreamRefusal = {
  /** No user is linked to it, and the provider does not create users. */
  UnknownIdentity: 'unknown_identity',
  /** No user is linked to it, and it does not meet the provider's rules for creating one. */
  NotEligible: 'not_eligible',
} as const;
export type UpstreamRefusal = (typeof UpstreamRefusal)[keyof typeof UpstreamRefusal];

/** The local user an upstream identity signs in as, or why there is none. */
export type ResolvedUser =
  | { user: PublicUser; refusal: null }
  | { user: null; refusal: { reason: UpstreamRefusal; message: string } };

/** What finding the user reads and writes. */
export interface UpstreamAccountDeps {
  upstreams: UpstreamStore;
  users: UserStore;
  audit: AuditLog;
}

/** What a made-up username may hold: what the user store takes. */
const USERNAME_UNSAFE = /[^A-Za-z0-9._@-]+/g;
/** How many numbered usernames are tried before the identity's own id is used. */
const MAX_USERNAME_TRIES = 50;

/**
 * Picks a free username for a user made from an identity: its username there, the part of its address before
 * the @, then the same with a number after it.
 *
 * @param users - The user store.
 * @param provider - The provider.
 * @param identity - The identity.
 * @returns A username no one has.
 */
function freeUsername(users: UserStore, provider: UpstreamProvider, identity: UpstreamIdentity): string {
  const taken = new Set(users.list().map((user) => user.username));
  const fallback = `${provider.id}-${identity.subject}`.replace(USERNAME_UNSAFE, '-');
  const wanted = (identity.username ?? identity.verifiedEmail?.split('@')[0] ?? '').replace(USERNAME_UNSAFE, '-');
  const base = wanted.replace(/^-+|-+$/g, '') || fallback;
  for (let n = 1; n <= MAX_USERNAME_TRIES; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (taken.has(candidate) === false) {
      return candidate;
    }
  }
  return fallback;
}

/**
 * Says why an identity may not have a user made for it, under the provider's creation rules.
 *
 * @param provider - The provider.
 * @param identity - The identity.
 * @returns Why not, or null when one may be made.
 */
function creationProblem(provider: UpstreamProvider, identity: UpstreamIdentity): string | null {
  if (provider.createDomains.length === 0) {
    return null;
  }
  const domains = provider.createDomains.join(', ');
  const { verifiedEmail } = identity;
  if (verifiedEmail === null) {
    return `${provider.name} did not vouch for an address. Only accounts with a verified address at ${domains} get a user here.`;
  }
  const domain = verifiedEmail.slice(verifiedEmail.lastIndexOf('@') + 1).toLowerCase();
  const isListed = provider.createDomains.includes(domain);
  return isListed
    ? null
    : `Only accounts with an address at ${domains} get a user here, and ${verifiedEmail} is not one.`;
}

/**
 * Works out a user's groups after a sign-in through a provider that maps groups: each mapped local group is held
 * exactly when the identity holds an upstream group mapped to it. Other groups are left as they are.
 *
 * @param provider - The provider.
 * @param identity - The identity, with its upstream groups.
 * @param groups - The user's groups now.
 * @returns The groups they should have.
 */
export function mappedGroups(provider: UpstreamProvider, identity: UpstreamIdentity, groups: string[]): string[] {
  const managed = new Set(provider.groupMappings.map((mapping) => mapping.local));
  const held = provider.groupMappings
    .filter((mapping) => identity.groups.includes(mapping.upstream))
    .map((mapping) => mapping.local);
  return [...new Set([...groups.filter((group) => managed.has(group) === false), ...held])];
}

/**
 * Finds the local user an upstream identity signs in as: the user it is linked to, or a new one when the provider
 * creates users and the identity meets its rules. Never a user it is not linked to: an address that matches is not
 * enough, since whoever controls the upstream account would take the local one over. Mapped groups are applied.
 *
 * @param deps - The stores and the audit log.
 * @param provider - The provider.
 * @param identity - Who signed in there.
 * @param ip - The browser's address, for the audit log.
 * @returns Once saved: the user, or why there is none.
 */
export async function resolveUpstreamUser(
  deps: UpstreamAccountDeps,
  provider: UpstreamProvider,
  identity: UpstreamIdentity,
  ip: string | null,
): Promise<ResolvedUser> {
  const { upstreams, users, audit } = deps;
  const key = { providerId: provider.id, issuer: identity.issuer, subject: identity.subject };
  const link = upstreams.findLink(key);
  let user = link === null ? null : users.find(link.userId);
  if (user === null) {
    if (provider.unknownIdentity === UnknownIdentity.Refuse) {
      return {
        user: null,
        refusal: {
          reason: UpstreamRefusal.UnknownIdentity,
          message: `This ${provider.name} account (${identity.label}) is not linked to a user here. Sign in another way, then link it on your account page.`,
        },
      };
    }
    const problem = creationProblem(provider, identity);
    if (problem !== null) {
      return { user: null, refusal: { reason: UpstreamRefusal.NotEligible, message: problem } };
    }
    user = await users.create({
      username: freeUsername(users, provider, identity),
      // Only an address the provider vouches for: this provider tells apps every address is verified.
      email: identity.verifiedEmail ?? '',
      name: identity.name ?? '',
      groups: provider.createGroups,
    });
    await upstreams.link(user.id, key, identity.label);
    audit.record({
      type: AuditType.UserCreated,
      actor: actorOf(user),
      ip,
      target: userTarget(user),
      detail: { via: 'upstream', provider: provider.name },
    });
    audit.record({
      type: AuditType.UpstreamLinked,
      actor: actorOf(user),
      ip,
      target: upstreamTarget(provider),
      detail: { identity: identity.label },
    });
  }
  await upstreams.usedLink(key);
  const signedIn = user;
  const hasMappings = provider.groupMappings.length > 0 && provider.groupsClaim !== null;
  if (hasMappings === false) {
    return { user: signedIn, refusal: null };
  }
  const next = mappedGroups(provider, identity, signedIn.groups);
  const added = next.filter((group) => signedIn.groups.includes(group) === false);
  const removed = signedIn.groups.filter((group) => next.includes(group) === false);
  if (added.length === 0 && removed.length === 0) {
    return { user: signedIn, refusal: null };
  }
  const { username, email, name } = signedIn;
  const updated = await users.update(signedIn.id, { username, email, name, groups: next });
  audit.record({
    type: AuditType.UpstreamGroupsApplied,
    actor: actorOf(updated),
    ip,
    target: userTarget(updated),
    detail: { provider: provider.name, added: added.join(', '), removed: removed.join(', ') },
  });
  return { user: updated, refusal: null };
}
