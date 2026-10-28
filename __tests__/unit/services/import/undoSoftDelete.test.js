// Undo import's "delete the student too" is a soft delete, like every
// student delete: the row stays, marked deleted by the admin who undid it.
const db = require('../../../../__tests__/__mocks__/config/database');
const { runUndo } = require('../../../../services/import/engine');

const client = () => {
  const c = { query: jest.fn(), release: jest.fn() };
  c.query.mockImplementation(async (sql) => {
    if (/selectSubmissionForUndo|FROM registration_form_submissions/i.test(sql) && /imported_student_id/i.test(sql)) {
      return { rows: [{ imported_student_id: 'stu-1', imported_student_name: 'Synthetic Student' }] };
    }
    if (/UPDATE students\s+SET is_archived = TRUE, deleted_at = NOW\(\)/i.test(sql)) return { rows: [{ student_id: 'stu-1' }] };
    return { rows: [], rowCount: 0 };
  });
  return c;
};

it('soft-deletes the imported student, recording who did it', async () => {
  const c = client();
  db.connect.mockResolvedValueOnce(c);
  const result = await runUndo(db, { submissionId: 'sub-1', school: 'TESTSCHOOL', deleteStudent: true, target: { dependentTables: [] }, userId: 'admin-1' });
  expect(result).toMatchObject({ ok: true, studentDeleted: true });
  const sqls = c.query.mock.calls.map(([sql]) => String(sql));
  expect(sqls.some((sql) => /DELETE FROM students/i.test(sql))).toBe(false);
  const soft = c.query.mock.calls.find(([sql]) => /deleted_at = NOW\(\)/.test(String(sql)));
  expect(soft[1]).toEqual(['stu-1', 'TESTSCHOOL', 'admin-1']);
});
