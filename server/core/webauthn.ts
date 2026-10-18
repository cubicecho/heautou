import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Passkey } from '../store/factors.ts';
import { TWO_FACTOR_DEFAULTS } from './defaults.ts';
import { MS_PER_SECOND } from './wire.ts';

/** Host names browsers treat as a secure context over plain http. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const timeoutMs = TWO_FACTOR_DEFAULTS.passkeyTimeoutSeconds * MS_PER_SECOND;

/** Who passkeys are registered to: this provider, at its public origin. */
export interface RelyingParty {
  /** The WebAuthn relying party ID: the issuer's host name. */
  id: string;
  /** The origin the browser must report: the issuer's. */
  origin: string;
  /**
   * Whether browsers will offer passkeys here at all. WebAuthn needs a secure context: https, or plain http on
   * loopback.
   */
  isAvailable: boolean;
}

/**
 * Works out the relying party from the issuer.
 *
 * @param issuer - The public URL of the provider.
 * @returns The relying party.
 */
export function relyingPartyOf(issuer: string): RelyingParty {
  const url = new URL(issuer);
  const isLoopback = LOOPBACK_HOSTS.includes(url.hostname) || url.hostname.endsWith('.localhost');
  return { id: url.hostname, origin: url.origin, isAvailable: url.protocol === 'https:' || isLoopback };
}

/** Who a passkey is being made for. */
export interface PasskeyOwner {
  id: string;
  username: string;
  name: string;
}

/**
 * Asks the browser to make a passkey.
 *
 * @param rp - The relying party.
 * @param rpName - What the browser should call the provider: its brand name.
 * @param owner - The user.
 * @param existing - Their passkeys, so the same authenticator isn't registered twice.
 * @returns The options for `navigator.credentials.create`, with the challenge in them.
 */
export function registrationOptions(
  rp: RelyingParty,
  rpName: string,
  owner: PasskeyOwner,
  existing: Passkey[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName,
    rpID: rp.id,
    userName: owner.username,
    userDisplayName: owner.name === '' ? owner.username : owner.name,
    userID: new TextEncoder().encode(owner.id),
    timeout: timeoutMs,
    attestationType: 'none',
    excludeCredentials: existing.map(({ id, transports }) => ({ id, transports })),
    // A discoverable credential can sign in without a username, which is what makes it a passkey.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}

/**
 * Checks what the browser made.
 *
 * @param rp - The relying party.
 * @param response - The browser's answer.
 * @param challenge - The challenge the options carried.
 * @returns The passkey's stored fields, or null when it does not check out.
 */
export async function verifyRegistration(
  rp: RelyingParty,
  response: RegistrationResponseJSON,
  challenge: string,
): Promise<Pick<Passkey, 'id' | 'publicKey' | 'counter' | 'transports'> | null> {
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
  });
  if (verified === false || registrationInfo === undefined) {
    return null;
  }
  const { credential } = registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? [],
  };
}

/**
 * Asks the browser to sign in with a passkey.
 *
 * @param rp - The relying party.
 * @param passkeys - The passkeys of the user signing in, or null to let the browser offer any (a passwordless sign-in).
 * @returns The options for `navigator.credentials.get`, with the challenge in them.
 */
export function authenticationOptions(
  rp: RelyingParty,
  passkeys: Passkey[] | null,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.id,
    timeout: timeoutMs,
    // On its own a passkey has to prove the user too (a PIN or a fingerprint); after a password, touching it is enough.
    userVerification: passkeys === null ? 'required' : 'preferred',
    allowCredentials: passkeys?.map(({ id, transports }) => ({ id, transports })),
  });
}

/** How a passkey sign-in went. */
export interface PasskeyCheck {
  /** The authenticator's new signature counter. */
  counter: number;
  /** Whether the authenticator checked the user (a PIN or a fingerprint), not just their touch. */
  isUserVerified: boolean;
}

/**
 * Checks a passkey's signature.
 *
 * @param rp - The relying party.
 * @param response - The browser's answer.
 * @param challenge - The challenge the options carried.
 * @param passkey - The stored passkey the answer names.
 * @param requireUserVerification - Whether the authenticator must have checked the user.
 * @returns How it went, or null when it does not check out.
 */
export async function verifyAuthentication(
  rp: RelyingParty,
  response: AuthenticationResponseJSON,
  challenge: string,
  passkey: Passkey,
  requireUserVerification: boolean,
): Promise<PasskeyCheck | null> {
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification,
    credential: {
      id: passkey.id,
      publicKey: Buffer.from(passkey.publicKey, 'base64url'),
      counter: passkey.counter,
      transports: passkey.transports,
    },
  });
  return verified ? { counter: authenticationInfo.newCounter, isUserVerified: authenticationInfo.userVerified } : null;
}
