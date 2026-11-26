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

  it('writes it as its own parameter of the insert and the fill-blanks update', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ student_id: 's1' }] }) };

    await target.applyCreate(client, { name: 'Amal Haddad', grade: '2', studentEmail: 'amal.haddad@example.com' },
      { school: 'ALHAADIACADEMY', schoolYearId: 'y1', submissionId: 'sub1' });
    const [insertSql, insertParams] = client.query.mock.calls[0];
    expect(insertSql).toBe(importQueries.insertStudentFromSubmission);
    expect(insertParams).toHaveLength(21);
    expect(insertParams[17]).toBe('sub1');
    expect(insertParams[18]).toBe('amal.haddad@example.com');

    await target.applyUpdate(client, 's1', [{ targetField: 'studentEmail', to: 'amal.haddad@example.com' }]);
    const [updateSql, updateParams] = client.query.mock.calls[1];
    expect(updateSql).toBe(importQueries.updateStudentFillBlanks);
    expect(updateParams).toHaveLength(18);
    expect(updateParams[15]).toBe('amal.haddad@example.com');
    expect(updateSql).toContain("student_email      = COALESCE(NULLIF(TRIM(student_email), ''), $16)");
  });

  it("lists the student's login link among the rows an import undo would cascade", () => {
    expect(target.dependentTables).toEqual(expect.arrayContaining([
      { table: 'student_account_links', column: 'student_id', label: 'student login' },
    ]));
  });

  it('treats a stored student email as filled', () => {
    expect(target.isBlank({ student_email: 'amal.haddad@example.com' }, 'studentEmail')).toBe(false);
    expect(target.isBlank({ student_email: '  ' }, 'studentEmail')).toBe(true);
    expect(importQueries.selectStudentsForMatching).toContain('student_email');
  });
});

// ─── Gender ───────────────────────────────────────────────────────────

describe('studentImportTarget: gender', () => {
  it('is a mappable Student field with the two stored values', () => {
    expect(target.fieldByTarget.get('gender')).toMatchObject({
      column: 'gender', dataType: 'enum', required: false, enumValues: ['female', 'male'],
    });
  });

  it('suggests a gender question and translates its options', () => {
    const out = target.suggestMapping([
      { field_id: 'g1', label: 'Gender of the student', options: ['Male', 'Female'] },
    ]);
    expect(out).toEqual([{ fieldId: 'g1', targetField: 'gender', valueMap: { Male: 'male', Female: 'female' } }]);
  });

  it('never reads "female" as male', () => {
    expect(target.suggestEnumValue('gender', 'Female')).toBe('female');
    expect(target.suggestEnumValue('gender', 'F')).toBe('female');
    expect(target.suggestEnumValue('gender', 'Boy')).toBe('male');
    expect(target.suggestEnumValue('gender', 'Prefer not to say')).toBeNull();
  });

  it('reads a typed answer whatever its capitals, and uses the option map when there is one', () => {
    expect(target.coerceValue('gender', 'FEMALE', null)).toEqual({ ok: true, value: 'female' });
    expect(target.coerceValue('gender', 'girl', null)).toEqual({ ok: true, value: 'female' });
    expect(target.coerceValue('gender', 'Garcon', { Garcon: 'male' })).toEqual({ ok: true, value: 'male' });
    expect(target.coerceValue('gender', 'unsure', null)).toMatchObject({ ok: false });
  });

  it('still accepts a grade typed in lower case', () => {
    expect(target.coerceValue('grade', 'jk', null)).toEqual({ ok: true, value: 'JK' });
  });

  it('is written on create and only fills a blank on update', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ student_id: 's1' }] }) };
    await target.applyCreate(client, { name: 'Amal Haddad', grade: '2', gender: 'female' },
      { school: 'ALHAADIACADEMY', schoolYearId: 'y1', submissionId: 'sub1' });
    expect(client.query.mock.calls[0][1][19]).toBe('female');

    await target.applyUpdate(client, 's1', [{ targetField: 'gender', to: 'female' }]);
    const [sql, params] = client.query.mock.calls[1];
    expect(params[16]).toBe('female');
    expect(sql).toContain("gender             = COALESCE(NULLIF(TRIM(gender), ''), $17)");
    expect(importQueries.selectStudentsForMatching).toContain('gender');
  });
});

// ─── Dates ────────────────────────────────────────────────────────────

