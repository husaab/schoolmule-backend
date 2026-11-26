jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440021';

// A grade is only written for a student on the class's roster. The class
// guard proves the caller may grade the class; these prove the cell named in
// the body is one of that class's cells.
describe('scores are only saved for students of the class', () => {
  let pool, classId, assessmentId, enrolled, sameSchool, otherSchool;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'roster-teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [TEACHER_USER_ID]
    );
    const { rows: [cls] } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1) RETURNING class_id`,
      [TEACHER_USER_ID]
    );
    classId = cls.class_id;
    const { rows: [assessment] } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points)
       VALUES ($1, 'Quiz 1', 20, false, 20, 20) RETURNING assessment_id`,
      [classId]
    );
    assessmentId = assessment.assessment_id;

    const { rows: students } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES
         ('Enrolled Student', 'ALHAADIACADEMY', '5'),
         ('Same School, Other Class', 'ALHAADIACADEMY', '5'),
         ('Other School', 'PLAYGROUND', '5')
       RETURNING student_id, name`
    );
    const idOf = (name) => students.find((s) => s.name === name).student_id;
    enrolled = idOf('Enrolled Student');
    sameSchool = idOf('Same School, Other Class');
    otherSchool = idOf('Other School');
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, enrolled]);
  });

  const saveScores = (scores) =>
    authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`).send({ scores });
  const savedCells = async () =>
    (await pool.query(`SELECT student_id, score, status FROM student_assessments WHERE assessment_id = $1`, [assessmentId])).rows;

  it('saves a score for a student of the class', async () => {
    const res = await saveScores([{ studentId: enrolled, assessmentId, score: 18 }]);

    expect(res.status).toBe(200);
    expect(await savedCells()).toEqual([{ student_id: enrolled, score: '18.00', status: 'graded' }]);
  });

  it('refuses a student of the same school who is not in the class', async () => {
    const res = await saveScores([{ studentId: sameSchool, assessmentId, score: 18 }]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_NOT_IN_CLASS');
    expect(res.body.invalid[0]).toMatchObject({ studentId: sameSchool, code: 'STUDENT_NOT_IN_CLASS' });
    expect(await savedCells()).toEqual([]);
  });

  it('refuses a student of another school', async () => {
    const res = await saveScores([{ studentId: otherSchool, assessmentId, score: 18 }]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_NOT_IN_CLASS');
    expect(await savedCells()).toEqual([]);
  });

  it('writes nothing when one cell of several is for an outsider', async () => {
    const res = await saveScores([
      { studentId: enrolled, assessmentId, score: 18 },
      { studentId: sameSchool, assessmentId, score: 12 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.invalid).toHaveLength(1);
    expect(await savedCells()).toEqual([]);
  });

  it('answers 400, not 500, to an id that is not a uuid', async () => {
    const res = await saveScores([{ studentId: 'not-an-id', assessmentId, score: 18 }]);

    expect(res.status).toBe(400);
    expect(res.body.invalid[0].reason).toBe('Not a valid id');
  });

  it('refuses a status change for a student who is not in the class', async () => {
    const res = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
      .send({ studentId: sameSchool, assessmentId, status: 'excused' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('STUDENT_NOT_IN_CLASS');
    expect(await savedCells()).toEqual([]);
  });

  it('still changes the status of a student of the class', async () => {
    const res = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
      .send({ studentId: enrolled, assessmentId, status: 'missing' });

    expect(res.status).toBe(200);
    expect(await savedCells()).toEqual([{ student_id: enrolled, score: null, status: 'missing' }]);
  });

  it('does not excuse an assessment for an outsider through the legacy route', async () => {
    const res = await authenticatedRequest('post', '/api/excluded-assessments')
      .send({ studentId: otherSchool, classId, assessmentId });

    expect(res.status).toBe(404);
    expect(await savedCells()).toEqual([]);
  });
});
