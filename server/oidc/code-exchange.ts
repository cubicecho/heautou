import { createHash } from 'node:crypto';
import type Provider from 'oidc-provider';

/** An authorization code the provider issued, as its model reads it. */
export type IssuedCode = InstanceType<Provider['AuthorizationCode']>;

/** What a built-in client's code must match. */
export interface CodeCheck {
  /** The code the provider sent back. */
  code: string;
  /** The PKCE verifier the sign-in started with. */
  verifier: string;
  clientId: string;
  /** The redirect URI the sign-in was started with. */
  redirectUri: string;
}

/**
 * Makes the S256 PKCE challenge for a verifier.
 *
 * @param verifier - The verifier.
 * @returns Its SHA-256, base64url.
 */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Swaps a built-in client's code in-process, which works even when the issuer's public URL is not reachable from
 * inside the server. The code is consumed, so it cannot be used again.
 *
 * @param provider - The current provider.
 * @param check - The code and what it must have been issued for.
 * @returns The code, or null when it is unknown, used, expired, or for another client, redirect or verifier.
 */
export async function redeemCode(provider: Provider, check: CodeCheck): Promise<IssuedCode | null> {
  const code = await provider.AuthorizationCode.find(check.code);
  const isValid =
    code?.isValid === true &&
    code.clientId === check.clientId &&
    code.redirectUri === check.redirectUri &&
    code.codeChallengeMethod === 'S256' &&
    code.codeChallenge === pkceChallenge(check.verifier);
  if (isValid === false || code === undefined) {
    return null;
  }
  await code.consume();
  return code;
}
