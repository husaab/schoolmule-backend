// Parity: the ReportData assembler (services/reportEngine/data) against the
// seven legacy generators, on a real Postgres.
//
// For each path the test seeds a small synthetic fixture, runs the LEGACY
// generator with Puppeteer and storage mocked, captures the exact object the
// legacy template function received, then assembles ReportData for the same
// student and term and checks every value the template gets is the same.
//
//   1. grades 1-8 report card        reportCard.controller generateReportCard
//   2. Al Haadi Term 2 report card   (same handler, ALHAADIACADEMY + "Term 2")
//   3. grades 1-8 progress report    progressReports.controller generateProgressReport
//   4. JK progress report            jk.controller generateSingleJKProgressReport
//   5. SK progress report            sk.controller generateSingleSKProgressReport
//      (both print a report date, its school year, that year's absences, the
//      homeroom-else-Kindergarten-class teacher and the comment rows)
//   6. JK report card                jk.controller generateSingleJKReportCard
//   7. SK report card                sk.controller generateSingleSKReportCard

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn().mockResolvedValue(undefined),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Each legacy template still renders (the HTML is checked too), but the call
// is recorded so the test sees exactly what the controller passed in.
function mockSpyTemplate(path, fnName) {
  const actual = jest.requireActual(path);
  return { ...actual, [fnName]: jest.fn((args) => actual[fnName](args)) };
}
jest.mock('../../../templates/reportCardTemplate', () => mockSpyTemplate('../../../templates/reportCardTemplate', 'getReportCardHTML'));
jest.mock('../../../templates/alHaadiT2ReportCardTemplate', () => mockSpyTemplate('../../../templates/alHaadiT2ReportCardTemplate', 'getAlHaadiT2ReportCardHTML'));
jest.mock('../../../templates/progressReportTemplate', () => mockSpyTemplate('../../../templates/progressReportTemplate', 'getProgressReportHTML'));
jest.mock('../../../templates/alHaadiProgressReportJKTemplate', () => mockSpyTemplate('../../../templates/alHaadiProgressReportJKTemplate', 'renderAlHaadiProgressReportJK'));
jest.mock('../../../templates/alHaadiReportCardJKTemplate', () => mockSpyTemplate('../../../templates/alHaadiReportCardJKTemplate', 'getAlHaadiReportCardJKHTML'));
jest.mock('../../../templates/alHaadiProgressReportSKTemplate', () => mockSpyTemplate('../../../templates/alHaadiProgressReportSKTemplate', 'renderAlHaadiProgressReportSK'));

// Only the template input matters here; the JK/SK progress reports' header/
// footer and first-page printing (pdf-lib) never runs.
jest.mock('../../../utils/pdfGenerator', () => ({
  createPDFBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
  launchPDFBrowser: jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) }),
}));

// The JK/SK progress generators inline the logo/signature/stamp by fetching
// their signed URL; here the "data URI" names the URL it came from.
jest.mock('../../../templates/printKit', () => {
  const actual = jest.requireActual('../../../templates/printKit');
  return { ...actual, fetchImageDataUri: jest.fn(async (url) => (url ? `data:inlined;${url}` : null)) };
});
jest.mock('../../../templates/alHaadiReportCardSKTemplate', () => mockSpyTemplate('../../../templates/alHaadiReportCardSKTemplate', 'getAlHaadiReportCardSKHTML'));

const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const reportCardTemplate = require('../../../templates/reportCardTemplate');
const alHaadiT2Template = require('../../../templates/alHaadiT2ReportCardTemplate');
const progressTemplate = require('../../../templates/progressReportTemplate');
const jkProgressTemplate = require('../../../templates/alHaadiProgressReportJKTemplate');
const jkReportCardTemplate = require('../../../templates/alHaadiReportCardJKTemplate');
const skProgressTemplate = require('../../../templates/alHaadiProgressReportSKTemplate');
const skReportCardTemplate = require('../../../templates/alHaadiReportCardSKTemplate');
const reportCardController = require('../../../controllers/reportCard.controller');
const progressReportsController = require('../../../controllers/progressReports.controller');
const jkController = require('../../../controllers/jk.controller');
const skController = require('../../../controllers/sk.controller');
const { assembleReportData, ReportSkip } = require('../../../services/reportEngine/data');
const { formatSchoolYearLabel } = require('../../../services/reportEngine/data/format');
const { schoolWebsite, escapeHtml } = require('../../../templates/printKit');
const { JK_PROGRESS_COMMENT_ROWS, SK_PROGRESS_COMMENT_ROWS } = require('../../../templates/kindergartenProgressComments');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_ID = '7a1f0c2e-1d3b-4c5a-9e8f-000000000001';
const T1 = 'Term 1';
const T2 = 'Term 2';
const DAY_MS = 24 * 60 * 60 * 1000;

let pool;
let termIds;

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

/** The single call a template spy received, and the HTML it rendered. */
function lastCall(fn) {
  expect(fn).toHaveBeenCalledTimes(1);
  return { args: fn.mock.calls[0][0], html: fn.mock.results[0].value };
}

