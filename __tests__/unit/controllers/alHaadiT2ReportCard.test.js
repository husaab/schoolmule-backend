// Unit tests for the Al Haadi Academy Term-2 report card variant:
//   - mergeTermSubjects merge rules (A: T1-only, B: T2-only, E: ungraded term)
//   - template rendering (3-row table, em-dashes, letter vs percent convention)
//   - selection branch (Al Haadi + Term 2 → T2 path; Term 1 → legacy path)

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn(),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn(),
    }),
    close: jest.fn(),
  }),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { buildStudentRow } = require('../../helpers/factories');
const db = require('../../__mocks__/config/database');
const supabase = require('../../__mocks__/config/supabaseClient');

const { mergeTermSubjects, computeTermSubjectGrades } = require('../../../controllers/reportCard.controller');
const { getAlHaadiT2ReportCardHTML } = require('../../../templates/alHaadiT2ReportCardTemplate');
const { percentToLetterGrade } = require('../../../templates/reportCardTemplate');
const { computeClassPctForStudent } = require('../../../services/studentViewEvaluator');

const app = getApp();

// ─── mergeTermSubjects ──────────────────────────────────────────
describe('mergeTermSubjects', () => {
  it('computes final = (t1 + t2) / 2 when both terms have grades', () => {
    const rows = mergeTermSubjects(
      new Map([['Mathematics', 80]]),
      new Map([['Mathematics', 90]])
    );
    expect(rows).toEqual([{ subject: 'Mathematics', t1: 80, t2: 90, final: 85 }]);
  });

  it('rule A: T1-only subject keeps T1 but has null t2 and final', () => {
    const rows = mergeTermSubjects(
      new Map([['Physical Education', 92]]),
      new Map()
    );
    expect(rows).toEqual([
      { subject: 'Physical Education', t1: 92, t2: null, final: null },
    ]);
  });

  it('rule B: T2 subject with no T1 record has null t1 and final', () => {
    const rows = mergeTermSubjects(
      new Map(),
      new Map([['French', 75]])
    );
    expect(rows).toEqual([{ subject: 'French', t1: null, t2: 75, final: null }]);
  });

  it('rule E: a term with zero graded work (null in map) is treated as missing', () => {
    const rows = mergeTermSubjects(
      new Map([['Science', 88]]),
      new Map([['Science', null]])
    );
    expect(rows).toEqual([{ subject: 'Science', t1: 88, t2: null, final: null }]);
  });

  it('unions subjects from both terms and sorts alphabetically', () => {
    const rows = mergeTermSubjects(
      new Map([['Science', 80], ['Art', 90]]),
      new Map([['Mathematics', 70], ['Science', 60]])
    );
    expect(rows.map((r) => r.subject)).toEqual(['Art', 'Mathematics', 'Science']);
    expect(rows.find((r) => r.subject === 'Science')).toEqual({
      subject: 'Science', t1: 80, t2: 60, final: 70,
    });
  });

  it('returns an empty array for empty maps', () => {
    expect(mergeTermSubjects(new Map(), new Map())).toEqual([]);
  });
});

// ─── shared exports the variant depends on ──────────────────────
describe('shared exports', () => {
  it('percentToLetterGrade is exported and follows the rubric', () => {
    expect(percentToLetterGrade(91)).toBe('A+');
    expect(percentToLetterGrade(72)).toBe('B-');
    expect(percentToLetterGrade(40)).toBe('D-');
    expect(percentToLetterGrade(null)).toBe('-');
  });

  it('computeClassPctForStudent is exported and skips ungraded work', () => {
    const assessments = [
      { assessment_id: 'a1', weight_points: '50', max_score: '100', is_parent: false, parent_assessment_id: null },
      { assessment_id: 'a2', weight_points: '50', max_score: '100', is_parent: false, parent_assessment_id: null },
    ];
    const scores = [
      { assessment_id: 'a1', score: '80', is_excluded: false },
      { assessment_id: 'a2', score: null, is_excluded: false }, // ungraded → skipped, not zero
    ];
    expect(computeClassPctForStudent(assessments, scores)).toBe(80);
  });
});

