jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const LABEL = 'Earlier grade level skills';

describe('Integration: modified marks', () => {
  let pool;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN', true, true),
              ($2, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [ADMIN_ID, TEACHER_ID],
    );
  });

  const seedClass = async () => {
    const { rows: terms } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`,
    );
    const { rows: classes } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $2, 'Term 1') RETURNING class_id`,
      [TEACHER_ID, terms[0].term_id],
    );
    const classId = classes[0].class_id;
    const insertAssessment = async (name, extra = {}) => {
      const { rows } = await pool.query(
        `INSERT INTO assessments (class_id, name, weight_percent, is_parent, parent_assessment_id, max_score, weight_points)
         VALUES ($1, $2, 20, $3, $4, 50, 20) RETURNING assessment_id`,
        [classId, name, Boolean(extra.isParent), extra.parentId ?? null],
      );
      return rows[0].assessment_id;
    };
    return { classId, insertAssessment };
  };

  const seedStudent = async (classId, name = 'Adam Test') => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ($1, 'ALHAADIACADEMY', '5') RETURNING student_id`,
      [name],
    );
    if (classId) await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, rows[0].student_id]);
    return rows[0].student_id;
  };

  const path = (classId, studentId, assessmentId) => `/api/studentAssessments/classes/${classId}/modified-marks/${studentId}/${assessmentId}`;
  const put = (classId, studentId, assessmentId, body = { label: LABEL }, token) =>
    authenticatedRequest('put', path(classId, studentId, assessmentId), token).send(body);
  const del = (classId, studentId, assessmentId) => authenticatedRequest('delete', path(classId, studentId, assessmentId));
  const marksOf = async (studentId) =>
    (await pool.query('SELECT assessment_id, label, created_by FROM modified_marks WHERE student_id = $1', [studentId])).rows;
  const scoreRow = async (classId, studentId, assessmentId) => {
    const res = await authenticatedRequest('get', `/api/studentAssessments/classes/${classId}/scores`);
    return res.body.data.find((r) => r.student_id === studentId && r.assessment_id === assessmentId);
  };

  describe('PUT', () => {
    it('stores the normalized label and who set it', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      const res = await put(classId, studentId, assessmentId, { label: '  Earlier   grade level skills ' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ student_id: studentId, assessment_id: assessmentId, label: LABEL }]);
      expect(await marksOf(studentId)).toEqual([{ assessment_id: assessmentId, label: LABEL, created_by: ADMIN_ID }]);
    });

    it('updates the label on a second save instead of adding a row', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      await put(classId, studentId, assessmentId);
      await put(classId, studentId, assessmentId, { label: 'Grade 3 level' });

      const marks = await marksOf(studentId);
      expect(marks).toHaveLength(1);
      expect(marks[0].label).toBe('Grade 3 level');
    });

    it('allows no label', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      expect((await put(classId, studentId, assessmentId, { label: null })).status).toBe(200);
      expect((await marksOf(studentId))[0].label).toBeNull();
      expect((await put(classId, studentId, assessmentId, {})).status).toBe(200);
      expect((await put(classId, studentId, assessmentId, { label: '   ' })).status).toBe(200);
      expect((await marksOf(studentId))[0].label).toBeNull();
    });

    it('refuses a label families should not read, and stores nothing', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      const refused = await put(classId, studentId, assessmentId, { label: 'iep test' });
      expect(refused.status).toBe(400);
      expect(refused.body.message).toBe('Use plain words about the test. Families read this label.');

      expect((await put(classId, studentId, assessmentId, { label: 'x'.repeat(81) })).status).toBe(400);
      expect((await put(classId, studentId, assessmentId, { label: 42 })).status).toBe(400);
      expect(await marksOf(studentId)).toEqual([]);
    });

    it('rejects ids that are not ids', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);
      expect((await put(classId, 'nope', assessmentId)).status).toBe(400);
      expect((await put(classId, studentId, 'nope')).status).toBe(400);
    });

    it('returns 404 for a student who is not in the class', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const outsider = await seedStudent(null, 'Layla Test');

      const res = await put(classId, outsider, assessmentId);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe("This student isn't in this class");
      expect(await marksOf(outsider)).toEqual([]);
    });

    it('returns 404 for an assessment from another class', async () => {
      const { classId } = await seedClass();
      const other = await seedClass();
      const foreign = await other.insertAssessment('Other Test');
      const studentId = await seedStudent(classId);

      const res = await put(classId, studentId, foreign);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Assessment not found in this class');
    });

    it('marks every item in a category, never the category itself', async () => {
      const { classId, insertAssessment } = await seedClass();
      const parent = await insertAssessment('Tests', { isParent: true });
      const a = await insertAssessment('Test A', { parentId: parent });
      const b = await insertAssessment('Test B', { parentId: parent });
      const studentId = await seedStudent(classId);

      const res = await put(classId, studentId, parent);

      expect(res.status).toBe(200);
      expect(res.body.data.map((r) => r.assessment_id).sort()).toEqual([a, b].sort());
      expect((await marksOf(studentId)).map((m) => m.assessment_id).sort()).toEqual([a, b].sort());
    });

    it('says whether the column is already shared', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      expect((await put(classId, studentId, assessmentId)).body.published).toBe(false);

      await pool.query('UPDATE assessments SET is_published = TRUE WHERE assessment_id = $1', [assessmentId]);
      expect((await put(classId, studentId, assessmentId)).body.published).toBe(true);
    });

    it('is refused in a read-only preview', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      const res = await put(classId, studentId, assessmentId, { label: LABEL }, { impersonator: { userId: ADMIN_ID, username: 'admin', fullName: 'Admin User' } });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
      expect(await marksOf(studentId)).toEqual([]);
    });
  });

  describe('DELETE', () => {
    it('removes the flag and reports the column state', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);
      await put(classId, studentId, assessmentId);

      const res = await del(classId, studentId, assessmentId);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ removed: 1 });
      expect(res.body.published).toBe(false);
      expect(await marksOf(studentId)).toEqual([]);
    });

    it('removes every item in a category', async () => {
      const { classId, insertAssessment } = await seedClass();
      const parent = await insertAssessment('Tests', { isParent: true });
      await insertAssessment('Test A', { parentId: parent });
      await insertAssessment('Test B', { parentId: parent });
      const studentId = await seedStudent(classId);
      await put(classId, studentId, parent);

      const res = await del(classId, studentId, parent);

      expect(res.body.data).toEqual({ removed: 2 });
      expect(await marksOf(studentId)).toEqual([]);
    });

    it('returns 404 for an assessment from another class', async () => {
      const { classId } = await seedClass();
      const other = await seedClass();
      const foreign = await other.insertAssessment('Other Test');
      const studentId = await seedStudent(classId);
      expect((await del(classId, studentId, foreign)).status).toBe(404);
    });
  });

  describe('the flag and the score stay separate', () => {
    it('survives retyping the score', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);
      await put(classId, studentId, assessmentId);

      const save = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: [{ studentId, assessmentId, score: 36 }] });
      expect(save.status).toBe(200);

      const row = await scoreRow(classId, studentId, assessmentId);
      expect(Number(row.score)).toBe(36);
      expect(row.is_modified).toBe(true);
      expect(row.modified_label).toBe(LABEL);
    });

    it('survives marking missing and clearing it, though Missing clears the score', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);
      await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: [{ studentId, assessmentId, score: 36 }] });
      await put(classId, studentId, assessmentId);

      const status = (value) => authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId, status: value });

      await status('missing');
      const missing = await scoreRow(classId, studentId, assessmentId);
      expect(missing.status).toBe('missing');
      expect(missing.is_modified).toBe(true);

      await status('graded');
      const cleared = await scoreRow(classId, studentId, assessmentId);
      expect(cleared.status).toBe('graded');
      expect(cleared.score).toBeNull();
      expect(cleared.is_modified).toBe(true);
      expect(cleared.modified_label).toBe(LABEL);
    });

    it('reports a cell with no flag as not modified', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);

      const row = await scoreRow(classId, studentId, assessmentId);
      expect(row.is_modified).toBe(false);
      expect(row.modified_label).toBeNull();
    });

    it('reports the flag on a cell with no score row yet', async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const studentId = await seedStudent(classId);
      await put(classId, studentId, assessmentId);

      const row = await scoreRow(classId, studentId, assessmentId);
      expect(row.score).toBeNull();
      expect(row.is_modified).toBe(true);
    });
  });

  describe('the average in a message thread', () => {
    const { selectAssessmentContext } = require('../../../queries/messaging.queries');

    const seedTwoStudents = async () => {
      const { classId, insertAssessment } = await seedClass();
      const assessmentId = await insertAssessment('Fractions Test');
      const adam = await seedStudent(classId, 'Adam Test');
      const layla = await seedStudent(classId, 'Layla Test');
      await pool.query(
        `INSERT INTO student_assessments (student_id, assessment_id, score, status)
         VALUES ($1, $3, 20, 'graded'), ($2, $3, 40, 'graded')`,
        [adam, layla, assessmentId],
      );
      return { classId, assessmentId, adam, layla };
    };
    const threadAverage = async (assessmentId, studentId) =>
      Number((await pool.query(selectAssessmentContext, [assessmentId, studentId])).rows[0].class_avg_pct);

    it('leaves out a modified mark', async () => {
      const { classId, assessmentId, adam, layla } = await seedTwoStudents();
      expect(await threadAverage(assessmentId, layla)).toBe(60);

      await put(classId, adam, assessmentId);

      expect(await threadAverage(assessmentId, layla)).toBe(80);
    });

    it('still counts a missing mark that has the flag, as 0', async () => {
      const { classId, assessmentId, adam, layla } = await seedTwoStudents();
      await put(classId, adam, assessmentId);
      await pool.query(`UPDATE student_assessments SET score = NULL, status = 'missing' WHERE student_id = $1`, [adam]);

      expect(await threadAverage(assessmentId, layla)).toBe(40);
    });
  });

  it('never tells a family when it changes on a published column', async () => {
    const { classId, insertAssessment } = await seedClass();
    const assessmentId = await insertAssessment('Fractions Test');
    const studentId = await seedStudent(classId);
    await pool.query('UPDATE assessments SET is_published = TRUE WHERE assessment_id = $1', [assessmentId]);

    await put(classId, studentId, assessmentId);
    await del(classId, studentId, assessmentId);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM email_outbox');
    expect(rows[0].n).toBe(0);
  });
});
