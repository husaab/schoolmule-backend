// Unit tests for the ReportData assembler (services/reportEngine/data).
// Every query goes through a fake client that answers by SQL text, so each
// test reads as "the database holds X → ReportData says Y".

jest.mock('../../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const db =require('../../../__mocks__/config/database');
const supabase = require('../../../__mocks__/config/supabaseClient');
const { assembleReportData, ReportSkip, DATA_VERSION } = require('../../../../services/reportEngine/data');
const subjects = require('../../../../services/reportEngine/data/subjects');
const { LEARNING_SKILL_NAMES } = require('../../../../services/reportEngine/data/learningSkills');

const studentQueries = require('../../../../queries/student.queries');
const schoolAssetsQueries = require('../../../../queries/schoolAssets.queries');
const termQueries = require('../../../../queries/term.queries');
const reportCardQueries = require('../../../../queries/reportCard.queries');
const progressReportsQueries = require('../../../../queries/progressReports.queries');
const alHaadiT2Queries = require('../../../../queries/alHaadiT2ReportCard.queries');
const studentViewQueries = require('../../../../queries/studentView.queries');
const jkQueries = require('../../../../queries/jk.queries');
const skQueries = require('../../../../queries/sk.queries');
const q = require('../../../../queries/reportEngineData.queries');
const kq = require('../../../../queries/kindergartenProgressReport.queries');
const { SK_PROGRESS_COMMENT_ROWS } = require('../../../../templates/kindergartenProgressComments');

const SID = '11111111-1111-4111-8111-111111111111';
const TEACHER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * A pg-like client. `routes` is a list of [sql, rows | (params) => rows];
 * the first route whose SQL is identical answers. A route function may
 * return an Error to make the query reject. Unrouted queries return [].
 */
function fakeClient(routes) {
  const query = jest.fn(async (sql, params) => {
    for (const [match, resp] of routes) {
      if (match !== sql) continue;
      const out = typeof resp === 'function' ? resp(params) : resp;
      if (out instanceof Error) throw out;
      return { rows: out, rowCount: out.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

const callsTo = (client, sql) => client.query.mock.calls.filter(([s]) => s === sql);

function studentRow(overrides = {}) {
  return {
    student_id: SID,
    name: 'Test Student A',
    school: 'PLAYGROUND',
    homeroom_teacher_id: TEACHER_ID,
    grade: '4',
    oen: '123456789',
    ...overrides,
  };
}

const schoolRow = {
  school_id: 'school-1',
  name: 'Sample Academy',
  address: '1 Test Road',
  phone: '555-0100',
  email: 'office@example.test',
  timezone: 'America/Toronto',
};

/** Routes every report needs: student, teacher, absences, school, year. */
function baseRoutes({ student = studentRow(), school = [], year = [{ label: '2026-2027' }], assets = [] } = {}) {
  return [
    [studentQueries.selectStudentById, [student]],
    [q.selectHomeroomTeacherName, [{ username: 'Teacher Sample' }]],
    [q.countDaysAbsent, [{ days_absent: '3' }]],
    [q.selectSchoolByCode, school],
    [schoolAssetsQueries.getSchoolAssetsBySchoolId, assets],
    [schoolAssetsQueries.getSchoolAssetsBySchoolCode, assets],
    [q.selectSchoolYearForDate, year],
  ];
}

// One 100-point assessment per class; `scores` maps class_id → score (null = blank).
function gradebookRoutes(scores) {
  return [
    [q.selectClassAssessments, ([classId]) => [{
      assessment_id: `a-${classId}`, name: 'Unit Test', weight_points: 100, max_score: 100, is_parent: false, parent_assessment_id: null,
    }]],
    [q.selectStudentClassScores, ([, classId]) => [{
      assessment_id: `a-${classId}`, score: scores[classId] ?? null, status: 'graded', is_excluded: false,
    }]],
  ];
}

// selectScoresForClass rows (T2 path): one assessment, this student's score.
function classScoreRows(classId, score) {
  return [{
    student_id: SID,
    assessment_id: `a-${classId}`,
    assessment_name: 'Unit Test',
    weight_percent: null,
    weight_points: 100,
    max_score: 100,
    is_parent: false,
    parent_assessment_id: null,
    score,
    status: 'graded',
  }];
}

beforeEach(() => {
  supabase._mockStorage.createSignedUrl.mockImplementation(async (path) => ({
    data: { signedUrl: `https://signed.example.test/${path}` }, error: null,
  }));
});

describe('assembleReportData — arguments', () => {
  it('rejects a missing student id, unknown doc type, empty term or bad date', async () => {
    const client = fakeClient([]);
    await expect(assembleReportData({ docType: 'report_card', term: 'Term 1', client })).rejects.toMatchObject({ name: 'ReportSkip', status: 400 });
    await expect(assembleReportData({ studentId: SID, docType: 'transcript', term: 'Term 1', client })).rejects.toMatchObject({ status: 400 });
    await expect(assembleReportData({ studentId: SID, docType: 'report_card', term: '  ', client })).rejects.toMatchObject({ status: 400 });
    await expect(assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', reportDate: '2026-13-01', client }))
      .rejects.toMatchObject({ status: 400 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('skips with 404 when the student does not exist', async () => {
    const client = fakeClient([]);
    const err = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportSkip);
    expect(err.message).toBe('Student not found');
    expect(err.status).toBe(404);
  });

  it('reads through the app database by default', async () => {
    await expect(assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1' }))
      .rejects.toMatchObject({ message: 'Student not found' });
    expect(db.query).toHaveBeenCalledWith(studentQueries.selectStudentById, [SID]);
  });
});

describe('assembleReportData — grades 1-8 report card', () => {
  function routes(extra = {}) {
    return [
      ...baseRoutes({
        assets: [{ logo_path: 'logos/sample.png', principal_signature_path: null, school_stamp_path: 'stamps/sample.png' }],
        ...extra,
      }),
      [q.selectStudentClasses, [
        { class_id: 'c-math', subject: 'Mathematics' },
        { class_id: 'c-art', subject: 'Art' },
        { class_id: 'c-math-2', subject: 'Mathematics' },
      ]],
      ...gradebookRoutes({ 'c-math': 80, 'c-math-2': 90, 'c-art': null }),
      [reportCardQueries.selectFeedback, ([, classId, term]) => {
        if (term !== 'Term 1') return [];
        if (classId === 'c-math') return [{ work_habits: 'E', behavior: 'G', comment: 'Strong term.' }];
        if (classId === 'c-math-2') return [{ work_habits: 'S', behavior: 'S', comment: 'Second class.' }];
        return [];
      }],
    ];
  }

  it('builds the whole ReportData for one subject card per subject', async () => {
    const client = fakeClient(routes());
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', reportDate: '2026-11-15', client });

    expect(data.dataVersion).toBe(DATA_VERSION);
    expect(data.meta).toEqual({
      docType: 'report_card',
      term: 'Term 1',
      termNumber: 1,
      termLabel: 'FIRST TERM',
      schoolYear: '2026 - 2027',
      reportDate: '2026-11-15',
      generatedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // No schools row: the name falls back to the code, like the legacy card.
    expect(data.school).toEqual({
      code: 'PLAYGROUND', name: 'PLAYGROUND', address: '', phone: '', email: '', website: '', principal: '', board: '',
    });
    expect(data.assets).toEqual({
      logo: 'https://signed.example.test/logos/sample.png',
      principalSignature: null,
      stamp: 'https://signed.example.test/stamps/sample.png',
      teacherSignature: null,
    });
    expect(data.student).toEqual({
      id: SID,
      name: 'Test Student A',
      firstName: 'Test',
      lastName: 'Student A',
      oen: '123456789',
      grade: '4',
      gradeLabel: 'Grade 4',
      gradeNumber: 4,
      homeroomTeacher: 'Teacher Sample',
      teacherAssistant: '',
      daysAbsent: 3,
    });
    // Sorted by name; two Mathematics classes average; no evidence → 'I';
    // the first feedback row found for a subject wins.
    expect(data.subjects).toEqual([
      { id: 'Art', name: 'Art', teacher: '', mark: 'I', workHabits: '', behaviour: '', coreStandards: '', comment: '', terms: {} },
      { id: 'Mathematics', name: 'Mathematics', teacher: '', mark: 85, workHabits: 'E', behaviour: 'G', coreStandards: '', comment: 'Strong term.', terms: {} },
    ]);
    expect(data.skills).toEqual([]);
    expect(data.comments).toEqual([]);
    expect(data.learningSkills).toEqual([]);
    expect(data.extra).toEqual({});

    // Assets by school code (no schools row), the year by the report date.
    expect(callsTo(client, schoolAssetsQueries.getSchoolAssetsBySchoolCode)[0][1]).toEqual(['PLAYGROUND']);
    expect(callsTo(client, q.selectSchoolYearForDate)[0][1]).toEqual(['PLAYGROUND', '2026-11-15']);
  });

  it('falls back like the legacy card: N/A teacher, 0 absences, September year rule', async () => {
    const client = fakeClient([
      [q.selectHomeroomTeacherName, []],
      [q.countDaysAbsent, () => new Error('attendance down')],
      [q.selectSchoolByCode, () => new Error('no schools table')],
      [q.selectSchoolYearForDate, []],
      ...routes(),
    ]);
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', reportDate: '2027-03-01', client });
    expect(data.student.homeroomTeacher).toBe('N/A');
    expect(data.student.daysAbsent).toBe(0);
    expect(data.school.name).toBe('PLAYGROUND');
    expect(data.meta.schoolYear).toBe('2026 - 2027');
  });

  it('uses the schools row, its assets by id, and today in its timezone', async () => {
    const client = fakeClient(routes({
      school: [{ ...schoolRow, phone: null, timezone: 'Pacific/Auckland' }],
      student: studentRow({ oen: null }),
    }));
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client });
    expect(data.school).toMatchObject({ name: 'Sample Academy', address: '1 Test Road', phone: '', email: 'office@example.test' });
    // The website is the contact email's domain (as the JK/SK progress footers print it).
    expect(data.school.website).toBe('www.example.test');
    expect(data.student.oen).toBe('');
    expect(callsTo(client, schoolAssetsQueries.getSchoolAssetsBySchoolId)[0][1]).toEqual(['school-1']);
    const auckland = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(data.meta.reportDate).toBe(auckland);
  });

  it('gives null assets when the signed-URL call or the asset read fails', async () => {
    supabase._mockStorage.createSignedUrl.mockResolvedValue({ data: null, error: { message: 'nope' } });
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client: fakeClient(routes()) });
    expect(data.assets).toEqual({ logo: null, principalSignature: null, stamp: null, teacherSignature: null });

    const failing = fakeClient([[schoolAssetsQueries.getSchoolAssetsBySchoolCode, () => new Error('no table')], ...routes()]);
    const data2 = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client: failing });
    expect(data2.assets.logo).toBeNull();
  });

  it('prints no website for a free-mail contact address', async () => {
    const client = fakeClient(routes({ school: [{ ...schoolRow, email: 'sampleacademy@gmail.com' }] }));
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client });
    expect(data.school.website).toBe('');
  });

  it('prints the principal and board from School Settings', async () => {
    const client = fakeClient(routes({ school: [{ ...schoolRow, principal_name: 'Principal Sample', board_name: 'Private' }] }));
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client });
    expect(data.school.principal).toBe('Principal Sample');
    expect(data.school.board).toBe('Private');
    const unset = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client: fakeClient(routes({ school: [schoolRow] })) });
    expect([unset.school.principal, unset.school.board]).toEqual(['', '']);
  });

  it('has no subjects for a student in no classes', async () => {
    const client = fakeClient([[q.selectStudentClasses, []], ...routes()]);
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client });
    expect(data.subjects).toEqual([]);
  });
});

