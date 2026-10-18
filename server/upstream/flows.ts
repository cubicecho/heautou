import { randomBytes } from 'node:crypto';
import { ADMIN_DEFAULTS, UPSTREAM_DEFAULTS } from '../core/defaults.ts';
import { errorMessage, notFound } from '../core/errors.ts';
import { createExpiringMap } from '../core/expiring-map.ts';
import type { UpstreamProvider, UpstreamStore } from '../store/upstreams.ts';
import type { FlowChecks, UpstreamClient, UpstreamIdentity } from './client.ts';

/** Where an upstream provider sends the browser back: `/upstream/<provider id>/callback`. */
export const UPSTREAM_PATH = '/upstream';

/** Why a browser went to an upstream provider. */
export const FlowPurpose = {
  /** To sign in to a provider interaction, which it comes back to. */
  SignIn: 'sign_in',
  /** To link an identity to the signed-in user, from their account page. */
  Link: 'link',
} as const;
export type FlowPurpose = (typeof FlowPurpose)[keyof typeof FlowPurpose];

/** What a flow was started for, and so where it ends. */
export type FlowStart =
  | { purpose: typeof FlowPurpose.SignIn; uid: string }
  | { purpose: typeof FlowPurpose.Link; userId: string };

/** How a flow came back: who signed in upstream, or why nobody did. */
export type FlowOutcome = { start: FlowStart; provider: UpstreamProvider } & (
  | { identity: UpstreamIdentity; error: null }
  | { identity: null; error: string }
);

/** A flow waiting for the browser to come back, kept by its state. */
interface PendingFlow {
  providerId: string;
  start: FlowStart;
  checks: FlowChecks;
}

/** The upstream sign-ins and links under way, kept in memory. */
export interface UpstreamFlows {
  /**
   * Names a provider's redirect URI, which the operator registers there.
   *
   * @param providerId - The provider.
   * @returns `<origin>/upstream/<id>/callback`.
   */
  redirectUriOf: (providerId: string) => string;
  /**
   * Starts a flow.
   *
   * @param providerId - The provider.
   * @param start - What it is for.
   * @returns Where to send the browser.
   * @throws NOT_FOUND for an unknown provider; whatever discovery threw for one that can't be reached.
   */
  start: (providerId: string, start: FlowStart) => Promise<string>;
  /**
   * Ends a flow when the browser comes back. A state is used once.
   *
   * @param providerId - The provider whose callback it came back to.
   * @param query - The callback's query.
   * @returns How it went, or null when the state is unknown, used or expired, or was for another provider.
   */
  finish: (providerId: string, query: URLSearchParams) => Promise<FlowOutcome | null>;
  /**
   * Keeps an outcome for the account page, which reads it with its session.
   *
   * @param outcome - The outcome of a link flow.
   * @returns The single-use ticket the page hands back.
   */
  holdForAccount: (outcome: FlowOutcome) => string;
  /**
   * Takes an outcome held for the account page.
   *
   * @param ticket - What `holdForAccount` returned.
   * @returns It, or null when it is unknown, used or expired.
   */
  takeForAccount: (ticket: string) => FlowOutcome | null;
  /**
   * Keeps an outcome for the interaction it signs in to.
   *
   * @param uid - The interaction.
   * @param outcome - The outcome.
   */
  holdForInteraction: (uid: string, outcome: FlowOutcome) => void;
  /**
   * Takes the outcome held for an interaction.
   *
   * @param uid - The interaction.
   * @returns It, or null when there is none.
   */
  takeForInteraction: (uid: string) => FlowOutcome | null;
}

/** What the flows are built with. */
export interface UpstreamFlowDeps {
  upstreams: UpstreamStore;
  client: UpstreamClient;
  /** The public URL of the provider; the callbacks are on its origin. */
  issuer: string;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

/**
 * Keeps the upstream flows under way. The state, nonce and PKCE verifier stay on the server, keyed by the state,
 * and say which interaction or user the flow is for, so the callback cannot be pointed at another one.
 *
 * @param deps - The providers, the client that talks to them, the issuer and the clock.
 * @returns The flows.
 */
export function createUpstreamFlows(deps: UpstreamFlowDeps): UpstreamFlows {
  const { upstreams, client, issuer, now = Date.now } = deps;
  const { origin } = new URL(issuer);
  const pending = createExpiringMap<PendingFlow>(UPSTREAM_DEFAULTS.flowSeconds, now);
  const forAccount = createExpiringMap<FlowOutcome>(UPSTREAM_DEFAULTS.flowSeconds, now);
  const forInteraction = createExpiringMap<FlowOutcome>(UPSTREAM_DEFAULTS.flowSeconds, now);
  const redirectUriOf = (providerId: string): string =>
    `${origin}${UPSTREAM_PATH}/${encodeURIComponent(providerId)}/callback`;

  return {
    redirectUriOf,
    start: async (providerId, start) => {
      const provider = upstreams.find(providerId);
      if (provider === null) {
        throw notFound(`No upstream provider has the id "${providerId}".`);
      }
      const { url, checks } = await client.authorize(provider, redirectUriOf(providerId));
      pending.set(checks.state, { providerId, start, checks });
      return url.href;
    },
    finish: async (providerId, query) => {
      const flow = pending.take(query.get('state') ?? '');
      const provider = upstreams.find(providerId);
      if (flow === null || provider === null || flow.providerId !== providerId) {
        return null;
      }
      const { start, checks } = flow;
      const refusal = query.get('error');
      if (refusal !== null) {
        const said = query.get('error_description') ?? refusal;
        return { start, provider, identity: null, error: `${provider.name} did not sign you in: ${said}` };
      }
      const callback = new URL(redirectUriOf(providerId));
      callback.search = query.toString();
      try {
        const identity = await client.identify(provider, callback, checks);
        return { start, provider, identity, error: null };
      } catch (error) {
        console.error(`[upstream] ${provider.id}:`, error);
        return {
          start,
          provider,
          identity: null,
          error: `Signing in with ${provider.name} did not work: ${errorMessage(error)}`,
        };
      }
    },
    holdForAccount: (outcome) => {
      const ticket = randomBytes(ADMIN_DEFAULTS.tokenBytes).toString('base64url');
      forAccount.set(ticket, outcome);
      return ticket;
    },
    takeForAccount: (ticket) => forAccount.take(ticket),
    holdForInteraction: (uid, outcome) => {
      forInteraction.set(uid, outcome);
    },
    takeForInteraction: (uid) => forInteraction.take(uid),
  };
}