// ─── computeTermSubjectGrades (gradebook missing-zero engine) ───
describe('computeTermSubjectGrades', () => {
  const STUDENT = 'stu-1';
  const TERM = 'term-1';

  // Build the (student, assessment) rows selectScoresForClass returns.
  const scoreRow = (over) => ({
    student_id: STUDENT,
    student_name: 'Test',
    student_grade: '4',
    homeroom_teacher_id: 'tid',
    weight_percent: null,
    is_excluded: false,
    ...over,
  });

  // Route the two queries computeTermSubjectGrades issues by SQL shape:
  // selectStudentClassesForTerm (c.term_id = $2) then selectScoresForClass.
  const mockClass = (subject, scoreRows) => {
    db.query.mockImplementation(async (sql) => {
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('c.term_id = $2')) return { rows: [{ class_id: 'c1', subject }] };
      if (q.includes('WHERE cs.class_id = $1')) return { rows: scoreRows };
      return { rows: [] };
    });
  };

  it('counts an ungraded child as zero (missing-zero, not null-skip)', async () => {
    // Parent worth 10 pts with two children (5 pts each, max 10):
    // one scored 8/10, one ungraded. Missing-zero → 40%; null-skip would be 80%.
    mockClass('Arabic', [
      scoreRow({ assessment_id: 'P', assessment_name: 'Quizzes', weight_points: '10', max_score: null, is_parent: true, parent_assessment_id: null, score: null }),
      scoreRow({ assessment_id: 'C1', assessment_name: 'Quiz 1', weight_points: '5', max_score: '10', is_parent: false, parent_assessment_id: 'P', score: '8' }),
      scoreRow({ assessment_id: 'C2', assessment_name: 'Quiz 2', weight_points: '5', max_score: '10', is_parent: false, parent_assessment_id: 'P', score: null }),
    ]);

    const result = await computeTermSubjectGrades(STUDENT, TERM);
    expect(result.get('Arabic')).toBeCloseTo(40, 5);
  });

  it('returns null ("—") when the student has no entered scores in the class', async () => {
    mockClass('French', [
      scoreRow({ assessment_id: 'A1', assessment_name: 'Test', weight_points: '100', max_score: '100', is_parent: false, parent_assessment_id: null, score: null }),
    ]);

    const result = await computeTermSubjectGrades(STUDENT, TERM);
    expect(result.get('French')).toBeNull();
  });

  it('returns an empty map when termId is null', async () => {
    expect((await computeTermSubjectGrades(STUDENT, null)).size).toBe(0);
  });
});

