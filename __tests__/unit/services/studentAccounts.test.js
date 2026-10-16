jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const db = require('../../__mocks__/config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');
const q = require('../../../queries/studentAccount.queries');
const { DEFAULTS } = require('../../../services/classroom/classroomSettings');
const { inviteStudent } = require('../../../services/classroom/studentAccounts');

const STUDENT = {
  student_id: '7c0d1a52-3f7e-4c55-9d2e-0a4b6c8e1f20',
  name: 'Amal Haddad',
  grade: '2',
  student_email: 'amal.haddad@example.com',
  school_year_id: '99999999-9999-4999-8999-999999999999',
  user_id: null,
  conflict_kind: null,
};
const ADMIN = { userId: '550e8400-e29b-41d4-a716-446655440000', username: 'Office Admin', school: 'ALHAADIACADEMY' };

const uniqueViolation = (constraint) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });

// BEGIN succeeds, the users insert hits a unique violation, ROLLBACK succeeds.
const failInsertWith = (err) => {
  db._mockClient.query
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(err)
    .mockResolvedValueOnce({});
};

const invite = () => inviteStudent({
  student: STUDENT, settings: { ...DEFAULTS }, admin: ADMIN, noticeVersion: '2026-10', schoolInfo: null,
});

describe('inviteStudent: a unique violation inside the transaction', () => {
  it('reports already_has_account when a concurrent invite (double click) linked the student first', async () => {
    failInsertWith(uniqueViolation('users_duplicate_email_key'));
    mockQueryResponse([{ user_id: '550e8400-e29b-41d4-a716-446655440010' }]); // the winner's link

    const result = await invite();

    expect(result).toEqual({
      studentId: STUDENT.student_id, outcome: 'skipped', reason: 'already_has_account',
      message: 'This student already has an account.',
    });
    expect(db.query).toHaveBeenCalledWith(q.selectLinkByStudent, [STUDENT.student_id]);
    expect(db._mockClient.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(db._mockClient.release).toHaveBeenCalled();
  });

  it('reports email_in_use when the address belongs to someone else', async () => {
    failInsertWith(uniqueViolation('users_duplicate_email_key'));
    mockQueryResponse([]); // still unlinked

    const result = await invite();

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'email_in_use' });
  });

  it("reports already_has_account straight from the link's own constraint", async () => {
    failInsertWith(uniqueViolation('uq_student_account_links_student'));

    const result = await invite();

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'already_has_account' });
    expect(db.query).not.toHaveBeenCalledWith(q.selectLinkByStudent, expect.anything());
  });
});
