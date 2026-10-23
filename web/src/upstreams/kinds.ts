import type { UpstreamKind } from '@/__generated__/graphql';
import { OTHER_UPSTREAM } from '@/upstreams/presets';

/** What sets one kind of upstream provider apart in the forms and the list. */
interface UpstreamKindInfo {
  /** What the kind select calls it. */
  label: string;
  /** Whether it is found through an issuer URL, which the form then asks for. */
  hasIssuer: boolean;
  /** The preset whose instructions an edited provider of this kind shows. */
  presetId: string;
  /** What the providers list says it is, given its issuer. */
  summaryOf: (issuer: string | null) => string | null;
}

/** Each kind of upstream provider: OpenID Connect discovery, or GitHub's own endpoints. */
export const UPSTREAM_KINDS = {
  OIDC: {
    label: 'OpenID Connect (Google, Microsoft, GitLab, Authentik…)',
    hasIssuer: true,
    presetId: OTHER_UPSTREAM,
    summaryOf: (issuer) => issuer,
  },
  GITHUB: { label: 'GitHub', hasIssuer: false, presetId: 'github', summaryOf: () => 'GitHub' },
} as const satisfies Record<UpstreamKind, UpstreamKindInfo>;

/** The kinds, in the order the select lists them. */
export const UPSTREAM_KIND_OPTIONS = (['OIDC', 'GITHUB'] as const).map((value) => ({
  value,
  label: UPSTREAM_KINDS[value].label,
}));

/**
 * Narrows the select's string to a kind.
 *
 * @param value - What the select holds.
 * @returns The kind, or OpenID Connect when it is none of them.
 */
export function upstreamKindOf(value: string): UpstreamKind {
  return UPSTREAM_KIND_OPTIONS.find((option) => option.value === value)?.value ?? 'OIDC';
}