// ─────────────────────────────────────────────────────────── fixtures ──

async function seedSchool() {
  await pool.query(
    `UPDATE schools SET address = '1 Sample Road, Testville', phone = '555-0100', email = 'office@example.test', timezone = 'America/Toronto'
     WHERE school_code = $1`,
    [SCHOOL],
  );
  // Logo + signature, no stamp: exercises both a signed URL and a null.
  await pool.query(
    `INSERT INTO school_assets (school_id, school_code, logo_path, principal_signature_path, school_stamp_path)
     SELECT school_id, school_code, 'logos/sample-logo.png', 'signatures/sample-principal.png', NULL
     FROM schools WHERE school_code = $1`,
    [SCHOOL],
  );
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'teacher.sample@example.test', 'Teacher Sample', 'hashed', 'Teacher', 'Sample', $2, 'TEACHER', true, true)`,
    [TEACHER_ID, SCHOOL],
  );
  const term = async (name, start, end, active) => (await pool.query(
    `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
     VALUES ($1, $2, $3, $4, '2025-2026', $5) RETURNING term_id`,
    [SCHOOL, name, start, end, active],
  )).rows[0].term_id;
  termIds = {
    [T1]: await term(T1, '2025-09-01', '2026-01-31', false),
    [T2]: await term(T2, '2026-02-01', '2026-06-30', true),
  };
}

async function seedStudent({ name, grade, school = SCHOOL, oen = null, homeroom = TEACHER_ID }) {
  const { rows } = await pool.query(
    `INSERT INTO students (name, school, grade, homeroom_teacher_id, oen) VALUES ($1, $2, $3, $4, $5) RETURNING student_id`,
    [name, school, grade, homeroom, oen],
  );
  return rows[0].student_id;
}

/**
 * A class with one 100-point assessment. `score` null = blank cell,
 * 'missing' = flagged missing (counts 0), undefined = no row at all.
 */
async function seedClass({ studentId, subject, grade, term, score, school = SCHOOL, teacherName = 'Teacher Sample' }) {
  const { rows } = await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING class_id`,
    [school, grade, subject, teacherName, TEACHER_ID, term ? termIds[term] : null, term || null],
  );
  const classId = rows[0].class_id;
  await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
  const { rows: a } = await pool.query(
    `INSERT INTO assessments (class_id, name, weight_points, max_score, is_parent) VALUES ($1, 'Unit Test', 100, 100, false) RETURNING assessment_id`,
    [classId],
  );
  if (score === 'missing') {
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, NULL, 'missing')`, [studentId, a[0].assessment_id]);
  } else if (score !== undefined) {
    await pool.query('INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)', [studentId, a[0].assessment_id, score]);
  }
  return classId;
}

async function seedRcFeedback(studentId, classId, term, workHabits, behavior, comment) {
  await pool.query(
    `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment) VALUES ($1, $2, $3, $4, $5, $6)`,
    [studentId, classId, term, workHabits, behavior, comment],
  );
}

async function seedAbsences(studentId, school, absent) {
  for (let i = 0; i < absent; i += 1) {
    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, $2::date + $3::int, 'ABSENT', $4)`,
      [studentId, '2025-10-01', i, school],
    );
  }
  await pool.query(
    `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, '2025-11-03', 'PRESENT', $2)`,
    [studentId, school],
  );
}

// ─────────────────────────────────────────────────────── parity checks ──

/** School, assets, student and meta fields every legacy template receives. */
function expectCommonParity(L, R) {
  const info = L.schoolInfo || {};
  expect(R.school.name).toBe(info.name);
  expect(R.school.address).toBe(info.address ?? '');
  expect(R.school.phone).toBe(info.phone ?? '');
  expect(R.school.email).toBe(info.email ?? '');

  const assets = L.schoolAssets || {};
  expect(R.assets.logo).toBe(assets.logoUrl ?? null);
  expect(R.assets.principalSignature).toBe(assets.principalSignatureUrl ?? null);
  expect(R.assets.stamp).toBe(assets.schoolStampUrl ?? null);
  expect(R.assets.teacherSignature).toBeNull();

  expect(R.student.name).toBe(L.student.name);
  expect(R.student.grade).toBe(String(L.student.grade));
  expect(R.student.oen).toBe(L.student.oen ?? '');
  expect(R.student.homeroomTeacher).toBe(L.student.homeroomTeacher);
  if ('daysOfAbsence' in L.student) expect(R.student.daysAbsent).toBe(L.student.daysOfAbsence);
  if ('teacherAssistant' in L.student) expect(R.student.teacherAssistant).toBe(L.student.teacherAssistant || '');
  if ('school' in L.student) expect(R.school.code).toBe(L.student.school);
  if ('term' in L) expect(R.meta.term).toBe(L.term);

  // Time-dependent: the same day (± a midnight rollover between the two calls).
  expect(R.meta.generatedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Math.abs(Date.parse(R.meta.generatedDate) - Date.parse(L.generatedDate))).toBeLessThanOrEqual(DAY_MS);
}

