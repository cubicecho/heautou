import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { totpCode, totpStepAt } from '../../server/core/totp.ts';
import { postJson, type SecondFactorAnswer } from './browser.ts';

/** WebAuthn authenticator data flags. */
const FLAG = { userPresent: 0x01, userVerified: 0x04, attestedCredential: 0x40 } as const;
/** COSE key parameters for an ES256 P-256 public key (RFC 9053). */
const COSE = { kty: 1, alg: 3, crv: -1, x: -2, y: -3, ec2: 2, es256: -7, p256: 1 } as const;
/** Bytes in a credential ID this authenticator makes. */
const CREDENTIAL_ID_BYTES = 16;
/** Bytes in an AAGUID. */
const AAGUID_BYTES = 16;
/** Bytes in the signature counter. */
const COUNTER_BYTES = 4;
/** Bytes in the credential ID's length. */
const LENGTH_BYTES = 2;

/** What the server's options say, as far as this authenticator reads them. */
interface Options {
  challenge: string;
  rp?: { id?: string };
  rpId?: string;
  user?: { id: string };
}

/**
 * Hashes bytes with SHA-256.
 *
 * @param data - The bytes.
 * @returns The digest.
 */
function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * A passkey in software, standing in for a browser and its authenticator in tests. It answers registration and
 * sign-in options the way `@simplewebauthn/browser` would hand them to the server.
 *
 * @param origin - The origin the "browser" is on.
 * @returns `create` and `get`, as `navigator.credentials` has, and the credential's ID once made.
 */
export function createSoftwareAuthenticator(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = randomBytes(CREDENTIAL_ID_BYTES);
  const id = credentialId.toString('base64url');
  let counter = 0;
  let userHandle = '';

  const coseKey = (key: KeyObject): Uint8Array => {
    const jwk = key.export({ format: 'jwk' });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [COSE.kty, COSE.ec2],
        [COSE.alg, COSE.es256],
        [COSE.crv, COSE.p256],
        [COSE.x, Buffer.from(jwk.x ?? '', 'base64url')],
        [COSE.y, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    );
  };
  const counterBytes = (): Buffer => {
    const bytes = Buffer.alloc(COUNTER_BYTES);
    bytes.writeUInt32BE(counter);
    return bytes;
  };
  const clientData = (type: string, challenge: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const rpIdOf = (options: Options): string => options.rp?.id ?? options.rpId ?? new URL(origin).hostname;

  return {
    id,
    /**
     * Makes the passkey.
     *
     * @param options - The server's registration options.
     * @returns The registration response JSON.
     */
    create: (options: Options) => {
      userHandle = options.user?.id ?? '';
      const length = Buffer.alloc(LENGTH_BYTES);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rpIdOf(options)),
        Buffer.from([FLAG.userPresent | FLAG.userVerified | FLAG.attestedCredential]),
        counterBytes(),
        Buffer.alloc(AAGUID_BYTES),
        length,
        credentialId,
        coseKey(publicKey),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, string>>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, string>()],
          ['authData', authData],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData('webauthn.create', options.challenge).toString('base64url'),
          attestationObject: Buffer.from(attestationObject).toString('base64url'),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
    /**
     * Signs in with the passkey.
     *
     * @param options - The server's authentication options.
     * @param [userVerified] - Whether the "user" gave a PIN or a fingerprint.
     * @returns The authentication response JSON.
     */
    get: (options: Options, userVerified = true) => {
      counter += 1;
      const flags = FLAG.userPresent | (userVerified ? FLAG.userVerified : 0);
      const authData = Buffer.concat([sha256(rpIdOf(options)), Buffer.from([flags]), counterBytes()]);
      const clientDataJSON = clientData('webauthn.get', options.challenge);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          authenticatorData: authData.toString('base64url'),
          clientDataJSON: clientDataJSON.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}

/**
 * Answers a sign-in's second factor with the current authenticator app code.
 *
 * @param secret - The app's secret.
 * @returns The answer.
 */
export function withTotp(secret: string): SecondFactorAnswer {
  return (uid, browser) =>
    postJson(browser, `/interaction/${uid}/second-factor`, { code: totpCode(secret, totpStepAt(Date.now())) });
}