describe('studentImportTarget: dates that do not exist', () => {
  it.each(['2015-02-31', '31/04/2015', '29/02/2015', '2015-13-01', '00/01/2015'])('refuses %s', (raw) => {
    const result = target.coerceValue('dateOfBirth', raw, null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(raw);
  });

  it('says the day is not real, as opposed to not a date at all', () => {
    expect(target.coerceValue('dateOfBirth', '2015-02-31', null).error).toBe('"2015-02-31" is not a real date');
    expect(target.coerceValue('dateOfBirth', 'next spring', null).error).toBe('"next spring" is not a recognizable date');
  });

  it('still reads real dates, ISO and day-first', () => {
    expect(target.coerceValue('dateOfBirth', '2016-02-29', null)).toEqual({ ok: true, value: '2016-02-29' });
    expect(target.coerceValue('dateOfBirth', '3/2/2015', null)).toEqual({ ok: true, value: '2015-02-03' });
    expect(target.coerceValue('dateOfBirth', '31.12.2018', null)).toEqual({ ok: true, value: '2018-12-31' });
  });
});

// ─── Custom fields ────────────────────────────────────────────────────

const BUS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONSENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SIBLINGS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const customMapping = (fieldId, label, type, options = null, valueMap = null) => ({
  field_id: `q-${label}`, target_field: 'custom', value_map: valueMap,
  custom_field_id: fieldId, custom_label: label, custom_type: type, custom_options: options,
});

const busMapping = customMapping(BUS, 'Bus route', 'select', ['Route 4', 'Walks']);
const consentMapping = customMapping(CONSENT, 'Photo consent', 'boolean');
const siblingsMapping = customMapping(SIBLINGS, 'Siblings', 'number');

describe('studentImportTarget: custom fields', () => {
  it('keys a custom mapping by its field and a built-in one by its target', () => {
    expect(target.mappingKey(busMapping)).toBe(`custom:${BUS}`);
    expect(target.mappingKey({ target_field: 'name' })).toBe('name');
  });

  it('reads an answer by the field type, as the student form does', () => {
    expect(target.coerceMapped(busMapping, ' route 4 ')).toEqual({ ok: true, value: 'Route 4' });
    expect(target.coerceMapped(consentMapping, 'Yes')).toEqual({ ok: true, value: true });
    expect(target.coerceMapped(consentMapping, 'no')).toEqual({ ok: true, value: false });
    expect(target.coerceMapped(siblingsMapping, '3')).toEqual({ ok: true, value: 3 });
    expect(target.coerceMapped(siblingsMapping, '')).toEqual({ ok: true, value: null });
  });

  it('blocks an answer the field cannot hold, naming the field', () => {
    expect(target.coerceMapped(busMapping, 'Helicopter')).toEqual({
      ok: false, error: '"Helicopter" is not one of the choices for Bus route',
    });
    expect(target.coerceMapped(siblingsMapping, 'three').ok).toBe(false);
  });

  it('translates an answer through the mapping before reading it', () => {
    const mapped = customMapping(BUS, 'Bus route', 'select', ['Route 4', 'Walks'], { 'On foot': 'Walks' });
    expect(target.coerceMapped(mapped, 'On foot')).toEqual({ ok: true, value: 'Walks' });
  });

  it('still reads a built-in mapping through coerceValue', () => {
    expect(target.coerceMapped({ target_field: 'grade', value_map: { 'Grade 2': '2' } }, 'Grade 2'))
      .toEqual({ ok: true, value: '2' });
  });

  it('treats a custom field as blank only when the student has no value for it', () => {
    const row = { custom_fields: { values: { [CONSENT]: false, [SIBLINGS]: 0, [BUS]: '  ' }, notes: [] } };
    expect(target.isBlank(row, `custom:${CONSENT}`)).toBe(false); // "No" is an answer
    expect(target.isBlank(row, `custom:${SIBLINGS}`)).toBe(false); // so is zero
    expect(target.isBlank(row, `custom:${BUS}`)).toBe(true);
    expect(target.isBlank({ custom_fields: null }, `custom:${BUS}`)).toBe(true);
    expect(importQueries.selectStudentsForMatching).toContain('custom_fields');
  });

  it('proposes filling a custom field only where the student has none', () => {
    const existing = { name: 'Amal', grade: '2', custom_fields: { values: { [BUS]: 'Walks' }, notes: [] } };
    const diff = target.diffFillable(
      existing,
      { [`custom:${BUS}`]: 'Route 4', [`custom:${CONSENT}`]: true },
      [busMapping, consentMapping],
    );
    expect(diff).toEqual([
      { targetField: `custom:${CONSENT}`, label: 'Photo consent', from: null, to: 'Yes', value: true },
    ]);
  });

  it('labels what a row would save, for the preview', () => {
    expect(target.describeExtras(
      { name: 'Amal', [`custom:${BUS}`]: 'Route 4', [`custom:${CONSENT}`]: false },
      [busMapping, consentMapping, siblingsMapping],
    )).toEqual([
      { fieldId: BUS, label: 'Bus route', display: 'Route 4' },
      { fieldId: CONSENT, label: 'Photo consent', display: 'No' },
    ]);
  });

  it('creates the student with typed values and no notes', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ student_id: 's1' }] }) };
    await target.applyCreate(client,
      { name: 'Amal Haddad', grade: '2', [`custom:${BUS}`]: 'Route 4', [`custom:${SIBLINGS}`]: 2, [`custom:${CONSENT}`]: false },
      { school: 'ALHAADIACADEMY', schoolYearId: 'y1', submissionId: 'sub1' });
    expect(JSON.parse(client.query.mock.calls[0][1][20])).toEqual({
      values: { [BUS]: 'Route 4', [SIBLINGS]: 2, [CONSENT]: false },
      notes: [],
    });
  });

  it('sends only the custom values to fill, and lets the stored ones win in SQL', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ student_id: 's1' }] }) };
    await target.applyUpdate(client, 's1', [
      { targetField: `custom:${CONSENT}`, label: 'Photo consent', from: null, to: 'Yes', value: true },
    ]);
    const [sql, params] = client.query.mock.calls[0];
    expect(JSON.parse(params[17])).toEqual({ [CONSENT]: true });
    // The student's own values are on the right of ||, so they are kept.
    expect(sql).toMatch(/COALESCE\(\$18::jsonb, '\{\}'::jsonb\) \|\| COALESCE\(custom_fields -> 'values'/);

    await target.applyUpdate(client, 's1', [{ targetField: 'oen', to: '123' }]);
    expect(client.query.mock.calls[1][1][17]).toBeNull();
  });
});
