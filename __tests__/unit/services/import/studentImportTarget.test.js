const target = require('../../../../services/import/studentImportTarget');
const importQueries = require('../../../../queries/registrationImport.queries');

const field = (id, label) => ({ field_id: id, label, options: null });

describe('studentImportTarget: the student email', () => {
  it('is a mappable Student field', () => {
    expect(target.fieldByTarget.get('studentEmail')).toEqual({
      targetField: 'studentEmail', column: 'student_email', label: 'Student — email',
      dataType: 'email', group: 'Student', required: false,
    });
  });

  it("suggests the student's own email field and leaves the parent email to the mother rule", () => {
    const out = target.suggestMapping([
      field('f1', "Student's full name"),
      field('f2', 'Student email address'),
      field('f3', 'Parent/Guardian email'),
    ]);
    expect(out).toEqual(expect.arrayContaining([
      { fieldId: 'f1', targetField: 'name', valueMap: null },
      { fieldId: 'f2', targetField: 'studentEmail', valueMap: null },
      { fieldId: 'f3', targetField: 'motherEmail', valueMap: null },
    ]));
  });

  it('suggests "Child e-mail" too', () => {
    expect(target.suggestMapping([field('f1', 'Child e-mail')])).toEqual([
      { fieldId: 'f1', targetField: 'studentEmail', valueMap: null },
    ]);
  });

  it('validates and lowercases the address', () => {
    expect(target.coerceValue('studentEmail', ' Amal.Haddad@Example.com ')).toEqual({ ok: true, value: 'amal.haddad@example.com' });
    expect(target.coerceValue('studentEmail', 'amal.haddad@')).toMatchObject({ ok: false });
  });

  it('writes it as the last parameter of the insert and the fill-blanks update', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ student_id: 's1' }] }) };

    await target.applyCreate(client, { name: 'Amal Haddad', grade: '2', studentEmail: 'amal.haddad@example.com' },
      { school: 'ALHAADIACADEMY', schoolYearId: 'y1', submissionId: 'sub1' });
    const [insertSql, insertParams] = client.query.mock.calls[0];
    expect(insertSql).toBe(importQueries.insertStudentFromSubmission);
    expect(insertParams).toHaveLength(19);
    expect(insertParams[17]).toBe('sub1');
    expect(insertParams[18]).toBe('amal.haddad@example.com');

    await target.applyUpdate(client, 's1', [{ targetField: 'studentEmail', to: 'amal.haddad@example.com' }]);
    const [updateSql, updateParams] = client.query.mock.calls[1];
    expect(updateSql).toBe(importQueries.updateStudentFillBlanks);
    expect(updateParams).toHaveLength(16);
    expect(updateParams[15]).toBe('amal.haddad@example.com');
    expect(updateSql).toContain("student_email      = COALESCE(NULLIF(TRIM(student_email), ''), $16)");
  });

  it('treats a stored student email as filled', () => {
    expect(target.isBlank({ student_email: 'amal.haddad@example.com' }, 'studentEmail')).toBe(false);
    expect(target.isBlank({ student_email: '  ' }, 'studentEmail')).toBe(true);
    expect(importQueries.selectStudentsForMatching).toContain('student_email');
  });
});
