const {
  StudentRequestError, isHoneypot, cleanSubmission, toRequest, refusalFor,
} = require('../../../services/classroom/studentRequestRules');

const BODY = { school: 'ALHAADIACADEMY', firstName: ' Amal ', lastName: 'Haddad', grade: '5', email: ' Amal.Haddad@Students.Example.org ' };

describe('cleanSubmission', () => {
  it('trims, squeezes spaces and lowercases the address', () => {
    expect(cleanSubmission({ ...BODY, lastName: 'El   Haddad' })).toEqual({
      value: { school: 'ALHAADIACADEMY', firstName: 'Amal', lastName: 'El Haddad', grade: '5', email: 'amal.haddad@students.example.org' },
    });
    expect(cleanSubmission({ ...BODY, grade: 'jk' }).value.grade).toBe('JK');
  });
  it.each([
    ['no body', null, 'Fill in the form.'],
    ['no school', { ...BODY, school: '' }, 'Choose your school.'],
    ['no last name', { ...BODY, lastName: '  ' }, 'Enter your first and last name.'],
    ['a long name', { ...BODY, firstName: 'a'.repeat(61) }, 'Names can be up to 60 characters.'],
    ['no grade', { ...BODY, grade: '' }, 'Choose your grade.'],
    ['Grade 9', { ...BODY, grade: '9' }, 'Choose your grade.'],
    ['a bad address', { ...BODY, email: 'amal@' }, 'Enter your school email address.'],
    ['a non-string address', { ...BODY, email: 42 }, 'Enter your school email address.'],
  ])('refuses %s', (_label, body, error) => {
    expect(cleanSubmission(body)).toEqual({ error });
  });
});

describe('isHoneypot', () => {
  it('is true only when the hidden field has something in it', () => {
    expect(isHoneypot({ website: 'http://spam.example' })).toBe(true);
    expect(isHoneypot({ website: '  ' })).toBe(false);
    expect(isHoneypot({})).toBe(false);
    expect(isHoneypot(null)).toBe(false);
  });
});

describe('toRequest', () => {
  it('maps a row to the admin shape', () => {
    expect(toRequest({
      request_id: 'r1', first_name: 'Amal', last_name: 'Haddad', grade: '5', email: 'amal@example.com', status: 'pending',
      created_at: new Date('2026-10-19T14:00:00Z'), decided_at: null, address_taken: false,
    })).toEqual({
      requestId: 'r1', firstName: 'Amal', lastName: 'Haddad', name: 'Amal Haddad', grade: '5', email: 'amal@example.com',
      status: 'pending', createdAt: '2026-10-19T14:00:00.000Z', decidedAt: null, addressTaken: false,
    });
  });
});

describe('refusalFor', () => {
  it.each([
    ['already_has_account', 409, 'ALREADY_HAS_LOGIN'],
    ['below_login_grade', 409, 'BELOW_LOGIN_GRADE'],
    ['email_in_use', 409, 'EMAIL_IN_USE'],
    ['family_address', 409, 'FAMILY_ADDRESS'],
    ['shared_with_student', 409, 'SHARED_WITH_STUDENT'],
    ['invalid_email', 400, 'INVALID_EMAIL'],
    ['something_new', 409, 'NOT_INVITED'],
  ])('maps %s to %i %s, keeping the message', (reason, status, code) => {
    const err = refusalFor({ reason, message: 'Because.' });
    expect(err).toBeInstanceOf(StudentRequestError);
    expect(err).toMatchObject({ status, code, message: 'Because.' });
  });
});
