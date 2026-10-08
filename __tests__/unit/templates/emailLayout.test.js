const {
  SCHOOLMULE_BRAND,
  schoolBrand,
  renderEmail,
  facts,
} = require('../../../templates/emailLayout');
const templates = require('../../../templates/emailTemplate');

describe('emailLayout', () => {
  describe('schoolBrand', () => {
    it('uses the hosted PNG logo for a school with one configured', () => {
      const brand = schoolBrand({ school_code: 'ALHAADIACADEMY', name: 'Al Haadi Academy' }, 'Fallback');
      expect(brand.name).toBe('Al Haadi Academy');
      expect(brand.logoUrl).toMatch(/^https?:\/\/.+\/email\/schools\/alhaadiacademy\.png$/);
      expect(brand.isSchool).toBe(true);
    });

    it('falls back to name only when the school has no logo or no info', () => {
      expect(schoolBrand({ school_code: 'NOLOGO', name: 'Test School' }).logoUrl).toBeNull();
      expect(schoolBrand(null, 'Test School')).toMatchObject({ name: 'Test School', logoUrl: null });
    });
  });

  describe('renderEmail', () => {
    it('renders a full document with the letterhead, heading and preheader', () => {
      const html = renderEmail({ brand: SCHOOLMULE_BRAND, heading: 'Hello', preheader: 'Preview text', content: '<p>Body</p>' });
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('/email/schoolmule-mark.png');
      expect(html).toContain('>Hello</h1>');
      expect(html).toContain('Preview text');
      expect(html).toContain('<p>Body</p>');
    });

    it('shows "Sent with SchoolMule" only on school-branded emails', () => {
      const school = renderEmail({ brand: schoolBrand(null, 'Test School'), heading: 'H', content: '' });
      const platform = renderEmail({ brand: SCHOOLMULE_BRAND, heading: 'H', content: '' });
      expect(school).toContain('Sent with SchoolMule');
      expect(platform).not.toContain('Sent with SchoolMule');
    });

    it('escapes the heading, preheader and brand name', () => {
      const html = renderEmail({
        brand: schoolBrand(null, '<i>School</i>'),
        heading: '<script>x</script>',
        preheader: '"quoted"',
        content: '',
      });
      expect(html).not.toContain('<script>x</script>');
      expect(html).not.toContain('<i>School</i>');
      expect(html).toContain('&quot;quoted&quot;');
    });

    it('omits rows with empty values from facts tables', () => {
      const html = facts([['Student', 'Test Student'], ['Term', '']]);
      expect(html).toContain('Test Student');
      expect(html).not.toContain('>Term<');
    });
  });
});

describe('emailTemplate – every template uses the shared layout', () => {
  const school = { school_code: 'ALHAADIACADEMY', name: 'Al Haadi Academy', address: '1 Test Rd', phone: '555-0100', email: 'office@example.com' };
  const cases = {
    getVerificationEmailHTML: { name: 'Test User', url: 'https://example.com/v' },
    getConfirmedEmailHTML: { name: 'Test User' },
    getApprovalEmailHTML: { name: 'Test User' },
    getAdminNotifyEmailHTML: { new_user: 'testuser', school: 'ALHAADIACADEMY' },
    getDeclineEmailHTML: { name: 'Test User', school: 'ALHAADIACADEMY' },
    getResetEmailHTML: { name: 'there', url: 'https://example.com/r' },
    getInviteEmailHTML: { name: 'Test User', schoolName: 'Test School', invitedBy: 'Admin User', role: 'TEACHER', url: 'https://example.com/i' },
    getContactEmailHTML: { name: 'Test User', email: 'test@example.com', message: 'Line 1\nLine 2' },
    getTicketEmailHTML: { username: 'testuser', school: 'Test School', issueType: 'Bug', description: 'Broken', contactEmail: 'test@example.com' },
    getConversationDigestEmailHTML: {
      recipientFirstName: 'Test', studentName: 'Test Student', className: 'Math', title: 'Quiz 1', contextLine: null,
      messages: [{ senderName: 'Test Teacher', body: 'Hi', sentAtLabel: 'Oct 7, 2:14 PM', attachmentCount: 0 }],
      link: 'https://example.com/m', schoolName: 'Al Haadi Academy', schoolInfo: school,
    },
    getFeedbackEmailHTML: { childName: 'Test Student', assessmentName: 'Quiz 1', courseName: 'Math', link: 'https://example.com/f' },
    getProgressReportEmailHTML: { studentName: 'Test Student', term: 'Term 1', schoolName: 'Al Haadi Academy', schoolInfo: school },
    getReportCardEmailHTML: { studentName: 'Test Student', term: 'Term 1', schoolName: 'Al Haadi Academy', schoolInfo: school },
    getCertificateEmailHTML: { studentName: 'Test Student', viewName: 'Honour Roll', schoolName: 'Al Haadi Academy', schoolInfo: school },
    getAssessmentPublishedEmailHTML: {
      studentName: 'Test Student', className: 'Grade 5 Math', schoolName: 'Al Haadi Academy', schoolInfo: school,
      portalUrl: 'https://example.com/p', batchComment: null,
      assessments: [{ name: 'Quiz 1', scoreLabel: '18 / 20', pctLabel: '90%', comment: '' }],
    },
  };

  it.each(Object.keys(cases))('%s renders a letterhead document without the old styling', (fn) => {
    const html = templates[fn](cases[fn]);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).not.toMatch(/#00ACC1/i);
    expect(html).not.toContain('School Mule Team');
  });

  it('parent emails lead with the school logo and contact details', () => {
    const html = templates.getAssessmentPublishedEmailHTML(cases.getAssessmentPublishedEmailHTML);
    expect(html).toContain('/email/schools/alhaadiacademy.png');
    expect(html).toContain('1 Test Rd');
    expect(html).toContain('One assessment in <strong>Grade 5 Math</strong> was graded');
  });

  it('account emails resolve a school code to its display name', () => {
    expect(templates.getDeclineEmailHTML(cases.getDeclineEmailHTML)).toContain('Al Haadi Academy');
  });

  it('escapes the certificate message, which used to be interpolated raw', () => {
    const html = templates.getCertificateEmailHTML({ ...cases.getCertificateEmailHTML, customMessage: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });
});