describe('assembleReportData — Al Haadi Term 2 three-row card', () => {
  const T1 = { term_id: 'term-1', name: 'Term 1', academic_year: '2025-2026' };
  const T2 = { term_id: 'term-2', name: 'Term 2', academic_year: '2025-2026' };

  function routes() {
    return [
      ...baseRoutes({ student: studentRow({ school: 'ALHAADIACADEMY', grade: '2' }), school: [schoolRow] }),
      [alHaadiT2Queries.selectTermByNameAndSchool, ([name]) => (name === 'Term 2' ? [T2] : [])],
      [alHaadiT2Queries.selectTerm1ForAcademicYear, [T1]],
      [alHaadiT2Queries.selectStudentClassesForTerm, ([, termId]) => (termId === 'term-1'
        ? [{ class_id: 'math-1', subject: 'Mathematics' }, { class_id: 'pe-1', subject: 'Physical Education' }]
        : [{ class_id: 'math-2', subject: 'Mathematics' }, { class_id: 'fr-2', subject: 'French' }, { class_id: 'sci-2', subject: 'Science' }])],
      [studentViewQueries.selectScoresForClass, ([classId]) => classScoreRows(classId, {
        'math-1': 80, 'math-2': 90, 'pe-1': 70, 'fr-2': 60, 'sci-2': null,
      }[classId])],
      [reportCardQueries.selectFeedback, ([, classId, term]) => {
        if (classId === 'math-1' && term === 'Term 1') return [{ work_habits: 'S', behavior: 'N', comment: 'T1 note.' }];
        if (classId === 'math-2' && term === 'Term 2') return [{ work_habits: 'E', behavior: 'G', comment: 'T2 note.' }];
        return [];
      }],
    ];
  }

  it('fills First / Second / Final Term per subject, mark = Term 2', async () => {
    const client = fakeClient(routes());
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 2', reportDate: '2026-06-20', client });

    const byName = Object.fromEntries(data.subjects.map((s) => [s.name, s]));
    expect(data.subjects.map((s) => s.name)).toEqual(['French', 'Mathematics', 'Physical Education', 'Science']);

    expect(byName.Mathematics).toEqual({
      id: 'Mathematics',
      name: 'Mathematics',
      teacher: '',
      mark: 90,
      workHabits: 'E',
      behaviour: 'G',
      coreStandards: '',
      comment: 'T2 note.',
      terms: {
        t1: { mark: 80, workHabits: 'S', behaviour: 'N', comment: 'T1 note.' },
        t2: { mark: 90, workHabits: 'E', behaviour: 'G', comment: 'T2 note.' },
        final: { mark: 85, workHabits: '', behaviour: '', comment: '' },
      },
    });
    // Rule A: T1-only subject → no T2 mark, no final.
    expect(byName['Physical Education'].mark).toBeNull();
    expect(byName['Physical Education'].terms.t1.mark).toBe(70);
    expect(byName['Physical Education'].terms.final.mark).toBeNull();
    // Rule B: T2-only subject → no T1 mark, no final.
    expect(byName.French.terms.t1.mark).toBeNull();
    expect(byName.French.mark).toBe(60);
    expect(byName.French.terms.final.mark).toBeNull();
    // Rule E: enrolled with no evidence → 'I'.
    expect(byName.Science.mark).toBe('I');

    // T1 feedback is read under the T1 term's own name.
    const fbTerms = callsTo(client, reportCardQueries.selectFeedback).map(([, p]) => `${p[1]}@${p[2]}`);
    expect(fbTerms).toEqual(expect.arrayContaining(['math-1@Term 1', 'math-2@Term 2']));
    expect(data.meta.termLabel).toBe('SECOND TERM');
  });

  it('is only used for Al Haadi Academy', async () => {
    const client = fakeClient([
      [studentQueries.selectStudentById, [studentRow({ school: 'PLAYGROUND' })]],
      [q.selectStudentClasses, []],
      ...routes(),
    ]);
    await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 2', client });
    expect(callsTo(client, alHaadiT2Queries.selectTermByNameAndSchool)).toHaveLength(0);
    expect(callsTo(client, q.selectStudentClasses).length).toBeGreaterThan(0);
  });
});

