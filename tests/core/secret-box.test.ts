import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { secretKeys } from '../../server/core/config.ts';
import {
  createSecretBox,
  isSealed,
  parseSecretKey,
  SECRET_KEY_BYTES,
  SecretKeyError,
  SecretKeyErrorCode,
} from '../../server/core/secret-box.ts';
import { tempDir } from '../helpers.ts';

/**
 * Makes a random sealing key.
 *
 * @returns 32 random bytes.
 */
const newKey = (): Buffer => randomBytes(SECRET_KEY_BYTES);

describe('secret box', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('seals and opens a secret, and opens a plain one as it is', () => {
    const box = createSecretBox({ current: newKey(), previous: null });
    const sealed = box.seal('hunter2');
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(box.seal('hunter2')).not.toBe(sealed);
    expect(box.open(sealed)).toBe('hunter2');
    expect(box.isCurrent(sealed)).toBe(true);
    expect(box.open('plain')).toBe('plain');
    expect(box.isCurrent('plain')).toBe(false);
  });

  it('refuses a changed value, a damaged one and another key', () => {
    const box = createSecretBox({ current: newKey(), previous: null });
    const sealed = box.seal('hunter2');
    // Another secret's ciphertext under this one's IV and tag: GCM's tag no longer matches.
    const parts = sealed.split('.');
    const swapped = [...parts.slice(0, -1), box.seal('hunter3').split('.').at(-1)].join('.');
    expect(() => box.open(swapped)).toThrow(SecretKeyError);
    expect(() => box.open('enc:v1:broken')).toThrow(SecretKeyError);
    const other = createSecretBox({ current: newKey(), previous: null });
    expect(() => other.open(sealed)).toThrow(expect.objectContaining({ code: SecretKeyErrorCode.Wrong }));
  });

  it('opens values sealed with the previous key, which are not current', () => {
    const old = newKey();
    const sealed = createSecretBox({ current: old, previous: null }).seal('hunter2');
    const box = createSecretBox({ current: newKey(), previous: old });
    expect(box.open(sealed)).toBe('hunter2');
    expect(box.isCurrent(sealed)).toBe(false);
  });

  it('reads the key from its variable or, first, its file', () => {
    const key = newKey();
    vi.stubEnv('SECRET_KEY', key.toString('base64'));
    expect(secretKeys()?.current.equals(key)).toBe(true);
    const fileKey = newKey();
    const file = path.join(tempDir(), 'secret');
    writeFileSync(file, `${fileKey.toString('base64')}\n`);
    vi.stubEnv('SECRET_KEY_FILE', file);
    expect(secretKeys()?.current.equals(fileKey)).toBe(true);
    vi.unstubAllEnvs();
    expect(secretKeys()).toBeNull();
  });

  it('refuses a key of the wrong size, and a previous key alone', () => {
    expect(() => parseSecretKey('c2hvcnQ=', 'SECRET_KEY')).toThrow(
      expect.objectContaining({ code: SecretKeyErrorCode.Malformed }),
    );
    vi.stubEnv('SECRET_KEY', 'c2hvcnQ=');
    expect(() => secretKeys()).toThrow(/SECRET_KEY is not 32 bytes/);
    vi.unstubAllEnvs();
    vi.stubEnv('SECRET_KEY_PREVIOUS', newKey().toString('base64'));
    expect(() => secretKeys()).toThrow(expect.objectContaining({ code: SecretKeyErrorCode.Malformed }));
  });
});
