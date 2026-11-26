jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

// Importing registration form submissions as students, end to end against a
// real database: the saved mapping (built-in fields, gender and the school's
// custom fields), preview, execute and undo.

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const FORMS_ONLY_ID = '550e8400-e29b-41d4-a716-446655440021';
const asFormsOnly = { userId: FORMS_ONLY_ID, role: 'TEACHER', email: 'forms@test.com', username: 'Forms Only' };

describe('Integration: importing form submissions as students', () => {
  let pool, activeYearId, formId, Q;

  const api = (path) => `/api/registration${path}`;
  const mappingUrl = () => api(`/forms/${formId}/import/mapping`);
  const saveMapping = (mappings, as) => authenticatedRequest('put', mappingUrl(), as).send({ mappings });
  const preview = (body = {}) => authenticatedRequest('post', api(`/forms/${formId}/import/preview`))
    .send({ scope: { mode: 'filtered' }, ...body });
  const execute = (body = {}) => authenticatedRequest('post', api(`/forms/${formId}/import/execute`))
    .send({ scope: { mode: 'filtered' }, ...body });
  const undo = (submissionId, deleteStudent) => authenticatedRequest('post', api(`/submissions/${submissionId}/import/undo`))
    .send({ deleteStudent });

  // Submissions are listed newest first, so `minutesAgo` fixes the order rows are classified in.
  const submit = async (answers, minutesAgo = 0) => {
    const byField = Object.fromEntries(Object.entries(answers).map(([key, value]) => [Q[key], value]));
    const { rows } = await pool.query(
      `INSERT INTO registration_form_submissions (form_id, school, answers, status, submitted_at)
       VALUES ($1, 'ALHAADIACADEMY', $2::jsonb, 'new', NOW() - ($3 || ' minutes')::interval) RETURNING submission_id`,
      [formId, JSON.stringify(byField), String(minutesAgo)],
    );
    return rows[0].submission_id;
  };

  const studentNamed = async (name) =>
    (await pool.query('SELECT * FROM students_all WHERE name = $1', [name])).rows[0];
  const fieldNamed = async (label) =>
    (await pool.query(`SELECT * FROM student_custom_fields WHERE label = $1`, [label])).rows[0];

  // The mapping an admin would save for this form: built-ins, gender, and two
  // questions kept as new custom fields.
  const fullMapping = () => [
    { fieldId: Q.name, targetField: 'name', valueMap: null },
    { fieldId: Q.grade, targetField: 'grade', valueMap: { 'Grade 1': '1', 'Grade 2': '2' } },
    { fieldId: Q.dob, targetField: 'dateOfBirth', valueMap: null },
    { fieldId: Q.gender, targetField: 'gender', valueMap: { Boy: 'male', Girl: 'female' } },
    { fieldId: Q.bus, targetField: 'custom', newField: { label: 'Bus route', type: 'select', options: ['Route 4', 'Walks'] } },
    { fieldId: Q.consent, targetField: 'custom', newField: { label: 'Photo consent', type: 'boolean' } },
  ];

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'admin@test.com', 'Admin', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN', true, true),
              ($2, 'forms@test.com', 'Forms Only', 'hashed', 'Forms', 'Only', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [ADMIN_ID, FORMS_ONLY_ID],
    );
    // Runs forms and nothing else: may map and preview, but not edit students.
    const { rows: [role] } = await pool.query(
      `INSERT INTO staff_roles (school, name, permissions) VALUES ('ALHAADIACADEMY', 'Forms only', '{forms}') RETURNING role_id`,
    );
    await pool.query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [role.role_id, FORMS_ONLY_ID]);

    activeYearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active = true`,
    )).rows[0].school_year_id;

    await pool.query(
      `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default)
       VALUES ('ALHAADIACADEMY', 'new', 'New', true, true), ('ALHAADIACADEMY', 'reviewed', 'Reviewed', true, false)
       ON CONFLICT DO NOTHING`,
    );
    formId = (await pool.query(
      `INSERT INTO registration_forms (school, title, slug, created_by)
       VALUES ('ALHAADIACADEMY', 'New students', 'new-students', $1) RETURNING form_id`,
      [ADMIN_ID],
    )).rows[0].form_id;

    Q = {};
    const question = async (key, type, label, options = null, order = 0) => {
      const { rows } = await pool.query(
        `INSERT INTO registration_form_fields (form_id, field_type, label, options, sort_order)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING field_id`,
        [formId, type, label, options ? JSON.stringify(options) : null, order],
      );
      Q[key] = rows[0].field_id;
    };
    await question('name', 'text', "Student's full name", null, 0);
    await question('grade', 'select', 'Grade applying for', ['Grade 1', 'Grade 2'], 1);
    await question('dob', 'text', 'Date of birth', null, 2);
    await question('gender', 'radio', 'Gender', ['Boy', 'Girl'], 3);
    await question('bus', 'select', 'How will your child get to school?', ['Route 4', 'Walks'], 4);
    await question('consent', 'radio', 'May we use photos of your child?', ['Yes', 'No'], 5);
    await question('heard', 'text', 'How did you hear about us?', null, 6);
  });

  // ─── The mapping ────────────────────────────────────────────────────

  describe('the mapping', () => {
    it('suggests gender with its answers translated, and lists the custom fields a question could go to', async () => {
      await authenticatedRequest('post', '/api/student-custom-fields').send({ label: 'Locker', type: 'text' });
      const res = await authenticatedRequest('get', mappingUrl());
      expect(res.status).toBe(200);
      expect(res.body.data.isSuggested).toBe(true);
      expect(res.body.data.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: Q.gender, targetField: 'gender', valueMap: { Boy: 'male', Girl: 'female' }, customFieldId: null }),
      ]));
      expect(res.body.data.targetFields).toEqual(expect.arrayContaining([
        expect.objectContaining({ targetField: 'gender', dataType: 'enum', enumValues: ['female', 'male'] }),
      ]));
      expect(res.body.data.customFields).toEqual([expect.objectContaining({ label: 'Locker', type: 'text' })]);
    });

    it('creates the new custom fields together with the mapping', async () => {
      const res = await saveMapping(fullMapping());
      expect(res.status).toBe(200);
      expect(res.body.data.createdFields.map((f) => f.label)).toEqual(['Bus route', 'Photo consent']);
      expect(res.body.data.customFields.map((f) => f.label)).toEqual(['Bus route', 'Photo consent']);

      const bus = await fieldNamed('Bus route');
      expect(bus).toMatchObject({ field_type: 'select', options: ['Route 4', 'Walks'], created_by: ADMIN_ID });
      expect(res.body.data.mappings).toEqual(expect.arrayContaining([
        expect.objectContaining({ fieldId: Q.bus, targetField: 'custom', customFieldId: bus.field_id }),
        expect.objectContaining({ fieldId: Q.gender, targetField: 'gender', customFieldId: null }),
      ]));

      // Saving again maps to the fields that now exist rather than making more.
      const again = await saveMapping(fullMapping());
      expect(again.status).toBe(200);
      expect(again.body.data.createdFields).toEqual([]);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM student_custom_fields')).rows[0].n).toBe(2);
    });

    it('maps several questions to custom fields, each to its own', async () => {
      await saveMapping(fullMapping());
      const bus = await fieldNamed('Bus route');
      const twice = await saveMapping([
        { fieldId: Q.name, targetField: 'name' },
        { fieldId: Q.grade, targetField: 'grade' },
        { fieldId: Q.bus, targetField: 'custom', customFieldId: bus.field_id },
        { fieldId: Q.heard, targetField: 'custom', customFieldId: bus.field_id },
      ]);
      expect(twice.status).toBe(400);
      expect(twice.body.message).toBe('Two form fields both map to "Bus route"');
    });

    it('saves nothing when any part of the mapping is refused', async () => {
      const res = await saveMapping([
        { fieldId: Q.name, targetField: 'name' },
        { fieldId: Q.bus, targetField: 'custom', newField: { label: 'Bus route', type: 'text' } },
        { fieldId: Q.heard, targetField: 'custom', newField: { label: '', type: 'text' } },
      ]);
      expect(res.status).toBe(400);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM student_custom_fields')).rows[0].n).toBe(0);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM registration_field_mappings')).rows[0].n).toBe(0);
    });

    it('refuses a custom mapping that names neither an existing field nor a new one', async () => {
      const res = await saveMapping([{ fieldId: Q.bus, targetField: 'custom' }]);
      expect(res.status).toBe(400);
      const unknown = await saveMapping([{ fieldId: Q.bus, targetField: 'custom', customFieldId: '99999999-9999-4999-8999-999999999999' }]);
      expect(unknown.status).toBe(400);
    });

    it('someone who runs forms but does not edit students maps to existing fields, and cannot add one', async () => {
      const { body: { data: locker } } = await authenticatedRequest('post', '/api/student-custom-fields').send({ label: 'Locker', type: 'text' });

      const adding = await saveMapping([
        { fieldId: Q.name, targetField: 'name' },
        { fieldId: Q.heard, targetField: 'custom', newField: { label: 'Heard from', type: 'text' } },
      ], asFormsOnly);
      expect(adding.status).toBe(403);
      expect(await fieldNamed('Heard from')).toBeUndefined();

      const existing = await saveMapping([
        { fieldId: Q.name, targetField: 'name' },
        { fieldId: Q.heard, targetField: 'custom', customFieldId: locker.fieldId },
      ], asFormsOnly);
      expect(existing.status).toBe(200);
    });
  });

  // ─── Preview and execute ────────────────────────────────────────────

  describe('preview and execute', () => {
    beforeEach(async () => {
      expect((await saveMapping(fullMapping())).status).toBe(200);
    });

    it('creates the student with gender and the custom answers, typed', async () => {
      const submissionId = await submit({
        name: 'Amal Haddad', grade: 'Grade 2', dob: '11/04/2019', gender: 'Girl',
        bus: 'Route 4', consent: 'No', heard: 'A neighbour',
      });
      const bus = await fieldNamed('Bus route');
      const consent = await fieldNamed('Photo consent');

      const shown = await preview();
      expect(shown.status).toBe(200);
      expect(shown.body.data.rows[0]).toMatchObject({
        action: 'create',
        mappedName: 'Amal Haddad',
        extras: [
          { fieldId: bus.field_id, label: 'Bus route', display: 'Route 4' },
          { fieldId: consent.field_id, label: 'Photo consent', display: 'No' },
        ],
      });

      const res = await execute();
      expect(res.status).toBe(200);
      expect(res.body.data.summary).toMatchObject({ created: 1, updated: 0, errored: 0 });

      const student = await studentNamed('Amal Haddad');
      expect(student).toMatchObject({
        grade: '2',
        gender: 'female',
        source_submission_id: submissionId,
        school_year_id: activeYearId,
        custom_fields: { values: { [bus.field_id]: 'Route 4', [consent.field_id]: false }, notes: [] },
      });
      expect(student.date_of_birth.toISOString().slice(0, 10)).toBe('2019-04-11');

      // An unmapped question ("How did you hear about us?") is still only on the submission.
      expect(JSON.stringify(student.custom_fields)).not.toContain('A neighbour');
      const { rows: [submission] } = await pool.query(
        'SELECT imported_student_id, import_created_student, status FROM registration_form_submissions WHERE submission_id = $1', [submissionId]);
      expect(submission).toEqual({ imported_student_id: student.student_id, import_created_student: true, status: 'reviewed' });
    });

    it('a date that does not exist blocks its own row and nothing else', async () => {
      await submit({ name: 'Bad Date', grade: 'Grade 1', dob: '2019-02-31' }, 2);
      await submit({ name: 'Also Bad', grade: 'Grade 1', dob: '31/04/2019' }, 1);
      await submit({ name: 'Good Kid', grade: 'Grade 1', dob: '2019-02-28' }, 0);

      const shown = await preview();
      const byName = Object.fromEntries(shown.body.data.rows.map((r) => [r.mappedName, r]));
      expect(byName['Bad Date']).toMatchObject({ action: 'error', locked: true, reason: '"2019-02-31" is not a real date' });
      expect(byName['Also Bad']).toMatchObject({ action: 'error', reason: '"31/04/2019" is not a real date' });
      expect(byName['Good Kid'].action).toBe('create');

      const res = await execute();
      expect(res.status).toBe(200);
      expect(res.body.data.summary).toMatchObject({ created: 1, errored: 2, total: 3 });
      expect(await studentNamed('Good Kid')).toBeDefined();
      expect(await studentNamed('Bad Date')).toBeUndefined();
    });

    it('an answer a custom field cannot hold blocks its own row, with the reason', async () => {
      // The field's choices change after the form was built.
      const bus = await fieldNamed('Bus route');
      await authenticatedRequest('patch', `/api/student-custom-fields/${bus.field_id}`).send({ options: ['Walks'] });
      await submit({ name: 'Rides Bus', grade: 'Grade 1', bus: 'Route 4' }, 1);
      await submit({ name: 'Walker', grade: 'Grade 1', bus: 'Walks' }, 0);

      const res = await execute();
      expect(res.body.data.summary).toMatchObject({ created: 1, errored: 1 });
      const blocked = res.body.data.results.find((r) => r.action === 'error');
      expect(blocked.reason).toBe('"Route 4" is not one of the choices for Bus route');
      expect((await studentNamed('Walker')).custom_fields.values).toEqual({ [bus.field_id]: 'Walks' });
    });

    it('the same child submitted twice in one batch is created once', async () => {
      const older = await submit({ name: 'Amal Haddad', grade: 'Grade 2', bus: 'Walks' }, 5);
      const newer = await submit({ name: ' amal  HADDAD ', grade: 'Grade 2', bus: 'Route 4' }, 0);

      const shown = await preview();
      expect(shown.body.data.rows.map((r) => [r.submissionId, r.action, r.matchTier])).toEqual([
        [newer, 'create', 'none'],
        [older, 'skip', 'batch'],
      ]);
      expect(shown.body.data.rows[1].reason).toBe('Same student as an earlier submission in this import');

      const res = await execute();
      expect(res.body.data.summary).toMatchObject({ created: 1, skipped: 1 });
      const { rows } = await pool.query(`SELECT name FROM students WHERE lower(btrim(name)) LIKE 'amal%'`);
      expect(rows).toHaveLength(1);

      // The admin can still say they really are two children.
      const both = await execute({ overrides: { [older]: 'create' } });
      expect(both.body.data.summary).toMatchObject({ created: 1 });
      expect((await pool.query(`SELECT 1 FROM students WHERE lower(btrim(name)) LIKE 'amal%'`)).rows).toHaveLength(2);
    });

    it('fills only what an existing student is missing, custom fields included', async () => {
      const bus = await fieldNamed('Bus route');
      const consent = await fieldNamed('Photo consent');
      const { rows: [existing] } = await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id, custom_fields)
         VALUES ('Amal Haddad', '2', 'ALHAADIACADEMY', $1, $2::jsonb) RETURNING student_id`,
        [activeYearId, JSON.stringify({ values: { [bus.field_id]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] })],
      );
      const submissionId = await submit({ name: 'Amal Haddad', grade: 'Grade 2', gender: 'Girl', bus: 'Route 4', consent: 'Yes' });

      const shown = await preview({ overrides: { [submissionId]: 'update' } });
      const row = shown.body.data.rows[0];
      expect(row.action).toBe('update');
      expect(row.diff.map((d) => [d.label, d.to])).toEqual([['Gender', 'female'], ['Photo consent', 'Yes']]);

      const res = await execute({ overrides: { [submissionId]: 'update' } });
      expect(res.body.data.summary).toMatchObject({ created: 0, updated: 1 });
      expect(res.body.data.results[0].fieldsFilled).toEqual(['Gender', 'Photo consent']);

      const { rows: [after] } = await pool.query('SELECT gender, custom_fields FROM students WHERE student_id = $1', [existing.student_id]);
      expect(after.gender).toBe('female');
      expect(after.custom_fields).toEqual({
        values: { [bus.field_id]: 'Walks', [consent.field_id]: true }, // the bus route they already had is kept
        notes: [{ label: 'Locker', value: 'B14' }],
      });
      const { rows: [submission] } = await pool.query(
        'SELECT import_created_student FROM registration_form_submissions WHERE submission_id = $1', [submissionId]);
      expect(submission.import_created_student).toBe(false);
    });

    it('a row the database refuses is reported and the rest of the import still goes through', async () => {
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_refuse_student() RETURNS trigger AS $$
        BEGIN
          IF NEW.name = 'Refused Kid' THEN RAISE EXCEPTION 'refused by the database'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER trg_test_refuse_student BEFORE INSERT ON students_all
          FOR EACH ROW EXECUTE FUNCTION test_refuse_student();
      `);
      try {
        const refused = await submit({ name: 'Refused Kid', grade: 'Grade 1' }, 1);
        await submit({ name: 'First Kid', grade: 'Grade 1' }, 2);
        await submit({ name: 'Last Kid', grade: 'Grade 2' }, 0);

        const res = await execute();
        expect(res.status).toBe(200);
        expect(res.body.data.summary).toMatchObject({ created: 2, errored: 1, total: 3 });
        expect(res.body.data.results.find((r) => r.submissionId === refused)).toMatchObject({
          action: 'error',
          reason: "This submission couldn't be saved. Nothing was changed for it.",
        });

        expect(await studentNamed('First Kid')).toBeDefined();
        expect(await studentNamed('Last Kid')).toBeDefined();
        expect(await studentNamed('Refused Kid')).toBeUndefined();
        const { rows: [submission] } = await pool.query(
          'SELECT imported_student_id, status FROM registration_form_submissions WHERE submission_id = $1', [refused]);
        expect(submission).toEqual({ imported_student_id: null, status: 'new' });
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS trg_test_refuse_student ON students_all;
          DROP FUNCTION IF EXISTS test_refuse_student();
        `);
      }
    });

    it('imports nothing into a custom field the school has deleted, and resumes when it is restored', async () => {
      const bus = await fieldNamed('Bus route');
      await authenticatedRequest('delete', `/api/student-custom-fields/${bus.field_id}`);
      await submit({ name: 'Amal Haddad', grade: 'Grade 2', bus: 'Route 4', consent: 'Yes' });

      const hidden = await preview();
      expect(hidden.body.data.rows[0].extras.map((e) => e.label)).toEqual(['Photo consent']);
      const mapping = await authenticatedRequest('get', mappingUrl());
      expect(mapping.body.data.mappings.find((m) => m.fieldId === Q.bus)).toBeUndefined();

      await authenticatedRequest('post', `/api/student-custom-fields/${bus.field_id}/restore`);
      const back = await preview();
      expect(back.body.data.rows[0].extras.map((e) => e.label)).toEqual(['Bus route', 'Photo consent']);
    });
  });

  // ─── Undo ───────────────────────────────────────────────────────────

  describe('undo', () => {
    beforeEach(async () => {
      expect((await saveMapping(fullMapping())).status).toBe(200);
    });

    it('deletes the student the import created, when asked', async () => {
      const submissionId = await submit({ name: 'Amal Haddad', grade: 'Grade 2' });
      await execute();

      const info = await authenticatedRequest('get', api(`/submissions/${submissionId}/import/undo`));
      expect(info.body.data).toMatchObject({ createdByImport: true, canDelete: true });

      const res = await undo(submissionId, true);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ studentDeleted: true, createdByImport: true });
      expect((await studentNamed('Amal Haddad')).deleted_at).not.toBeNull();
    });

    it('keeps the student when a later submission was imported into them too', async () => {
      const first = await submit({ name: 'Amal Haddad', grade: 'Grade 2' }, 5);
      await execute();
      // A second submission for the same child fills in her gender.
      const second = await submit({ name: 'Amal Haddad', grade: 'Grade 2', gender: 'Girl' }, 0);
      const filled = await execute({ scope: { mode: 'selected', submissionIds: [second] }, overrides: { [second]: 'update' } });
      expect(filled.body.data.summary.updated).toBe(1);

      const info = await authenticatedRequest('get', api(`/submissions/${first}/import/undo`));
      expect(info.body.data).toMatchObject({ createdByImport: true, canDelete: false });
      expect(info.body.data.blockedBy.map((b) => b.label)).toEqual(['other imported submissions']);

      const res = await undo(first, true);
      expect(res.body.data.studentDeleted).toBe(false);
      const student = await studentNamed('Amal Haddad');
      expect(student.deleted_at).toBeNull();
      // The second submission still points at her.
      const { rows: [link] } = await pool.query(
        'SELECT imported_student_id FROM registration_form_submissions WHERE submission_id = $1', [second]);
      expect(link.imported_student_id).toBe(student.student_id);
    });

    it("never deletes a student who was already in the school", async () => {
      const { rows: [existing] } = await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amal Haddad', '2', 'ALHAADIACADEMY', $1) RETURNING student_id`,
        [activeYearId],
      );
      const submissionId = await submit({ name: 'Amal Haddad', grade: 'Grade 2', gender: 'Girl' });
      const imported = await execute({ overrides: { [submissionId]: 'update' } });
      expect(imported.body.data.summary.updated).toBe(1);

      const info = await authenticatedRequest('get', api(`/submissions/${submissionId}/import/undo`));
      expect(info.body.data).toMatchObject({ createdByImport: false, canDelete: false, blockedBy: [] });

      const res = await undo(submissionId, true);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ unlinked: true, studentDeleted: false, createdByImport: false });
      expect(res.body.message).toMatch(/already in SchoolMule before this import/);

      const { rows: [after] } = await pool.query(
        'SELECT deleted_at, is_archived, source_submission_id FROM students_all WHERE student_id = $1', [existing.student_id]);
      expect(after).toEqual({ deleted_at: null, is_archived: false, source_submission_id: null });
      const { rows: [submission] } = await pool.query(
        'SELECT imported_student_id FROM registration_form_submissions WHERE submission_id = $1', [submissionId]);
      expect(submission.imported_student_id).toBeNull();
    });
  });
});
