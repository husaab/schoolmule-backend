const { schoolSender, platformSender, senderAddress } = require('../../../../services/email/senderIdentity');

const alHaadi = (over = {}) => ({
  school_code: 'ALHAADIACADEMY',
  name: 'Al Haadi Academy',
  slug: 'al-haadi-academy',
  email: 'office@example.org',
  email_sending_domain: null,
  email_sender_local: null,
  email_reply_to: [],
  ...over,
});

describe('senderIdentity', () => {
  const saved = {};
  beforeEach(() => {
    saved.MAIL_DOMAIN = process.env.MAIL_DOMAIN;
    saved.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL;
    process.env.MAIL_DOMAIN = 'schoolmule.ca';
    process.env.SUPPORT_EMAIL = 'support@schoolmule.ca';
  });
  afterEach(() => {
    process.env.MAIL_DOMAIN = saved.MAIL_DOMAIN;
    process.env.SUPPORT_EMAIL = saved.SUPPORT_EMAIL;
  });

  describe('schoolSender', () => {
    it('sends from the platform domain under the school name when no domain is verified', () => {
      const s = schoolSender({ school: 'ALHAADIACADEMY', schoolInfo: alHaadi() });
      expect(s.from).toBe('"Al Haadi Academy" <alhaadiacademy@schoolmule.ca>');
      expect(senderAddress(s.from)).toBe('alhaadiacademy@schoolmule.ca');
    });

    it('derives the local part from the slug, or the override when set', () => {
      expect(schoolSender({ school: 'X', schoolInfo: alHaadi({ slug: 'maple-grove-2' }) }).from)
        .toBe('"Al Haadi Academy" <maplegrove2@schoolmule.ca>');
      expect(schoolSender({ school: 'X', schoolInfo: alHaadi({ email_sender_local: 'Al.Haadi' }) }).from)
        .toBe('"Al Haadi Academy" <alhaadi@schoolmule.ca>');
    });

    it('uses role@domain when the school has a verified sending domain', () => {
      const info = alHaadi({ email_sending_domain: 'alhaadiacademy.ca' });
      expect(schoolSender({ school: 'ALHAADIACADEMY', schoolInfo: info }).from)
        .toBe('"Al Haadi Academy" <academics@alhaadiacademy.ca>');
      expect(schoolSender({ school: 'ALHAADIACADEMY', schoolInfo: info, role: 'messages' }).from)
        .toBe('"Al Haadi Academy" <messages@alhaadiacademy.ca>');
    });

    it('rejects an unknown role so a typo cannot invent an address', () => {
      expect(() => schoolSender({ school: 'X', schoolInfo: alHaadi(), role: 'reports' })).toThrow(/Unknown school sender role/);
    });

    it('replies go to the reply-to list plus the school contact email, deduped and cleaned', () => {
      const info = alHaadi({ email_reply_to: ['Admin@Example.org', ' second@example.org ', 'not-an-email', 'office@example.org'] });
      expect(schoolSender({ school: 'X', schoolInfo: info }).replyTo)
        .toEqual(['admin@example.org', 'second@example.org', 'office@example.org']);
    });

    it('omits replyTo when the school has no addresses at all', () => {
      expect(schoolSender({ school: 'X', schoolInfo: alHaadi({ email: null }) }).replyTo).toBeUndefined();
    });

    it('falls back to the display name and platform domain when the school lookup failed', () => {
      const s = schoolSender({ school: 'ALHAADIACADEMY', schoolInfo: null });
      expect(s.from).toBe('"Al Haadi Academy" <alhaadiacademy@schoolmule.ca>');
      expect(s.replyTo).toBeUndefined();
    });

    it('senderAddress pulls the bare address out of a From header', () => {
      expect(senderAddress('"A" <a@b.c>')).toBe('a@b.c');
      expect(senderAddress('a@b.c')).toBe('a@b.c');
    });

    it('strips characters that could break the From header out of the school name', () => {
      const s = schoolSender({ school: 'X', schoolInfo: alHaadi({ name: 'Evil "School" <x@y.z>' }) });
      expect(s.from).toBe('"Evil School x@y.z" <alhaadiacademy@schoolmule.ca>');
    });

    it('honours MAIL_DOMAIN for the platform domain', () => {
      process.env.MAIL_DOMAIN = 'test.com';
      expect(senderAddress(schoolSender({ school: 'X', schoolInfo: alHaadi() }).from)).toBe('alhaadiacademy@test.com');
    });
  });

  describe('platformSender', () => {
    it('sends as SchoolMule from the platform domain with support as the reply address', () => {
      expect(platformSender('verify')).toEqual({
        from: '"SchoolMule" <verify@schoolmule.ca>',
        replyTo: ['support@schoolmule.ca'],
      });
    });

    it('defaults to no-reply and lets a caller override the reply address', () => {
      expect(senderAddress(platformSender().from)).toBe('no-reply@schoolmule.ca');
      expect(platformSender('contact', { replyTo: 'visitor@example.org' }).replyTo).toEqual(['visitor@example.org']);
    });

    it('omits replyTo when SUPPORT_EMAIL is unset', () => {
      delete process.env.SUPPORT_EMAIL;
      expect(platformSender('reset').replyTo).toBeUndefined();
    });
  });
});