// ─── template rendering ─────────────────────────────────────────
describe('getAlHaadiT2ReportCardHTML', () => {
  const baseArgs = {
    schoolInfo: { name: 'Al Haadi Academy', address: '', phone: '', email: '' },
    schoolAssets: {},
    term: 'Term 2 2025-2026',
    feedbacksT1: [],
    feedbacksT2: [],
    generatedDate: '2026-06-03',
  };

  const student = (grade) => ({
    name: 'Test Student', grade, oen: '123', homeroomTeacher: 'T', daysOfAbsence: 0, school: TEST_SCHOOL,
  });

  it('renders three term rows with percentages for grades 4-8', () => {
    const html = getAlHaadiT2ReportCardHTML({
      ...baseArgs,
      student: student('5'),
      subjects: [{ subject: 'Mathematics', t1: 80.25, t2: 90.75, final: 85.5 }],
    });
    expect(html).toContain('First Term');
    expect(html).toContain('Second Term');
    expect(html).toContain('Final Term');
    expect(html).toContain('80.3%');
    expect(html).toContain('90.8%');
    expect(html).toContain('85.5%');
    expect(html).toContain('FINAL TERM REPORT CARD');
  });

  it('renders letter grades for grades 1-3', () => {
    const html = getAlHaadiT2ReportCardHTML({
      ...baseArgs,
      student: student('2'),
      subjects: [{ subject: 'Mathematics', t1: 86, t2: 78, final: 82 }],
    });
    expect(html).toContain('>A<');   // 86 → A
    expect(html).toContain('>B+<');  // 78 → B+
    expect(html).toContain('>A-<');  // 82 → A-
    expect(html).not.toContain('86.0%');
  });

  it('renders em-dashes for missing values (rules A/B/E)', () => {
    const html = getAlHaadiT2ReportCardHTML({
      ...baseArgs,
      student: student('6'),
      subjects: [{ subject: 'Physical Education', t1: 92, t2: null, final: null }],
    });
    expect(html).toContain('92.0%');
    expect((html.match(/—/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('carries work habits / behaviour per term, each on its own row', () => {
    const html = getAlHaadiT2ReportCardHTML({
      ...baseArgs,
      student: student('5'),
      subjects: [{ subject: 'Mathematics', t1: 80, t2: 90, final: 85 }],
      feedbacksT1: [{ subject: 'Mathematics', work_habits: 'S', behavior: 'N', comment: 'Slow start.' }],
      feedbacksT2: [{ subject: 'Mathematics', work_habits: 'E', behavior: 'G', comment: 'Strong term.' }],
    });
    // First Term row carries T1 feedback, Second Term row carries T2's.
    const t1Row = html.slice(html.indexOf('First Term'), html.indexOf('Second Term'));
    const t2Row = html.slice(html.indexOf('Second Term'), html.indexOf('Final Term'));
    expect(t1Row).toContain('>S<');
    expect(t1Row).toContain('>N<');
    expect(t2Row).toContain('>E<');
    expect(t2Row).toContain('>G<');
    // Comments come from T2 only.
    expect(html).toContain('Strong term.');
    expect(html).not.toContain('Slow start.');
  });

  it('shows dashes for terms with no feedback and no comment fallback', () => {
    const html = getAlHaadiT2ReportCardHTML({
      ...baseArgs,
      student: student('5'),
      subjects: [
        { subject: 'Mathematics', t1: 80, t2: 90, final: 85 },
        { subject: 'Physical Education', t1: 92, t2: null, final: null },
      ],
      feedbacksT2: [{ subject: 'Mathematics', work_habits: 'E', behavior: 'G', comment: 'Strong term.' }],
    });
    expect(html).toContain('Strong term.');
    expect(html).toContain('No comments provided'); // PE has no T2 feedback
    // Math's First Term row has no T1 feedback → dashes.
    const mathT1Row = html.slice(html.indexOf('First Term'), html.indexOf('Second Term'));
    expect(mathT1Row).toContain('>-<');
  });
});

// ─── selection branch via the bulk endpoint ─────────────────────
describe('POST /api/report-cards/generate/bulk — Al Haadi T2 branch', () => {
  const url = '/api/report-cards/generate/bulk';
  const T1_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const T2_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  // Route db.query by SQL shape instead of strict ordering — the T2 path
  // computes both terms' grades under Promise.all, so call order between
  // the two term branches is an implementation detail.
  function routeQueries({ student, termsByName }) {
    db.query.mockImplementation(async (sql, params = []) => {
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('FROM students')) return { rows: [student] };
      if (q.includes('FROM users WHERE user_id')) return { rows: [{ username: 'Teacher' }] };
      if (q.includes('FROM general_attendance')) return { rows: [{ days_absent: '0' }] };
      if (q.includes('FROM schools WHERE school_code')) return { rows: [] };
      if (q.includes('FROM school_assets')) return { rows: [] };
      if (q.includes('FROM terms') && q.includes('name = $1')) {
        return { rows: termsByName[params[0]] ? [termsByName[params[0]]] : [] };
      }
      if (q.includes('FROM terms') && q.includes("'%term 1%'")) {
        return { rows: [{ term_id: T1_ID, name: 'Term 1 2025-2026', academic_year: '2025-2026' }] };
      }
      if (q.includes('FROM terms') && q.includes('LIKE $2')) {
        return { rows: [] };
      }
      if (q.includes('c.term_id = $2')) {
        // Student's classes for one term: Math in both terms, PE only in T1.
        if (params[1] === T1_ID) {
          return { rows: [
            { class_id: 'c-math-t1', subject: 'Mathematics' },
            { class_id: 'c-pe-t1', subject: 'Physical Education' },
          ] };
        }
        return { rows: [{ class_id: 'c-math-t2', subject: 'Mathematics' }] };
      }
      if (q.includes('WHERE cs.class_id = $1')) {
        // One fully-graded assessment per class.
        const score = params[0] === 'c-math-t2' ? '90' : '80';
        return { rows: [{
          student_id: student.student_id,
          student_name: student.name,
          student_grade: String(student.grade),
          homeroom_teacher_id: 'tid',
          assessment_id: `a-${params[0]}`,
          assessment_name: 'Test',
          weight_percent: null,
          weight_points: '100',
          max_score: '100',
          is_parent: false,
          parent_assessment_id: null,
          score,
          is_excluded: false,
        }] };
      }
      if (q.includes('FROM report_card_feedback')) return { rows: [] };
      if (q.includes('INSERT INTO report_cards')) return { rows: [] };
      // Legacy path queries (no term filter)
      if (q.includes('FROM class_students cs JOIN classes c')) return { rows: [] };
      return { rows: [] };
    });
  }

  it('routes ALHAADIACADEMY + Term 2 to the T2 variant', async () => {
    const token = mockAdminUser();
    const student = buildStudentRow({ school: 'ALHAADIACADEMY', grade: 5 });
    routeQueries({
      student,
      termsByName: {
        'Term 2 2025-2026': { term_id: T2_ID, name: 'Term 2 2025-2026', academic_year: '2025-2026' },
      },
    });

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: [student.student_id], term: 'Term 2 2025-2026' });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(1);
    expect(res.body.failed).toHaveLength(0);

    // The T2 path resolves the term pair — the legacy path never queries terms.
    const termQueries = db.query.mock.calls.filter(([sql]) => sql.includes('FROM terms'));
    expect(termQueries.length).toBeGreaterThan(0);

    // PDF uploaded under the T2 term string.
    const uploadCall = supabase._mockStorage.upload.mock.calls[0];
    expect(uploadCall[0]).toContain('Term 2 2025-2026');
  });

  it('keeps ALHAADIACADEMY + Term 1 on the legacy path', async () => {
    const token = mockAdminUser();
    const student = buildStudentRow({ school: 'ALHAADIACADEMY', grade: 5 });
    routeQueries({ student, termsByName: {} });

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: [student.student_id], term: 'Term 1 2025-2026' });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(1);

    // Legacy path never resolves the term pair.
    const termQueries = db.query.mock.calls.filter(([sql]) => sql.includes('FROM terms'));
    expect(termQueries).toHaveLength(0);
  });

  it('launches a single shared browser for the whole batch', async () => {
    const puppeteer = require('puppeteer');
    const token = mockAdminUser();
    const student = buildStudentRow({ school: 'ALHAADIACADEMY', grade: 5 });
    routeQueries({
      student,
      termsByName: {
        'Term 2 2025-2026': { term_id: T2_ID, name: 'Term 2 2025-2026', academic_year: '2025-2026' },
      },
    });

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: [student.student_id, student.student_id, student.student_id], term: 'Term 2 2025-2026' });

    expect(res.status).toBe(200);
    expect(res.body.generated).toHaveLength(3);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
  });
});
