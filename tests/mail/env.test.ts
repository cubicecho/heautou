import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAIL_DEFAULTS } from '../../server/core/defaults.ts';
import { mailServerFromEnv } from '../../server/mail/env.ts';
import { tempDir } from '../helpers.ts';

const FROM = 'Heautou <auth@example.home>';

describe('the SMTP server from the environment', () => {
  it('is none without SMTP_URL or SMTP_HOST', () => {
    expect(mailServerFromEnv({ SMTP_FROM: FROM })).toBeNull();
  });

  it('reads SMTP_URL, with the user and password in it', () => {
    expect(mailServerFromEnv({ SMTP_URL: 'smtps://me%40home:p%40ss@mail.example.home', SMTP_FROM: FROM })).toEqual({
      host: 'mail.example.home',
      port: MAIL_DEFAULTS.implicitTlsPort,
      secure: true,
      user: 'me@home',
      password: 'p@ss',
      from: FROM,
    });
    expect(mailServerFromEnv({ SMTP_URL: 'smtp://mail.example.home:2525', SMTP_FROM: FROM })).toMatchObject({
      port: 2525,
      secure: false,
      user: '',
      password: null,
    });
  });

  it('reads the host form, the password from its _FILE', () => {
    const file = path.join(tempDir(), 'smtp-password');
    writeFileSync(file, 'from a file\n');
    expect(
      mailServerFromEnv({
        SMTP_HOST: 'mail.example.home',
        SMTP_USER: 'heautou',
        SMTP_PASSWORD: 'ignored',
        SMTP_PASSWORD_FILE: file,
        SMTP_FROM: FROM,
      }),
    ).toEqual({
      host: 'mail.example.home',
      port: MAIL_DEFAULTS.port,
      secure: false,
      user: 'heautou',
      password: 'from a file',
      from: FROM,
    });
    expect(mailServerFromEnv({ SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_FROM: FROM })).toMatchObject({ secure: true });
  });

  it('stops with a sentence for a missing sender, a bad port or a URL that is not SMTP, without the password', () => {
    expect(() => mailServerFromEnv({ SMTP_HOST: 'h' })).toThrow(/SMTP_FROM/);
    expect(() => mailServerFromEnv({ SMTP_HOST: 'h', SMTP_PORT: 'x', SMTP_FROM: FROM })).toThrow(/SMTP_PORT/);
    expect(() => mailServerFromEnv({ SMTP_URL: 'https://user:hunter2@h', SMTP_FROM: FROM })).toThrow(
      /^(?!.*hunter2).*SMTP_URL/,
    );
  });
});
