// Integration tests for the Al Haadi Academy Term-2 report card variant.
//
// Seeds a real Postgres with two terms in the same academic year, a grade-4
// student with:
//   - Mathematics in BOTH terms  → all three rows filled, final = (t1+t2)/2
//   - Physical Education T1-only → rule A (T1 filled, T2/final missing)
//   - French T2-only             → rule B (T2 filled, T1/final missing)
// then drives POST /api/report-cards/generate/bulk and inspects the rendered
// HTML (captured via the puppeteer mock) plus the report_cards upsert.

const capturedHTML = [];

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockImplementation(async (html) => {
        capturedHTML.push(html);
      }),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn().mockResolvedValue(undefined),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

const T1_NAME = 'Term 1 2025-2026';
const T2_NAME = 'Term 2 2025-2026';

describe('Integration: Al Haadi T2 report card generation', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    capturedHTML.length = 0;
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN', true, true)`,
      [TEST_USER_ID]
    );
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [TEACHER_USER_ID]
    );
  });

  /** Seed one class with a single 100-point assessment and an optional score. */
  async function seedClassWithScore({ termId, termName, subject, studentId, score }) {
    const { rows: classRows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 4, $1, 'Teacher One', $2, $3, $4) RETURNING class_id`,
      [subject, TEACHER_USER_ID, termId, termName]
    );
    const classId = classRows[0].class_id;

    await pool.query(
      `INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`,
      [classId, studentId]
    );

    const { rows: aRows } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_points, max_score, is_parent)
       VALUES ($1, 'Final Exam', 100, 100, false) RETURNING assessment_id`,
      [classId]
    );

    if (score != null) {
      await pool.query(
        `INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)`,
        [studentId, aRows[0].assessment_id, score]
      );
    }
    return classId;
  }

  async function seedScenario() {
    const { rows: t1Rows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', $1, '2025-09-01', '2026-01-31', '2025-2026', false) RETURNING term_id`,
      [T1_NAME]
    );
    const { rows: t2Rows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', $1, '2026-02-01', '2026-06-30', '2025-2026', true) RETURNING term_id`,
      [T2_NAME]
    );
    const t1 = t1Rows[0].term_id;
    const t2 = t2Rows[0].term_id;

    const { rows: studentRows } = await pool.query(
      `INSERT INTO students (name, school, grade, homeroom_teacher_id)
       VALUES ('Terry Twoterm', 'ALHAADIACADEMY', '4', $1) RETURNING student_id`,
      [TEACHER_USER_ID]
    );
    const studentId = studentRows[0].student_id;

    // Mathematics in both terms: 80% in T1, 90% in T2 → final 85.0%
    const mathT1ClassId = await seedClassWithScore({ termId: t1, termName: T1_NAME, subject: 'Mathematics', studentId, score: 80 });
    const mathT2ClassId = await seedClassWithScore({ termId: t2, termName: T2_NAME, subject: 'Mathematics', studentId, score: 90 });
    // Physical Education: T1 only (rule A), 92%
    await seedClassWithScore({ termId: t1, termName: T1_NAME, subject: 'Physical Education', studentId, score: 92 });
    // French: T2 only (rule B), 75%
    await seedClassWithScore({ termId: t2, termName: T2_NAME, subject: 'French', studentId, score: 75 });

    return { studentId, mathT1ClassId, mathT2ClassId };
  }

  it('generates the three-row T2 report card with rules A and B applied', async () => {
    const { studentId, mathT1ClassId, mathT2ClassId } = await seedScenario();

    // Feedback in both terms — each should land on its own row.
    await pool.query(
      `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment)
       VALUES ($1, $2, $3, 'S', 'N', 'Slow start in T1.')`,
      [studentId, mathT1ClassId, T1_NAME]
    );
    await pool.query(
      `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment)
       VALUES ($1, $2, $3, 'E', 'G', 'Excellent progress in T2.')`,
      [studentId, mathT2ClassId, T2_NAME]
    );

    const res = await authenticatedRequest('post', '/api/report-cards/generate/bulk')
      .send({ studentIds: [studentId], term: T2_NAME });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(1);
    expect(res.body.failed).toHaveLength(0);

    // The rendered HTML is the T2 variant…
    expect(capturedHTML).toHaveLength(1);
    const html = capturedHTML[0];
    expect(html).toContain('FINAL TERM REPORT CARD');
    expect(html).toContain('First Term');
    expect(html).toContain('Second Term');
    expect(html).toContain('Final Term');

    // …with gradebook-matching numbers (grade 4 → percentages, 1 decimal):
    expect(html).toContain('80.0%'); // Math T1
    expect(html).toContain('90.0%'); // Math T2
    expect(html).toContain('85.0%'); // Math final = (80+90)/2
    expect(html).toContain('92.0%'); // PE T1 (rule A: kept)
    expect(html).toContain('75.0%'); // French T2 (rule B: kept)
    expect(html).toContain('—');     // missing cells render em-dash
    expect(html).toContain('Excellent progress in T2.'); // comments come from T2
    expect(html).not.toContain('Slow start in T1.');     // …never from T1

    // Work habits / behaviour carry forward per term in the Math card:
    // First Term row has T1's S/N, Second Term row has T2's E/G.
    const mathCard = html.slice(html.indexOf('>Mathematics<'), html.indexOf('>Physical Education<'));
    const mathT1Row = mathCard.slice(mathCard.indexOf('First Term'), mathCard.indexOf('Second Term'));
    const mathT2Row = mathCard.slice(mathCard.indexOf('Second Term'), mathCard.indexOf('Final Term'));
    expect(mathT1Row).toContain('>S<');
    expect(mathT1Row).toContain('>N<');
    expect(mathT2Row).toContain('>E<');
    expect(mathT2Row).toContain('>G<');

    // Subjects are sorted: French, Mathematics, Physical Education.
    const order = ['French', 'Mathematics', 'Physical Education'].map((s) => html.indexOf(`>${s}<`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);

    // report_cards row upserted under the T2 term string.
    const { rows } = await pool.query(
      `SELECT term, file_path, grade FROM report_cards WHERE student_id = $1`,
      [studentId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].term).toBe(T2_NAME);
    expect(rows[0].file_path).toContain('ALHAADIACADEMY/');
  });

  it('keeps Term 1 generation on the legacy single-row template', async () => {
    const { studentId } = await seedScenario();

    const res = await authenticatedRequest('post', '/api/report-cards/generate/bulk')
      .send({ studentIds: [studentId], term: T1_NAME });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(1);

    expect(capturedHTML).toHaveLength(1);
    const html = capturedHTML[0];
    expect(html).not.toContain('FINAL TERM REPORT CARD');
    expect(html).not.toContain('Final Term');
  });

  it('treats a T2 class with zero graded work as missing (rule E)', async () => {
    const { rows: t1Rows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', $1, '2025-09-01', '2026-01-31', '2025-2026', false) RETURNING term_id`,
      [T1_NAME]
    );
    const { rows: t2Rows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', $1, '2026-02-01', '2026-06-30', '2025-2026', true) RETURNING term_id`,
      [T2_NAME]
    );
    const { rows: studentRows } = await pool.query(
      `INSERT INTO students (name, school, grade, homeroom_teacher_id)
       VALUES ('Una Ungraded', 'ALHAADIACADEMY', '4', $1) RETURNING student_id`,
      [TEACHER_USER_ID]
    );
    const studentId = studentRows[0].student_id;

    // Science graded in T1 (88) but completely ungraded in T2 (score null).
    await seedClassWithScore({ termId: t1Rows[0].term_id, termName: T1_NAME, subject: 'Science', studentId, score: 88 });
    await seedClassWithScore({ termId: t2Rows[0].term_id, termName: T2_NAME, subject: 'Science', studentId, score: null });

    const res = await authenticatedRequest('post', '/api/report-cards/generate/bulk')
      .send({ studentIds: [studentId], term: T2_NAME });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(1);

    const html = capturedHTML[0];
    expect(html).toContain('88.0%'); // T1 row kept
    // T2 and Final rows are em-dashes; final must NOT average 88 with 0.
    expect(html).not.toContain('44.0%');
    expect((html.match(/—/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
