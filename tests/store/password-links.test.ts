import path from 'node:path';
import { CREDENTIAL_DEFAULTS } from '../../server/core/defaults.ts';
import { openJsonFile } from '../../server/store/json-file.ts';
import { createPasswordLinkStore, type PasswordLinkDocument } from '../../server/store/password-links.ts';
import { tempDir } from '../helpers.ts';

describe('password link store', () => {
  it('keeps only a digest, one link per user, until it is used or expires', () => {
    const file = path.join(tempDir(), 'links.json');
    let time = 1_000_000;
    const json = openJsonFile<PasswordLinkDocument>(file, {});
    const store = createPasswordLinkStore(json, () => time);
    const { token } = store.issue('u1');
    expect(JSON.stringify(json.read())).not.toContain(token);
    expect(store.find(token)).toBe('u1');
    const { token: other } = store.issue('u2');
    expect(store.consume(token)).toBe('u1');
    expect(store.find(token)).toBeNull();
    time += CREDENTIAL_DEFAULTS.passwordLinkSeconds * 1000 + 1;
    expect(store.find(other)).toBeNull();
  });

  it('cancels a user’s link', () => {
    const store = createPasswordLinkStore(openJsonFile<PasswordLinkDocument>(path.join(tempDir(), 'l.json'), {}));
    const { token } = store.issue('u1');
    store.cancelFor('u1');
    expect(store.find(token)).toBeNull();
  });
});