const inlined = (url) => (url ? `data:inlined;${url}` : null);

/**
 * The JK/SK progress templates' input (renderAlHaadiProgressReport{JK,SK})
 * against ReportData: everything they print about the school, the student,
 * the date and year, the images and the comment rows.
 */
function expectKindergartenProgressParity(L, R, commentRows) {
  const info = L.schoolInfo;
  expect(R.school.name).toBe(info.name);
  expect(R.school.address).toBe(info.address ?? '');
  expect(R.school.phone).toBe(info.phone ?? '');
  expect(R.school.email).toBe(info.email ?? '');
  // The footers print the website the email's domain gives.
  expect(R.school.website).toBe(schoolWebsite(info.email) || '');

  expect(L.logoDataUri).toBe(inlined(R.assets.logo));
  expect(L.principalSignatureDataUri).toBe(inlined(R.assets.principalSignature));
  if ('schoolStampDataUri' in L) expect(L.schoolStampDataUri).toBe(inlined(R.assets.stamp));

  expect(R.student.name).toBe(L.student.name);
  expect(R.student.oen).toBe(L.student.oen ?? '');
  expect(R.student.homeroomTeacher).toBe(L.student.teacherName);
  expect(R.student.daysAbsent).toBe(L.student.daysAbsent);
  if ('teacherAssistant' in L.student) expect(R.student.teacherAssistant).toBe(L.student.teacherAssistant || '');

  expect(R.meta.reportDate).toBe(L.reportDate);
  expect(R.meta.schoolYear).toBe(L.schoolYearLabel ? formatSchoolYearLabel(L.schoolYearLabel) : '');

  // Every row, in print order, with the text the template prints.
  expect(R.comments).toEqual(commentRows.map((row) => ({
    key: row.key,
    label: row.label,
    caption: row.caption || '',
    text: String(L.comments[row.key] || '').trim(),
  })));
}

/** JK domains / SK subjects → R.skills, item by item. */
function expectSkillsParity(R, groups, { itemsKey, groupIdKey, itemIdKey, rating, t1, t2, comments }) {
  expect(R.skills.map((g) => g.id)).toEqual(groups.map((g) => g[groupIdKey]));
  groups.forEach((g, gi) => {
    const rg = R.skills[gi];
    expect(rg.name).toBe(g.name);
    if (comments) expect(rg.comment).toBe(comments[g[groupIdKey]] || '');
    expect(rg.items.map((i) => i.id)).toEqual(g[itemsKey].map((i) => i[itemIdKey]));
    g[itemsKey].forEach((item, ii) => {
      const ri = rg.items[ii];
      const id = item[itemIdKey];
      expect(ri.name).toBe(item.name);
      expect(ri.description).toBe(item.description || '');
      if (rating) expect(ri.rating).toBe(rating[id] || '');
      if (t1) expect(ri.t1).toBe(t1[id] || '');
      if (t2) expect(ri.t2).toBe(t2[id] || '');
    });
  });
}

// ───────────────────────────────────────────────────────────── tests ──

