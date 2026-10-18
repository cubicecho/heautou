import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { s3Config } from '../../server/core/config.ts';
import { OBJECT_STORAGE_DEFAULTS } from '../../server/core/defaults.ts';
import { tempDir } from '../helpers.ts';

const VARIABLES = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];

describe('the S3 configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    for (const name of VARIABLES) {
      vi.stubEnv(name, '');
      vi.stubEnv(`${name}_FILE`, '');
    }
  });

  it('is off with no S3_ variable', () => {
    expect(s3Config()).toBeNull();
  });

  it('reads every variable, a _FILE form winning, and defaults the region', () => {
    const secretFile = path.join(tempDir(), 'secret');
    writeFileSync(secretFile, 'from-file\n');
    vi.stubEnv('S3_ENDPOINT', 'http://rustfs:9000/');
    vi.stubEnv('S3_BUCKET', 'heautou');
    vi.stubEnv('S3_ACCESS_KEY_ID', 'key');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', 'from-env');
    vi.stubEnv('S3_SECRET_ACCESS_KEY_FILE', secretFile);
    expect(s3Config()).toEqual({
      endpoint: 'http://rustfs:9000',
      bucket: 'heautou',
      region: OBJECT_STORAGE_DEFAULTS.region,
      accessKeyId: 'key',
      secretAccessKey: 'from-file',
    });
  });

  it('names what is missing when only some are set', () => {
    vi.stubEnv('S3_ENDPOINT', 'http://rustfs:9000');
    expect(() => s3Config()).toThrow('S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY');
  });

  it('refuses an endpoint that is not an http(s) URL', () => {
    vi.stubEnv('S3_ENDPOINT', 'rustfs:9000');
    vi.stubEnv('S3_BUCKET', 'heautou');
    vi.stubEnv('S3_ACCESS_KEY_ID', 'key');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', 'secret');
    expect(() => s3Config()).toThrow('S3_ENDPOINT');
  });
});
