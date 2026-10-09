jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const db = require('../../__mocks__/config/database');
const { mockTransactionSequence } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const { TEST_TEACHER_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { approveSignup } = require('../../../services/approvalActions');

describe('approveSignup', () => {
  it('links children to a teacher signup, since staff may also be parents', async () => {
    const pending = buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER', is_verified: true, is_verified_school: false, is_archived: false });
    mockTransactionSequence([
      { rows: [pending] },                                   // selectUserForUpdate
      { rows: [{ ...pending, is_verified_school: true }] }, // approveUser
      { rows: [{ school_year_id: 'y1' }] },                 // active year
      { rows: [{ student_id: 's1' }] },                     // selectStudentsByIds
      { rows: [] },                                          // selectLinkedStudentIds
      { rows: [], rowCount: 0 },                             // claimManualLink (nothing to claim)
      { rows: [{}] },                                        // insertLink
    ]);

    const result = await approveSignup({
      school: TEST_SCHOOL,
      userId: TEST_TEACHER_USER_ID,
      role: 'TEACHER',
      children: [{ studentId: 's1', relation: 'Mother' }],
      sendEmail: false,
    });

    expect(result.user.role).toBe('TEACHER');
    expect(result.linkedCount).toBe(1);
    const sqls = db._mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((sql) => /INSERT INTO parent_students/i.test(sql))).toBe(true);
  });
});
