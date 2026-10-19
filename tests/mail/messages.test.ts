import { composeMail, escapeHtml, MailKind, passwordLinkContent } from '../../server/mail/messages.ts';

/** A one-pixel PNG. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const URL = 'https://auth.example.home/set-password#token=abc&uid=x';

describe('an email', () => {
  it('escapes what goes into the HTML part', () => {
    expect(escapeHtml(`<b a="1">'&'</b>`)).toBe('&lt;b a=&quot;1&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;');
  });

  it('carries the brand, the link in both parts and the logo inline', () => {
    const branding = {
      name: 'Home <script>',
      logo: { type: 'image/png' as const, data: PIXEL_PNG, updatedAt: '2026-01-01T00:00:00.000Z' },
    };
    const content = passwordLinkContent(
      MailKind.Invite,
      { username: 'ada', name: 'Ada' },
      branding.name,
      URL,
      new Date(0),
    );
    const message = composeMail('ada@example.home', content, branding);
    expect(message.subject).toBe('Your Home <script> account');
    expect(message.text).toContain(URL);
    expect(message.text).toContain('Hello Ada,');
    expect(message.html).toContain('Home &lt;script&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain(`href="${escapeHtml(URL)}"`);
    expect(message.html).toContain('src="cid:logo@heautou"');
    expect(message.attachments).toEqual([
      expect.objectContaining({ cid: 'logo@heautou', contentType: 'image/png', filename: 'logo.png' }),
    ]);
  });

  it('keeps the subject to one line', () => {
    const message = composeMail('a@b.c', { subject: 'one\r\nBcc: x@y.z', paragraphs: [] }, { name: 'H', logo: null });
    expect(message.subject).toBe('one Bcc: x@y.z');
    expect(message.attachments).toEqual([]);
  });
});
