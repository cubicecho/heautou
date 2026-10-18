import { TWO_FACTOR_DEFAULTS } from '../../server/core/defaults.ts';
import { base32Decode, base32Encode, matchTotp, totpCode, totpStepAt, totpUri } from '../../server/core/totp.ts';
import { MS_PER_SECOND } from '../../server/core/wire.ts';

/** RFC 6238's SHA-1 test secret, `12345678901234567890`, as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 7, 99]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3t qojq')).toEqual(Buffer.from('1234567890'));
  });

  it('matches the RFC 6238 test vectors, to six digits', () => {
    const vectors: [number, string][] = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totpCode(RFC_SECRET, totpStepAt(seconds * MS_PER_SECOND))).toBe(code);
    }
  });

  it('accepts the codes next to now, once each', () => {
    const now = 1_111_111_109 * MS_PER_SECOND;
    const step = totpStepAt(now);
    expect(matchTotp(RFC_SECRET, '081804', now, -1)).toBe(step);
    expect(matchTotp(RFC_SECRET, '081 804', now, -1)).toBe(step);
    expect(matchTotp(RFC_SECRET, '081804', now, step)).toBeNull();
    const nextCode = totpCode(RFC_SECRET, step + TWO_FACTOR_DEFAULTS.totpDriftSteps);
    expect(matchTotp(RFC_SECRET, nextCode, now, step)).toBe(step + 1);
    const farCode = totpCode(RFC_SECRET, step + TWO_FACTOR_DEFAULTS.totpDriftSteps + 1);
    expect(matchTotp(RFC_SECRET, farCode, now, -1)).toBeNull();
    expect(matchTotp(RFC_SECRET, '12345', now, -1)).toBeNull();
  });

  it('builds the URI authenticator apps scan', () => {
    const uri = new URL(totpUri(RFC_SECRET, 'Home Auth', 'ada'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Home Auth:ada');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: RFC_SECRET,
      issuer: 'Home Auth',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
