jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440011';
const CLERK_ID = '550e8400-e29b-41d4-a716-446655440012';
const FOREIGN_ADMIN_ID = '550e8400-e29b-41d4-a716-446655440099';

const asTeacher = { userId: TEACHER_ID, role: 'TEACHER', email: 'teacher@test.com', username: 'Teacher One' };
const asClerk = { userId: CLERK_ID, role: 'TEACHER', email: 'clerk@test.com', username: 'Attendance Clerk' };
const asForeignAdmin = { userId: FOREIGN_ADMIN_ID, school: 'PLAYGROUND', email: 'admin@playground.test' };

const FIELDS = '/api/student-custom-fields';

describe('Integration: student custom fields', () => {
  let pool, activeYearId;

  const addField = (body, as) => authenticatedRequest('post', FIELDS, as).send(body);
  const listFields = async (as) => (await authenticatedRequest('get', FIELDS, as)).body.data;
  const storedFields = async (studentId) =>
    (await pool.query('SELECT custom_fields FROM students_all WHERE student_id = $1', [studentId])).rows[0].custom_fields;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    const user = (id, email, role) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'hashed', 'Test', 'User', 'ALHAADIACADEMY', $4, true, true)`,
      [id, email, email.split('@')[0], role],
    );
    await user(ADMIN_ID, 'admin@test.com', 'ADMIN');
    await user(TEACHER_ID, 'teacher@test.com', 'TEACHER');
    await user(CLERK_ID, 'clerk@test.com', 'TEACHER');
    // A role that reads the roster (daily attendance) but doesn't edit students.
    const { rows: [role] } = await pool.query(
      `INSERT INTO staff_roles (school, name, permissions) VALUES ('ALHAADIACADEMY', 'Attendance only', '{attendance.daily}') RETURNING role_id`,
    );
    await pool.query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [role.role_id, CLERK_ID]);

    const { rows } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active = true`,
    );
    activeYearId = rows[0].school_year_id;
  });

  // ─── The school's list of fields ────────────────────────────────────

  describe('the list of fields', () => {
    it('a teacher adds a field, and it comes back in order', async () => {
      const first = await addField({ label: '  Bus route ', type: 'select', options: ['Route 4', 'Walks', 'route 4'] }, asTeacher);
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ label: 'Bus route', type: 'select', options: ['Route 4', 'Walks'], sortOrder: 0 });

      const second = await addField({ label: 'Photo consent', type: 'boolean' }, asTeacher);
      expect(second.body.data).toMatchObject({ label: 'Photo consent', type: 'boolean', options: null, sortOrder: 1 });

      expect((await listFields(asTeacher)).map((f) => f.label)).toEqual(['Bus route', 'Photo consent']);
    });

    it('refuses a name the school already uses, whatever its capitals', async () => {
      await addField({ label: 'Bus route', type: 'text' });
      const res = await addField({ label: 'BUS ROUTE', type: 'number' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'FIELD_NAME_TAKEN', message: 'A field called "BUS ROUTE" already exists' });
    });

    it('refuses a field that is not well formed', async () => {
      expect((await addField({ label: '', type: 'text' })).status).toBe(400);
      expect((await addField({ label: 'Bus', type: 'colour' })).status).toBe(400);
      expect((await addField({ label: 'Bus', type: 'select', options: [] })).status).toBe(400);
      expect(await listFields()).toEqual([]);
    });

    it('only school setup renames, reorders, deletes or restores', async () => {
      const { body: { data: field } } = await addField({ label: 'Bus route', type: 'text' }, asTeacher);
      const id = field.fieldId;

      expect((await authenticatedRequest('patch', `${FIELDS}/${id}`, asTeacher).send({ label: 'Bus' })).status).toBe(403);
      expect((await authenticatedRequest('put', `${FIELDS}/order`, asTeacher).send({ order: [id] })).status).toBe(403);
      expect((await authenticatedRequest('get', `${FIELDS}/${id}/usage`, asTeacher)).status).toBe(403);
      expect((await authenticatedRequest('delete', `${FIELDS}/${id}`, asTeacher)).status).toBe(403);
      expect((await authenticatedRequest('post', `${FIELDS}/${id}/restore`, asTeacher)).status).toBe(403);
      expect((await authenticatedRequest('get', `${FIELDS}/deleted`, asTeacher)).status).toBe(403);
      expect((await listFields()).map((f) => f.label)).toEqual(['Bus route']);
    });

    it('someone who neither edits students, sets up the school nor runs forms cannot read or add', async () => {
      expect((await authenticatedRequest('get', FIELDS, asClerk)).status).toBe(403);
      expect((await addField({ label: 'Bus route', type: 'text' }, asClerk)).status).toBe(403);
    });

    it('an admin renames a field and edits a dropdown, but never its type', async () => {
      const { body: { data: field } } = await addField({ label: 'Bus route', type: 'select', options: ['Route 4'] });
      const url = `${FIELDS}/${field.fieldId}`;

      const renamed = await authenticatedRequest('patch', url).send({ label: 'Bus', options: ['Route 4', 'Route 9'] });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ label: 'Bus', type: 'select', options: ['Route 4', 'Route 9'] });

      const retyped = await authenticatedRequest('patch', url).send({ type: 'text' });
      expect(retyped.status).toBe(400);
      expect(retyped.body.message).toMatch(/type can't be changed/);

      await addField({ label: 'Locker', type: 'text' });
      const taken = await authenticatedRequest('patch', url).send({ label: 'locker' });
      expect(taken.status).toBe(409);
    });

    it('reorders the whole list, and refuses a list that has since changed', async () => {
      const ids = [];
      for (const label of ['One', 'Two', 'Three']) {
        ids.push((await addField({ label, type: 'text' })).body.data.fieldId);
      }
      const res = await authenticatedRequest('put', `${FIELDS}/order`).send({ order: [ids[2], ids[0], ids[1]] });
      expect(res.status).toBe(200);
      expect(res.body.data.map((f) => f.label)).toEqual(['Three', 'One', 'Two']);

      const stale = await authenticatedRequest('put', `${FIELDS}/order`).send({ order: [ids[0], ids[1]] });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('FIELDS_CHANGED');
      expect((await listFields()).map((f) => f.label)).toEqual(['Three', 'One', 'Two']);
    });

    it("never shows or changes another school's fields", async () => {
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      const { body: { data: field } } = await addField({ label: 'Bus route', type: 'text' });

      expect(await listFields(asForeignAdmin)).toEqual([]);
      expect((await authenticatedRequest('patch', `${FIELDS}/${field.fieldId}`, asForeignAdmin).send({ label: 'Mine' })).status).toBe(404);
      expect((await authenticatedRequest('delete', `${FIELDS}/${field.fieldId}`, asForeignAdmin)).status).toBe(404);
      // The same name is free in the other school.
      expect((await addField({ label: 'Bus route', type: 'text' }, asForeignAdmin)).status).toBe(201);
      expect((await listFields()).map((f) => f.label)).toEqual(['Bus route']);
    });
  });

  // ─── Values on the student ──────────────────────────────────────────

  describe('values on a student', () => {
    let bus, consent, siblings;

    beforeEach(async () => {
      bus = (await addField({ label: 'Bus route', type: 'select', options: ['Route 4', 'Walks'] })).body.data.fieldId;
      consent = (await addField({ label: 'Photo consent', type: 'boolean' })).body.data.fieldId;
      siblings = (await addField({ label: 'Siblings', type: 'number' })).body.data.fieldId;
    });

    const createStudent = (customFields, as) => authenticatedRequest('post', '/api/students', as)
      .send({ name: 'Amal Haddad', grade: '2', ...(customFields ? { customFields } : {}) });
    const patchStudent = (id, body, as) => authenticatedRequest('patch', `/api/students/${id}`, as).send(body);

    it('saves them with a new student and returns them', async () => {
      const res = await createStudent({
        values: { [bus]: 'route 4', [consent]: false, [siblings]: null },
        notes: [{ label: ' Locker ', value: 'B14' }, { label: '', value: '' }],
      }, asTeacher);
      expect(res.status).toBe(201);
      expect(res.body.data.customFields).toEqual({
        values: { [bus]: 'Route 4', [consent]: false },
        notes: [{ label: 'Locker', value: 'B14' }],
      });
      expect(await storedFields(res.body.data.studentId)).toEqual(res.body.data.customFields);
    });

    it('a student made without any starts empty', async () => {
      const res = await createStudent();
      expect(res.body.data.customFields).toEqual({ values: {}, notes: [] });
    });

    it('an edit changes only the fields it carries: set, clear, and leave alone', async () => {
      const { body: { data: student } } = await createStudent({
        values: { [bus]: 'Walks', [consent]: true, [siblings]: 2 },
        notes: [{ label: 'Locker', value: 'B14' }],
      });

      const res = await patchStudent(student.studentId, { customFields: { values: { [bus]: 'Route 4', [siblings]: null } } }, asTeacher);
      expect(res.status).toBe(200);
      expect(res.body.data.customFields).toEqual({
        values: { [bus]: 'Route 4', [consent]: true },
        notes: [{ label: 'Locker', value: 'B14' }],
      });
    });

    it('an edit that carries notes replaces them, and an empty list clears them', async () => {
      const { body: { data: student } } = await createStudent({
        values: { [consent]: true },
        notes: [{ label: 'Locker', value: 'B14' }],
      });

      const replaced = await patchStudent(student.studentId, { customFields: { notes: [{ label: 'Pickup', value: 'Aunt on Fridays' }] } });
      expect(replaced.body.data.customFields).toEqual({
        values: { [consent]: true },
        notes: [{ label: 'Pickup', value: 'Aunt on Fridays' }],
      });

      const cleared = await patchStudent(student.studentId, { customFields: { notes: [] } });
      expect(cleared.body.data.customFields).toEqual({ values: { [consent]: true }, notes: [] });
    });

    it('an edit that carries no custom fields leaves them as they are', async () => {
      const { body: { data: student } } = await createStudent({ values: { [bus]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] });
      const res = await patchStudent(student.studentId, { name: 'Amal H. Haddad' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Amal H. Haddad');
      expect(res.body.data.customFields).toEqual({ values: { [bus]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] });
    });

    it('refuses a value the field cannot hold and saves nothing', async () => {
      const { body: { data: student } } = await createStudent({ values: { [bus]: 'Walks' } });

      const wrongChoice = await patchStudent(student.studentId, { name: 'Changed', customFields: { values: { [bus]: 'Helicopter' } } });
      expect(wrongChoice.status).toBe(400);
      expect(wrongChoice.body.message).toBe('"Helicopter" is not one of the choices for Bus route');

      const wrongNumber = await patchStudent(student.studentId, { customFields: { values: { [siblings]: 'lots' } } });
      expect(wrongNumber.status).toBe(400);
      expect(wrongNumber.body.message).toMatch(/^Siblings needs a number/);

      const unknown = await patchStudent(student.studentId, { customFields: { values: { '99999999-9999-4999-8999-999999999999': 'x' } } });
      expect(unknown.status).toBe(400);

      const bad = await createStudent({ values: { [consent]: 'maybe' } });
      expect(bad.status).toBe(400);

      const { rows: [row] } = await pool.query('SELECT name, custom_fields FROM students WHERE student_id = $1', [student.studentId]);
      expect(row).toEqual({ name: 'Amal Haddad', custom_fields: { values: { [bus]: 'Walks' }, notes: [] } });
    });

    it("refuses another school's field", async () => {
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      const foreign = (await addField({ label: 'Bus route', type: 'text' }, asForeignAdmin)).body.data.fieldId;
      const res = await createStudent({ values: { [foreign]: 'x' } });
      expect(res.status).toBe(400);
    });

    it('shows them on the list, the single student and the profile, to those who edit students', async () => {
      const { body: { data: student } } = await createStudent({ values: { [bus]: 'Walks' } });
      const expected = { values: { [bus]: 'Walks' }, notes: [] };

      const list = await authenticatedRequest('get', '/api/students', asTeacher);
      expect(list.body.data.find((s) => s.studentId === student.studentId).customFields).toEqual(expected);

      const one = await authenticatedRequest('get', `/api/students/${student.studentId}`, asTeacher);
      expect(one.body.data.customFields).toEqual(expected);

      const overview = await authenticatedRequest('get', `/api/students/${student.studentId}/overview`, asTeacher);
      expect(overview.status).toBe(200);
      expect(overview.body.data.student.customFields).toEqual(expected);
    });

    it('keeps them from staff who only read the roster', async () => {
      const { body: { data: student } } = await createStudent({ values: { [bus]: 'Walks' }, notes: [{ label: 'Locker', value: 'B14' }] });

      const list = await authenticatedRequest('get', '/api/students', asClerk);
      expect(list.status).toBe(200);
      const row = list.body.data.find((s) => s.studentId === student.studentId);
      expect(row.name).toBe('Amal Haddad');
      expect(row).not.toHaveProperty('customFields');
      expect(JSON.stringify(list.body)).not.toContain('B14');

      const one = await authenticatedRequest('get', `/api/students/${student.studentId}`, asClerk);
      expect(one.body.data).not.toHaveProperty('customFields');
    });
  });

  // ─── Deleting a field hides it; restoring brings the values back ────

  describe('delete and restore', () => {
    it('hides the field, keeps the values on the students, and restores both', async () => {
      const bus = (await addField({ label: 'Bus route', type: 'text' })).body.data.fieldId;
      const { body: { data: student } } = await authenticatedRequest('post', '/api/students')
        .send({ name: 'Amal Haddad', grade: '2', customFields: { values: { [bus]: 'Route 4' } } });

      const usage = await authenticatedRequest('get', `${FIELDS}/${bus}/usage`);
      expect(usage.body.data).toEqual({ studentCount: 1, formCount: 0 });

      const deleted = await authenticatedRequest('delete', `${FIELDS}/${bus}`);
      expect(deleted.status).toBe(200);
      expect(await listFields()).toEqual([]);

      const bin = await authenticatedRequest('get', `${FIELDS}/deleted`);
      expect(bin.body.data).toEqual([expect.objectContaining({ fieldId: bus, label: 'Bus route', deletedByName: 'Test User' })]);
      expect(bin.body.data[0].deletedAt).toBeTruthy();

      // Nothing is erased, and a hidden field takes no new values.
      expect(await storedFields(student.studentId)).toEqual({ values: { [bus]: 'Route 4' }, notes: [] });
      const write = await authenticatedRequest('patch', `/api/students/${student.studentId}`)
        .send({ customFields: { values: { [bus]: 'Route 9' } } });
      expect(write.status).toBe(400);
      expect((await authenticatedRequest('patch', `${FIELDS}/${bus}`).send({ label: 'Bus' })).status).toBe(404);
      expect((await authenticatedRequest('delete', `${FIELDS}/${bus}`)).status).toBe(404);

      const restored = await authenticatedRequest('post', `${FIELDS}/${bus}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body.message).toBe('"Bus route" is back');
      expect((await listFields()).map((f) => f.fieldId)).toEqual([bus]);
      const after = await authenticatedRequest('get', `/api/students/${student.studentId}`);
      expect(after.body.data.customFields.values).toEqual({ [bus]: 'Route 4' });
    });

    it('frees the name while the field is deleted, and asks for a rename before restoring into a clash', async () => {
      const first = (await addField({ label: 'Bus route', type: 'text' })).body.data.fieldId;
      await authenticatedRequest('delete', `${FIELDS}/${first}`);

      const second = await addField({ label: 'Bus route', type: 'number' });
      expect(second.status).toBe(201);

      const clash = await authenticatedRequest('post', `${FIELDS}/${first}/restore`);
      expect(clash.status).toBe(409);
      expect(clash.body.message).toMatch(/Rename that one, then restore this/);

      await authenticatedRequest('patch', `${FIELDS}/${second.body.data.fieldId}`).send({ label: 'Bus number' });
      expect((await authenticatedRequest('post', `${FIELDS}/${first}/restore`)).status).toBe(200);
      expect((await listFields()).map((f) => f.label)).toEqual(['Bus number', 'Bus route']);
    });

    it('restore only works on a deleted field', async () => {
      const bus = (await addField({ label: 'Bus route', type: 'text' })).body.data.fieldId;
      expect((await authenticatedRequest('post', `${FIELDS}/${bus}/restore`)).status).toBe(404);
      expect((await authenticatedRequest('post', `${FIELDS}/not-an-id/restore`)).status).toBe(404);
    });
  });
});