describe('Integration: ReportData assembler matches the legacy generators', () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    supabase._mockStorage.upload.mockResolvedValue({ data: { path: 'mock-path' }, error: null });
    supabase._mockStorage.createSignedUrl.mockImplementation(async (path, seconds) => ({
      data: { signedUrl: `https://signed.example.test/${path}?ttl=${seconds}` }, error: null,
    }));
    await seedSchool();
  });

  it('1. grades 1-8 report card', async () => {
    const studentId = await seedStudent({ name: 'Test Student A', grade: '4', oen: '000111222' });
    // Mathematics in both terms: the standard card averages every class → 85.
    const mathT1 = await seedClass({ studentId, subject: 'Mathematics', grade: '4', term: T1, score: 80 });
    await seedClass({ studentId, subject: 'Mathematics', grade: '4', term: T2, score: 90 });
    const science = await seedClass({ studentId, subject: 'Science', grade: '4', term: T1, score: null }); // no evidence → I
    await seedClass({ studentId, subject: 'Art', grade: '4', term: T1, score: 'missing' }); // missing → 0
    await seedRcFeedback(studentId, mathT1, T1, 'E', 'G', 'Solid number sense.');
    await seedRcFeedback(studentId, science, T1, null, null, 'Asks good questions.');
    await seedAbsences(studentId, SCHOOL, 2);

    const res = fakeRes();
    await reportCardController.generateReportCard({ body: { studentId, term: T1 } }, res);
    expect(res.statusCode).toBe(200);
    const { args: L, html } = lastCall(reportCardTemplate.getReportCardHTML);

    const R = await assembleReportData({ studentId, docType: 'report_card', term: T1 });
    expectCommonParity(L, R);

    // The fixture really exercises the rules.
    expect(L.subjects.map((s) => s.subject)).toEqual(['Art', 'Mathematics', 'Science']);
    expect(L.subjects.find((s) => s.subject === 'Mathematics').grade).toBeCloseTo(85);
    expect(L.student.daysOfAbsence).toBe(2);

    expect(R.subjects.map((s) => s.name)).toEqual(L.subjects.map((s) => s.subject));
    L.subjects.forEach((legacy, i) => {
      const row = R.subjects[i];
      expect(row.mark).toEqual(legacy.grade == null ? 'I' : legacy.grade);
      // …and it prints the same cell.
      expect(reportCardTemplate.formatReportMark(row.mark, R.student.grade))
        .toBe(reportCardTemplate.formatReportMark(legacy.grade, L.student.grade));
      const fb = L.feedbacks.find((f) => f.subject === legacy.subject);
      expect(row.workHabits).toBe(fb?.work_habits || '');
      expect(row.behaviour).toBe(fb?.behavior || '');
      expect(row.comment).toBe(fb?.comment || '');
      expect(row.coreStandards).toBe('');
      expect(row.terms).toEqual({});
    });
    expect(R.subjects.find((s) => s.name === 'Science').mark).toBe('I');
    expect(R.subjects.find((s) => s.name === 'Art').mark).toBe(0);

    // The title the legacy card prints uses the same term label.
    expect(html).toContain(`${R.meta.termLabel} REPORT CARD`);
    expect(R.meta.termLabel).toBe('FIRST TERM');
    expect(R.meta.termNumber).toBe(1);
    expect(R.school.name).toBe('Al Haadi Academy');
    expect(R.assets.logo).toBe('https://signed.example.test/logos/sample-logo.png?ttl=3600');
    expect(R.student).toMatchObject({ firstName: 'Test', lastName: 'Student A', gradeLabel: 'Grade 4', gradeNumber: 4, teacherAssistant: '' });
    expect(R.skills).toEqual([]);
    expect(R.comments).toEqual([]);
    expect(R.learningSkills).toEqual([]);
  });

  it('1b. report card for a school with no schools row or school year (fallbacks)', async () => {
    const studentId = await seedStudent({ name: 'Test Student B', grade: '2', school: 'PLAYGROUND', homeroom: null });
    await seedClass({ studentId, subject: 'Reading', grade: '2', term: null, score: 72, school: 'PLAYGROUND' });

    const res = fakeRes();
    await reportCardController.generateReportCard({ body: { studentId, term: 'Fall' } }, res);
    expect(res.statusCode).toBe(200);
    const { args: L, html } = lastCall(reportCardTemplate.getReportCardHTML);

    const R = await assembleReportData({ studentId, docType: 'report_card', term: 'Fall' });
    expectCommonParity(L, R);
    expect(R.school.name).toBe('PLAYGROUND');
    expect(R.student.homeroomTeacher).toBe('N/A');
    expect(R.assets.logo).toBeNull();
    expect(R.subjects).toEqual([expect.objectContaining({ name: 'Reading', mark: 72 })]);
    expect(R.meta.termLabel).toBe('FALL');
    expect(R.meta.termNumber).toBeNull();
    // No school_years row: the legacy September rule, the legacy title's year.
    expect(html).toContain(`REPORT CARD ${R.meta.schoolYear.replace(' - ', '-')}`);
  });

  it('2. Al Haadi Term 2 three-row report card', async () => {
    const studentId = await seedStudent({ name: 'Test Student C', grade: '4' });
    const mathT1 = await seedClass({ studentId, subject: 'Mathematics', grade: '4', term: T1, score: 80 });
    const mathT2 = await seedClass({ studentId, subject: 'Mathematics', grade: '4', term: T2, score: 90 });
    const peT1 = await seedClass({ studentId, subject: 'Physical Education', grade: '4', term: T1, score: 92 });
    await seedClass({ studentId, subject: 'French', grade: '4', term: T2, score: 75 });
    await seedClass({ studentId, subject: 'Science', grade: '4', term: T2, score: null });
    await seedRcFeedback(studentId, mathT1, T1, 'S', 'N', 'Slow start.');
    await seedRcFeedback(studentId, mathT2, T2, 'E', 'G', 'Excellent progress.');
    await seedRcFeedback(studentId, peT1, T1, 'G', 'G', 'Active.');

    const res = fakeRes();
    await reportCardController.generateReportCard({ body: { studentId, term: T2 } }, res);
    expect(res.statusCode).toBe(200);
    expect(reportCardTemplate.getReportCardHTML).not.toHaveBeenCalled();
    const { args: L } = lastCall(alHaadiT2Template.getAlHaadiT2ReportCardHTML);

    const R = await assembleReportData({ studentId, docType: 'report_card', term: T2 });
    expectCommonParity(L, R);

    expect(L.subjects.map((s) => s.subject)).toEqual(['French', 'Mathematics', 'Physical Education', 'Science']);
    expect(R.subjects.map((s) => s.name)).toEqual(L.subjects.map((s) => s.subject));
    const dash = (v) => (v == null ? '—' : reportCardTemplate.formatReportMark(v, '4'));
    L.subjects.forEach((legacy, i) => {
      const row = R.subjects[i];
      const fb1 = L.feedbacksT1.find((f) => f.subject === legacy.subject);
      const fb2 = L.feedbacksT2.find((f) => f.subject === legacy.subject);
      expect(row.terms.t1.mark).toEqual(legacy.t1);
      expect(row.terms.t2.mark).toEqual(legacy.t2);
      expect(row.terms.final.mark).toEqual(legacy.final);
      expect(row.mark).toEqual(legacy.t2);
      expect(dash(row.terms.final.mark)).toBe(dash(legacy.final));
      expect(row.terms.t1.workHabits).toBe(fb1?.work_habits || '');
      expect(row.terms.t1.behaviour).toBe(fb1?.behavior || '');
      expect(row.terms.t2.workHabits).toBe(fb2?.work_habits || '');
      expect(row.terms.t2.behaviour).toBe(fb2?.behavior || '');
      expect(row.comment).toBe(fb2?.comment || ''); // the card's comment is Term 2's
      expect(row.terms.final).toMatchObject({ workHabits: '', behaviour: '', comment: '' });
    });
    const math = R.subjects.find((s) => s.name === 'Mathematics');
    expect(math.terms.final.mark).toBeCloseTo(85);
    expect(R.subjects.find((s) => s.name === 'Science').mark).toBe('I');
    expect(R.subjects.find((s) => s.name === 'Physical Education').mark).toBeNull();
  });

  it('3. grades 1-8 progress report, and its skips', async () => {
    const studentId = await seedStudent({ name: 'Test Student D', grade: '6' });
    const english = await seedClass({ studentId, subject: 'English', grade: '6', term: T1, teacherName: 'Teacher Sample' });
    await seedClass({ studentId, subject: 'Science', grade: '6', term: T1, teacherName: 'Teacher Other' });
    await seedClass({ studentId, subject: 'History', grade: '6', term: T2 }); // other term: left out
    await pool.query(
      `INSERT INTO progress_report_feedback (student_id, class_id, term, core_standards, work_habit, behavior, comment)
       VALUES ($1, $2, $3, 'Meets most expectations', 'G', 'E', 'Reads every day.')`,
      [studentId, english, T1],
    );

    const res = fakeRes();
    await progressReportsController.generateProgressReport({ body: { studentId, term: T1 } }, res);
    expect(res.body.status).toBe('success');
    const { args: L } = lastCall(progressTemplate.getProgressReportHTML);

    const R = await assembleReportData({ studentId, docType: 'progress_report', term: T1 });
    expectCommonParity(L, R);

    expect(L.progressData.map((p) => p.subject)).toEqual(['English', 'Science']);
    expect(R.subjects.map((s) => s.name)).toEqual(L.progressData.map((p) => p.subject));
    L.progressData.forEach((p, i) => {
      const row = R.subjects[i];
      expect(row.teacher).toBe(p.teacherName || '');
      expect(row.workHabits).toBe(p.workHabit || '');
      expect(row.behaviour).toBe(p.behavior || '');
      expect(row.coreStandards).toBe(p.coreStandards || '');
      expect(row.comment).toBe(p.comment || '');
      expect(row.mark).toBeNull();
    });
    expect(R.subjects[0]).toMatchObject({ workHabits: 'G', behaviour: 'E', coreStandards: 'Meets most expectations', comment: 'Reads every day.' });

    // Skips: same message and status as the legacy handler.
    const noClasses = await seedStudent({ name: 'Test Student E', grade: '6' });
    for (const [sid, term] of [[noClasses, T1], [studentId, 'Term 9']]) {
      const legacyRes = fakeRes();
      await progressReportsController.generateProgressReport({ body: { studentId: sid, term } }, legacyRes);
      const err = await assembleReportData({ studentId: sid, docType: 'progress_report', term }).catch((e) => e);
      expect(err).toBeInstanceOf(ReportSkip);
      expect(err.status).toBe(legacyRes.statusCode);
      expect(err.message).toBe(legacyRes.body.message);
    }
  });

  async function seedJK(docType, studentId) {
    const domain = async (name, sort) => (await pool.query(
      `INSERT INTO jk_skill_domains (document_type, name, sort_order, school) VALUES ($1, $2, $3, $4) RETURNING domain_id`,
      [docType, name, sort, SCHOOL],
    )).rows[0].domain_id;
    const skill = async (domainId, name, description, sort) => (await pool.query(
      `INSERT INTO jk_skills (domain_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING skill_id`,
      [domainId, name, description, sort],
    )).rows[0].skill_id;
    const rate = (skillId, term, rating) => pool.query(
      `INSERT INTO jk_skill_assessments (student_id, skill_id, term, rating, school) VALUES ($1, $2, $3, $4, $5)`,
      [studentId, skillId, term, rating, SCHOOL],
    );

    // Inserted out of order: sort_order decides.
    const d2 = await domain('Problem Solving', 2);
    const d1 = await domain('Belonging and Contributing', 1);
    await domain('Empty Domain', 3);
    const s12 = await skill(d1, 'Takes turns', null, 2);
    const s11 = await skill(d1, 'Shares materials', 'Shares with peers', 1);
    const s21 = await skill(d2, 'Tries new strategies', 'Persists with puzzles', 1);
    await rate(s11, T1, docType === 'report_card' ? 'BG' : 'D');
    await rate(s21, T1, docType === 'report_card' ? 'DV' : 'B');
    await rate(s11, T2, docType === 'report_card' ? 'DV' : 'I');
    await rate(s12, T2, docType === 'report_card' ? 'NI' : 'N');
    await pool.query(
      `INSERT INTO jk_domain_comments (student_id, domain_id, term, comment, school) VALUES ($1, $2, $3, 'Shares readily.', $4)`,
      [studentId, d1, T1, SCHOOL],
    );
    await pool.query(
      `INSERT INTO jk_teacher_assistants (student_id, teacher_assistant_name, term, school) VALUES ($1, 'Assistant Sample', $2, $3)`,
      [studentId, T1, SCHOOL],
    );
    return { d1, d2 };
  }

  it('4. JK progress report', async () => {
    // No homeroom: the report names the teacher of the grade's Kindergarten class.
    const studentId = await seedStudent({ name: 'Test Student F', grade: 'JK', oen: '444555666', homeroom: null });
    await seedJK('progress_report', studentId);
    const kgClass = await seedClass({ studentId, subject: 'Junior Kindergarten', grade: 'JK', term: T1 });
    await pool.query(
      `UPDATE classes SET school_year_id = (SELECT school_year_id FROM school_years WHERE school = $1 AND label = '2025-2026') WHERE class_id = $2`,
      [SCHOOL, kgClass],
    );
    await pool.query(
      `INSERT INTO jk_progress_report_comments (student_id, term, section_type, comment, school)
       VALUES ($1, $2, 'socio_emotional', '  Settles in <well>.  ', $3), ($1, $2, 'academic_achievement', 'Counts to 20.', $3)`,
      [studentId, T1, SCHOOL],
    );
    // Two absences in 2025-2026; one the year before and one after the
    // report date don't count.
    await seedAbsences(studentId, SCHOOL, 2);
    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, '2024-10-01', 'ABSENT', $2), ($1, '2026-03-10', 'ABSENT', $2)`,
      [studentId, SCHOOL],
    );
    const reportDate = '2026-03-02';

    await jkController.generateSingleJKProgressReport(studentId, T1, { reportDate });
    const { args: L, html: rendered } = lastCall(jkProgressTemplate.renderAlHaadiProgressReportJK);

    const R = await assembleReportData({ studentId, docType: 'progress_report', term: T1, reportDate });
    expectKindergartenProgressParity(L, R, JK_PROGRESS_COMMENT_ROWS);

    // The fixture really exercises the rules.
    expect(L.student).toMatchObject({ teacherName: 'Teacher Sample', teacherAssistant: 'Assistant Sample', daysAbsent: 2 });
    expect(L.schoolYearLabel).toBe('2025-2026');
    expect(R.meta).toMatchObject({ reportDate, schoolYear: '2025 - 2026' });
    expect(R.comments.map((c) => [c.label, c.text])).toEqual([
      ['Academic achievement', 'Counts to 20.'],
      ['Socio-emotional development', 'Settles in <well>.'],
    ]);
    // …and the legacy page prints those labels and texts.
    for (const c of R.comments) {
      expect(rendered.html).toContain(`${escapeHtml(c.label)}:`);
      expect(rendered.html).toContain(escapeHtml(c.text));
    }

    expect(L.domains.map((d) => d.name)).toEqual(['Belonging and Contributing', 'Problem Solving', 'Empty Domain']);
    expectSkillsParity(R, L.domains, { itemsKey: 'skills', groupIdKey: 'domainId', itemIdKey: 'skillId', rating: L.ratingMap });
    expect(R.skills[0].items.map((i) => i.rating)).toEqual(['D', '']);
    expect(R.skills[0].items.map((i) => i.t2)).toEqual(['I', 'N']);
    expect(R.skills[2].items).toEqual([]);

    expect(R.subjects).toEqual([]);
    expect(R.learningSkills).toEqual([]);
    expect(R.student).toMatchObject({ gradeLabel: 'Junior Kindergarten', gradeNumber: -1 });
    expect(R.school.website).toBe('www.example.test');
  });

  it('4b. JK progress report with no school year: no year printed, every absence counts', async () => {
    const studentId = await seedStudent({ name: 'Test Student F2', grade: 'JK' });
    await pool.query('DELETE FROM school_years WHERE school = $1', [SCHOOL]);
    await seedAbsences(studentId, SCHOOL, 3);
    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, '2019-01-07', 'ABSENT', $2)`,
      [studentId, SCHOOL],
    );

    await jkController.generateSingleJKProgressReport(studentId, T1, { reportDate: '2026-03-02' });
    const { args: L } = lastCall(jkProgressTemplate.renderAlHaadiProgressReportJK);
    const R = await assembleReportData({ studentId, docType: 'progress_report', term: T1, reportDate: '2026-03-02' });
    expectKindergartenProgressParity(L, R, JK_PROGRESS_COMMENT_ROWS);
    expect(L.schoolYearLabel).toBeNull();
    expect(R.meta.schoolYear).toBe('');
    expect(R.student.daysAbsent).toBe(4);
    expect(R.student.homeroomTeacher).toBe('Teacher Sample');
    expect(R.comments.map((c) => c.text)).toEqual(['', '']);
  });

  it('5. SK progress report', async () => {
    const studentId = await seedStudent({ name: 'Test Student G', grade: 'SK' });
    const subject = async (name, sort) => (await pool.query(
      `INSERT INTO sk_subjects (document_type, name, sort_order, school) VALUES ('progress_report', $1, $2, $3) RETURNING subject_id`,
      [name, sort, SCHOOL],
    )).rows[0].subject_id;
    const standard = async (subjectId, name, description, sort) => (await pool.query(
      `INSERT INTO sk_standards (subject_id, name, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING standard_id`,
      [subjectId, name, description, sort],
    )).rows[0].standard_id;
    const math = await subject('Mathematics', 2);
    const lit = await subject('Literacy - Reading', 1);
    const st1 = await standard(lit, 'Knows letter sounds', 'Upper and lower case', 1);
    const st2 = await standard(math, 'Counts objects', null, 1);
    await pool.query(
      `INSERT INTO sk_standard_assessments (student_id, standard_id, term, rating, school) VALUES ($1, $2, $3, 'P', $4), ($1, $5, $3, 'DV', $4)`,
      [studentId, st1, T1, SCHOOL, st2],
    );
    await pool.query(
      `INSERT INTO sk_subject_comments (student_id, subject_id, term, comment, school) VALUES ($1, $2, $3, 'Counts past 30.', $4)`,
      [studentId, math, T1, SCHOOL],
    );
    // Two of the nine rows filled (one padded), and an old-style section the
    // paper template has no row for.
    await pool.query(
      `INSERT INTO sk_progress_report_comments (student_id, term, section_type, comment, school)
       VALUES ($1, $2, 'language_arts', '  Enjoys stories.  ', $3), ($1, $2, 'french', 'Says bonjour & merci.', $3),
              ($1, $2, 'academic_achievement', 'Never printed.', $3)`,
      [studentId, T1, SCHOOL],
    );
    await seedAbsences(studentId, SCHOOL, 1);
    const reportDate = '2025-11-14';

    await skController.generateSingleSKProgressReport(studentId, T1, { reportDate });
    const { args: L, html: rendered } = lastCall(skProgressTemplate.renderAlHaadiProgressReportSK);

    const R = await assembleReportData({ studentId, docType: 'progress_report', term: T1, reportDate });
    expectKindergartenProgressParity(L, R, SK_PROGRESS_COMMENT_ROWS);

    expect(L.student).toMatchObject({ teacherName: 'Teacher Sample', daysAbsent: 1 });
    expect(R.meta).toMatchObject({ reportDate, schoolYear: '2025 - 2026' });
    expect(R.comments.map((c) => c.key)).toEqual(SK_PROGRESS_COMMENT_ROWS.map((r) => r.key));
    expect(R.comments[0]).toEqual({
      key: 'language_arts', label: 'Language Arts', caption: 'Reading, Writing, Oral communication, Media Literacy', text: 'Enjoys stories.',
    });
    expect(R.comments.find((c) => c.key === 'french').text).toBe('Says bonjour & merci.');
    expect(R.comments.filter((c) => c.text === '')).toHaveLength(7);
    for (const c of R.comments) {
      expect(rendered.html).toContain(escapeHtml(c.label));
      if (c.caption) expect(rendered.html).toContain(escapeHtml(c.caption));
      if (c.text) expect(rendered.html).toContain(escapeHtml(c.text));
    }

    expect(L.subjects.map((s) => s.name)).toEqual(['Literacy - Reading', 'Mathematics']);
    expectSkillsParity(R, L.subjects, {
      itemsKey: 'standards', groupIdKey: 'subjectId', itemIdKey: 'standardId', rating: L.ratingMap,
    });
    // The subject comment is a report-card field; the progress report doesn't print it.
    expect(R.skills[1].comment).toBe('Counts past 30.');
    expect(R.student.teacherAssistant).toBe('');
    expect(R.student).toMatchObject({ gradeLabel: 'Senior Kindergarten', gradeNumber: 0 });
  });

  it('6. JK report card, with the six learning skills', async () => {
    const studentId = await seedStudent({ name: 'Test Student H', grade: 'JK', oen: '999888777' });
    await seedJK('report_card', studentId);
    const learning = (term, skill, rating) => pool.query(
      `INSERT INTO jk_learning_skills (student_id, term, skill_name, rating, school) VALUES ($1, $2, $3, $4, $5)`,
      [studentId, term, skill, rating, SCHOOL],
    );
    await learning(T1, 'Responsibility', 'E');
    await learning(T1, 'Collaboration', 'G');
    await learning(T2, 'Responsibility', 'S');
    await learning(T2, 'Self-Regulation', 'N');

    // Through the report-card handler: it routes JK students to the JK generator.
    const res = fakeRes();
    await reportCardController.generateReportCard({ body: { studentId, term: T1 } }, res);
    expect(res.statusCode).toBe(200);
    const { args: L, html } = lastCall(jkReportCardTemplate.getAlHaadiReportCardJKHTML);

    const R = await assembleReportData({ studentId, docType: 'report_card', term: T1 });
    expectCommonParity(L, R);
    expectSkillsParity(R, L.domains, {
      itemsKey: 'skills', groupIdKey: 'domainId', itemIdKey: 'skillId', t1: L.ratingMapTerm1, t2: L.ratingMapTerm2, comments: L.commentMap,
    });
    expect(R.skills[0].comment).toBe('Shares readily.');
    expect(R.skills[0].items.map((i) => [i.t1, i.t2])).toEqual([['BG', 'DV'], ['', 'NI']]);

    // Learning skills: the legacy card prints this term's rating per skill…
    expect(R.learningSkills).toHaveLength(6);
    let cursor = -1;
    for (const ls of R.learningSkills) {
      expect(ls.rating).toBe(L.learningSkills[ls.name] || '');
      // …with these names, in this order, and these descriptors.
      const at = html.indexOf(`<strong>${ls.name}</strong>`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
      for (const d of ls.descriptors) expect(html).toContain(`<li>${d}</li>`);
    }
    expect(R.learningSkills.find((s) => s.name === 'Responsibility')).toMatchObject({ rating: 'E', t1: 'E', t2: 'S' });
    expect(R.learningSkills.find((s) => s.name === 'Self-Regulation')).toMatchObject({ rating: '', t1: '', t2: 'N' });
    expect(R.comments).toEqual([]);
  });

  it('7. SK report card', async () => {
    const studentId = await seedStudent({ name: 'Test Student I', grade: 'SK' });
    const { rows: [{ subject_id: arts }] } = await pool.query(
      `INSERT INTO sk_subjects (document_type, name, sort_order, school) VALUES ('report_card', 'The Arts', 1, $1) RETURNING subject_id`,
      [SCHOOL],
    );
    const { rows: [{ standard_id: st }] } = await pool.query(
      `INSERT INTO sk_standards (subject_id, name, description, sort_order) VALUES ($1, 'Explores colour', 'Mixes paints', 1) RETURNING standard_id`,
      [arts],
    );
    await pool.query(
      `INSERT INTO sk_standard_assessments (student_id, standard_id, term, rating, school) VALUES ($1, $2, $3, 'G', $5), ($1, $2, $4, 'E', $5)`,
      [studentId, st, T1, T2, SCHOOL],
    );
    await pool.query(
      `INSERT INTO sk_subject_comments (student_id, subject_id, term, comment, school) VALUES ($1, $2, $3, 'Bold choices.', $4)`,
      [studentId, arts, T2, SCHOOL],
    );
    await pool.query(
      `INSERT INTO sk_teacher_assistants (student_id, teacher_assistant_name, term, school) VALUES ($1, 'Assistant Other', $2, $3)`,
      [studentId, T2, SCHOOL],
    );

    await skController.generateSingleSKReportCard(studentId, T2);
    const { args: L } = lastCall(skReportCardTemplate.getAlHaadiReportCardSKHTML);

    const R = await assembleReportData({ studentId, docType: 'report_card', term: T2 });
    expectCommonParity(L, R);
    expectSkillsParity(R, L.subjects, {
      itemsKey: 'standards', groupIdKey: 'subjectId', itemIdKey: 'standardId', t1: L.ratingMapTerm1, t2: L.ratingMapTerm2, comments: L.commentMap,
    });
    expect(R.skills[0].items[0]).toMatchObject({ rating: 'E', t1: 'G', t2: 'E' });
    expect(R.skills[0].comment).toBe('Bold choices.');
    expect(R.student.teacherAssistant).toBe('Assistant Other');
    expect(R.learningSkills).toEqual([]);
  });

  it('picks the school year the report date falls in, else the active one', async () => {
    const studentId = await seedStudent({ name: 'Test Student J', grade: '3' });
    await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT school_code, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM schools WHERE school_code = $1`,
      [SCHOOL],
    );
    const inNewYear = await assembleReportData({ studentId, docType: 'report_card', term: T1, reportDate: '2026-11-15' });
    expect(inNewYear.meta.schoolYear).toBe('2026 - 2027');
    expect(inNewYear.meta.reportDate).toBe('2026-11-15');

    const inOldYear = await assembleReportData({ studentId, docType: 'report_card', term: T1, reportDate: '2026-03-02' });
    expect(inOldYear.meta.schoolYear).toBe('2025 - 2026');

    // A summer date in neither year: the active one (the seeded 2025-2026).
    const between = await assembleReportData({ studentId, docType: 'report_card', term: T1, reportDate: '2026-07-15' });
    expect(between.meta.schoolYear).toBe('2025 - 2026');
  });
});