describe('Al Haadi term pair + merge rules', () => {
  it('falls back to LIKE lookups when the exact names miss', async () => {
    const client = fakeClient([
      [alHaadiT2Queries.selectTermByNameAndSchool, []],
      [alHaadiT2Queries.selectTermLike, ([, pattern]) => (pattern === '%term 2%'
        ? [{ term_id: 'b', name: 'Term 2 2025-2026', academic_year: null }]
        : [{ term_id: 'a', name: 'Term 1 2025-2026', academic_year: null }])],
      [alHaadiT2Queries.selectTerm1ForAcademicYear, []],
    ]);
    const pair = await subjects.resolveAlHaadiTermPair(client, 'ALHAADIACADEMY', 'Term 2 (Winter)');
    expect(pair.t2.term_id).toBe('b');
    expect(pair.t1.term_id).toBe('a');
  });

  it('merges like the legacy controller', () => {
    const rows = subjects.mergeTermSubjects(
      new Map([['Math', 80], ['Gym', 70], ['Art', null]]),
      new Map([['Math', 90], ['French', 60], ['Art', 75]]),
    );
    expect(rows).toEqual([
      { subject: 'Art', t1: 'I', t2: 75, final: 'I' },
      { subject: 'French', t1: null, t2: 60, final: null },
      { subject: 'Gym', t1: 70, t2: null, final: null },
      { subject: 'Math', t1: 80, t2: 90, final: 85 },
    ]);
  });

  it('has no grades for a term that was not found', async () => {
    const client = fakeClient([]);
    expect(await subjects.computeTermSubjectGrades(client, SID, null)).toEqual(new Map());
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('assembleReportData — grades 1-8 progress report', () => {
  function routes() {
    return [
      ...baseRoutes({ student: studentRow({ grade: '6' }), school: [schoolRow] }),
      [termQueries.selectTermByNameAndSchool, ([name]) => (name === 'Term 1' ? [{ term_id: 'term-1' }] : [])],
      [q.selectStudentClassesForProgressTerm, ([, termId]) => (termId === 'term-1' ? [
        { class_id: 'c-eng', subject: 'English', teacher_name: 'Teacher Sample', class_grade: '6' },
        { class_id: 'c-sci', subject: 'Science', teacher_name: null, class_grade: '6' },
      ] : [])],
      [progressReportsQueries.getProgressReportFeedback, ([, classId]) => (classId === 'c-eng'
        ? [{ core_standards: 'Meets most', work_habit: 'G', behavior: 'E', comment: 'Reads daily.' }]
        : [])],
    ];
  }

  it('builds one row per class in the term with its progress feedback', async () => {
    const data = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 1', client: fakeClient(routes()) });
    expect(data.meta.docType).toBe('progress_report');
    expect(data.subjects).toEqual([
      { id: 'c-eng', name: 'English', teacher: 'Teacher Sample', mark: null, workHabits: 'G', behaviour: 'E', coreStandards: 'Meets most', comment: 'Reads daily.', terms: {} },
      { id: 'c-sci', name: 'Science', teacher: '', mark: null, workHabits: '', behaviour: '', coreStandards: '', comment: '', terms: {} },
    ]);
    expect(data.skills).toEqual([]);
    expect(data.comments).toEqual([]);
  });

  it('skips when the term does not exist for the school', async () => {
    const err = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 9', client: fakeClient(routes()) }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportSkip);
    expect(err.message).toBe('Term "Term 9" not found for school');
    expect(err.status).toBe(422);
  });

  it('skips when the student has no classes in the term', async () => {
    const client = fakeClient([[q.selectStudentClassesForProgressTerm, []], ...routes()]);
    const err = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 1', client }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportSkip);
    expect(err.message).toBe('Student not enrolled in any classes for Term 1');
    expect(err.status).toBe(422);
  });
});

/**
 * What the JK/SK progress context reads (services/kindergartenProgressReport):
 * the year the report date falls in, that year's absences, the homeroom
 * teacher else the grade's Kindergarten class teacher.
 */
const KG_YEAR = { school_year_id: 'year-1', label: '2025-2026', start_date: '2025-09-02', end_date: '2026-06-26' };
function progressContextRoutes({ year = [KG_YEAR], days = 2, homeroom = [{ username: 'Homeroom Teacher' }], classTeacher = [] } = {}) {
  return [
    [kq.selectSchoolYearForDate, year],
    [kq.countDaysAbsent, [{ days }]],
    [kq.selectHomeroomTeacherName, homeroom],
    [kq.selectKindergartenClassTeacherName, classTeacher],
  ];
}

describe('assembleReportData — JK', () => {
  const jkStudent = studentRow({ grade: 'JK', school: 'ALHAADIACADEMY', name: 'Sample Kid' });

  function routes(docType) {
    return [
      ...progressContextRoutes(),
      ...baseRoutes({ student: jkStudent, school: [schoolRow] }),
      [jkQueries.getTeacherAssistant, ([, term]) => (term === 'Term 1' ? [{ teacher_assistant_name: 'Assistant Sample' }] : [])],
      [jkQueries.getSkillDomainsByDocumentType, ([dt]) => (dt === docType ? [
        { domain_id: 'd1', document_type: dt, domain_name: 'Belonging', domain_sort_order: 1, skill_id: 's1', skill_name: 'Shares', skill_description: 'Shares toys', skill_sort_order: 1 },
        { domain_id: 'd1', document_type: dt, domain_name: 'Belonging', domain_sort_order: 1, skill_id: 's2', skill_name: 'Waits', skill_description: null, skill_sort_order: 2 },
        { domain_id: 'd2', document_type: dt, domain_name: 'Empty Domain', domain_sort_order: 2, skill_id: null, skill_name: null, skill_description: null, skill_sort_order: null },
      ] : [])],
      [jkQueries.getSkillAssessmentsForStudent, ([, term, dt]) => {
        if (dt !== docType) return [];
        if (term === 'Term 1') return [{ skill_id: 's1', rating: 'D' }];
        if (term === 'Term 2') return [{ skill_id: 's1', rating: 'B' }, { skill_id: 's2', rating: 'I' }];
        return [];
      }],
      [jkQueries.getDomainCommentsForStudent, ([, term]) => (term === 'Term 1' ? [{ domain_id: 'd1', comment: 'Plays well with others.' }] : [])],
      [jkQueries.getProgressReportCommentsForStudent, ([, term]) => (term === 'Term 1' ? [
        { section_type: 'academic_achievement', comment: 'Counts to 20.' },
        { section_type: 'socio_emotional', comment: null },
      ] : [])],
      [jkQueries.getLearningSkillsForStudent, ([, term]) => {
        if (term === 'Term 1') return [{ skill_name: 'Responsibility', rating: 'S' }, { skill_name: 'Initiative', rating: 'G' }];
        if (term === 'Term 2') return [{ skill_name: 'Responsibility', rating: 'E' }];
        return [];
      }],
    ];
  }

  it('progress report: domains → skills with this term, T1 and T2 ratings, and the Teacher\'s Comments rows', async () => {
    const client = fakeClient(routes('progress_report'));
    const data = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 1', reportDate: '2026-03-02', client });

    expect(data.student).toMatchObject({ grade: 'JK', gradeLabel: 'Junior Kindergarten', gradeNumber: -1, teacherAssistant: 'Assistant Sample', firstName: 'Sample', lastName: 'Kid' });
    // The progress context: that year's absences, homeroom teacher, the year the date falls in.
    expect(data.student).toMatchObject({ homeroomTeacher: 'Homeroom Teacher', daysAbsent: 2 });
    expect(data.meta).toMatchObject({ reportDate: '2026-03-02', schoolYear: '2025 - 2026' });
    expect(callsTo(client, kq.countDaysAbsent)[0][1]).toEqual([SID, '2025-09-02', '2026-03-02']);
    // …not the report cards' all-time count, 'N/A' teacher or active-year rule.
    expect(callsTo(client, q.countDaysAbsent)).toHaveLength(0);
    expect(callsTo(client, q.selectHomeroomTeacherName)).toHaveLength(0);
    expect(callsTo(client, q.selectSchoolYearForDate)).toHaveLength(0);
    expect(data.subjects).toEqual([]);
    expect(data.skills).toEqual([
      {
        id: 'd1',
        name: 'Belonging',
        comment: 'Plays well with others.',
        items: [
          { id: 's1', name: 'Shares', description: 'Shares toys', rating: 'D', t1: 'D', t2: 'B' },
          { id: 's2', name: 'Waits', description: '', rating: '', t1: '', t2: 'I' },
        ],
      },
      { id: 'd2', name: 'Empty Domain', comment: '', items: [] },
    ]);
    expect(data.comments).toEqual([
      { key: 'academic_achievement', label: 'Academic achievement', caption: '', text: 'Counts to 20.' },
      { key: 'socio_emotional', label: 'Socio-emotional development', caption: '', text: '' },
    ]);
    expect(data.learningSkills).toEqual([]);
    // 'Term 1' is both the report term and T1: read once.
    expect(callsTo(client, jkQueries.getSkillAssessmentsForStudent).map(([, p]) => p[1])).toEqual(['Term 1', 'Term 2']);
    // The 1-8 subject queries never run for kindergarten.
    expect(callsTo(client, q.selectStudentClasses)).toHaveLength(0);
  });

  it('progress report: no homeroom → the Kindergarten class teacher; no school year → none printed', async () => {
    const client = fakeClient([
      ...progressContextRoutes({ year: [], days: 5, homeroom: [], classTeacher: [{ teacher_name: 'Class Teacher' }] }),
      ...routes('progress_report'),
    ]);
    const data = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 1', reportDate: '2026-03-02', client });
    expect(data.student).toMatchObject({ homeroomTeacher: 'Class Teacher', daysAbsent: 5 });
    expect(data.meta.schoolYear).toBe('');
    // Every absence up to the date when there's no school year.
    expect(callsTo(client, kq.countDaysAbsent)[0][1]).toEqual([SID, null, '2026-03-02']);
    expect(callsTo(client, kq.selectKindergartenClassTeacherName)[0][1]).toEqual([SID, 'JK', null, 'ALHAADIACADEMY']);
  });

  it('report card: the six learning skills in legacy order, no free comments', async () => {
    const client = fakeClient(routes('report_card'));
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 2', client });

    // The report card keeps the legacy card's teacher, absences and year.
    expect(data.student).toMatchObject({ homeroomTeacher: 'Teacher Sample', daysAbsent: 3 });
    expect(data.meta.schoolYear).toBe('2026 - 2027');
    expect(callsTo(client, kq.countDaysAbsent)).toHaveLength(0);
    expect(data.student.teacherAssistant).toBe('');
    expect(data.skills[0].items[0]).toEqual({ id: 's1', name: 'Shares', description: 'Shares toys', rating: 'B', t1: 'D', t2: 'B' });
    // Domain comments are read for the report's own term.
    expect(data.skills[0].comment).toBe('');
    expect(data.comments).toEqual([]);
    expect(data.learningSkills.map((s) => s.name)).toEqual(LEARNING_SKILL_NAMES);
    expect(data.learningSkills[0]).toEqual({
      name: 'Responsibility',
      descriptors: [
        'Fulfils responsibilities and commitments within the learning environment',
        'Completes and submits class work, homework, and assignments according to agreed-upon timelines.',
      ],
      rating: 'E',
      t1: 'S',
      t2: 'E',
    });
    expect(data.learningSkills.find((s) => s.name === 'Initiative')).toMatchObject({ rating: '', t1: 'G', t2: '' });
    expect(data.learningSkills.every((s) => s.descriptors.length >= 2)).toBe(true);
  });
});

describe('assembleReportData — SK', () => {
  const skStudent = studentRow({ grade: 'SK', school: 'ALHAADIACADEMY' });

  function routes(docType) {
    return [
      ...progressContextRoutes(),
      ...baseRoutes({ student: skStudent, school: [schoolRow] }),
      [skQueries.getTeacherAssistant, [{ teacher_assistant_name: null }]],
      [skQueries.getSubjectsByDocumentType, ([dt]) => (dt === docType ? [
        { subject_id: 'sub-lit', document_type: dt, subject_name: 'Literacy - Reading', subject_sort_order: 1, standard_id: 'st-1', standard_name: 'Knows letters', standard_description: 'Upper and lower case', standard_sort_order: 1 },
        { subject_id: 'sub-math', document_type: dt, subject_name: 'Mathematics', subject_sort_order: 2, standard_id: 'st-2', standard_name: 'Counts', standard_description: null, standard_sort_order: 1 },
      ] : [])],
      [skQueries.getStandardAssessmentsForStudent, ([, term, dt]) => {
        if (dt !== docType) return [];
        if (term === 'Term 1') return [{ standard_id: 'st-1', rating: 'P' }];
        if (term === 'Term 2') return [{ standard_id: 'st-1', rating: 'E' }, { standard_id: 'st-2', rating: 'DV' }];
        return [];
      }],
      [skQueries.getSubjectCommentsForStudent, ([, term]) => (term === 'Term 2' ? [{ subject_id: 'sub-math', comment: 'Counts past 50.' }] : [])],
      [skQueries.getProgressReportCommentsForStudent, [
        { section_type: 'language_arts', comment: ' Enjoys stories. ' },
        { section_type: 'french', comment: 'Says bonjour.' },
        { section_type: 'academic_achievement', comment: 'An old section with no row on paper.' },
      ]],
    ];
  }

  it('progress report: subjects → standards, subject comments, the nine Strengths/Next Steps rows', async () => {
    const data = await assembleReportData({ studentId: SID, docType: 'progress_report', term: 'Term 2', client: fakeClient(routes('progress_report')) });
    expect(data.student).toMatchObject({ grade: 'SK', gradeLabel: 'Senior Kindergarten', gradeNumber: 0, teacherAssistant: '' });
    expect(data.student).toMatchObject({ homeroomTeacher: 'Homeroom Teacher', daysAbsent: 2 });
    expect(data.skills).toEqual([
      { id: 'sub-lit', name: 'Literacy - Reading', comment: '', items: [{ id: 'st-1', name: 'Knows letters', description: 'Upper and lower case', rating: 'E', t1: 'P', t2: 'E' }] },
      { id: 'sub-math', name: 'Mathematics', comment: 'Counts past 50.', items: [{ id: 'st-2', name: 'Counts', description: '', rating: 'DV', t1: '', t2: 'DV' }] },
    ]);
    // Every row, in print order, trimmed; a section with no row is left out.
    expect(data.comments).toEqual(SK_PROGRESS_COMMENT_ROWS.map((row) => ({
      key: row.key,
      label: row.label,
      caption: row.caption || '',
      text: { language_arts: 'Enjoys stories.', french: 'Says bonjour.' }[row.key] || '',
    })));
    expect(data.comments[0].caption).toBe('Reading, Writing, Oral communication, Media Literacy');
    expect(data.learningSkills).toEqual([]);
  });

  it('report card: the same structure for the report_card document, no learning skills', async () => {
    const data = await assembleReportData({ studentId: SID, docType: 'report_card', term: 'Term 1', client: fakeClient(routes('report_card')) });
    expect(data.skills[0].items[0]).toMatchObject({ rating: 'P', t1: 'P', t2: 'E' });
    expect(data.skills[1].comment).toBe('');
    expect(data.comments).toEqual([]);
    expect(data.learningSkills).toEqual([]);
  });
});
