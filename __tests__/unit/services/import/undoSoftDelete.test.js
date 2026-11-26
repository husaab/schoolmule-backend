// Undo import's "delete the student too" is a soft delete, like every
// student delete: the row stays, marked deleted by the admin who undid it.
const db = require('../../../../__tests__/__mocks__/config/database');
const { runUndo } = require('../../../../services/import/engine');

// `created`: did the import create the student (true), or only fill in one
// who was already in the school (false)?
const client = (created = true, { otherSubmission = false } = {}) => {
  const c = { query: jest.fn(), release: jest.fn() };
  c.query.mockImplementation(async (sql) => {
    if (/submission_id <> \$2/.test(sql)) return { rows: otherSubmission ? [{}] : [] };
    if (/selectSubmissionForUndo|FROM registration_form_submissions/i.test(sql) && /imported_student_id/i.test(sql)) {
      return { rows: [{ imported_student_id: 'stu-1', imported_student_name: 'Synthetic Student', import_created_student: created }] };
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

it("never deletes a student the import only filled in", async () => {
  const c = client(false);
  db.connect.mockResolvedValueOnce(c);
  const result = await runUndo(db, { submissionId: 'sub-1', school: 'TESTSCHOOL', deleteStudent: true, target: { dependentTables: [] }, userId: 'admin-1' });
  expect(result).toMatchObject({ ok: true, unlinked: true, studentDeleted: false, createdByImport: false });
  const sqls = c.query.mock.calls.map(([sql]) => String(sql));
  expect(sqls.some((sql) => /deleted_at = NOW\(\)/.test(sql))).toBe(false);
  // The link is still undone.
  expect(sqls.some((sql) => /SET imported_student_id = NULL/.test(sql))).toBe(true);
});

it("clears the student's source only when it is this submission", async () => {
  const c = client();
  db.connect.mockResolvedValueOnce(c);
  await runUndo(db, { submissionId: 'sub-1', school: 'TESTSCHOOL', deleteStudent: false, target: { dependentTables: [] } });
  const clear = c.query.mock.calls.find(([sql]) => /SET source_submission_id = NULL/.test(String(sql)));
  expect(String(clear[0])).toContain('AND source_submission_id = $2');
  expect(clear[1]).toEqual(['stu-1', 'sub-1']);
});

it('keeps a student another submission was also imported into', async () => {
  const c = client(true, { otherSubmission: true });
  db.connect.mockResolvedValueOnce(c);
  const result = await runUndo(db, { submissionId: 'sub-1', school: 'TESTSCHOOL', deleteStudent: true, target: { dependentTables: [] }, userId: 'admin-1' });
  expect(result).toMatchObject({ ok: true, unlinked: true, studentDeleted: false, createdByImport: true });
  expect(result.blockedBy).toEqual([{ table: 'registration_form_submissions', label: 'other imported submissions' }]);
  expect(c.query.mock.calls.some(([sql]) => /deleted_at = NOW\(\)/.test(String(sql)))).toBe(false);
});
