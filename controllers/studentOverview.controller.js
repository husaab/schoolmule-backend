// controllers/studentOverview.controller.js
//
// The staff student profile (/students/[id] in the frontend).
//   GET /api/students/:id/overview   profile, enrolments, per-term trend,
//                                    attendance days, guardians, reports
//   GET /api/students/:id/grades     one term's full grade breakdown
//
// Staff only (requireStaff on the routes). Teachers see every student of
// their school, like the Students page. School always comes from the JWT,
// and a student of another school is a plain 404 so ids can't be probed.
// Grades come from the shared analytics matrix, so the profile, analytics,
// the gradebook and the parent portal all read the same numbers.

const db = require('../config/database');
const logger = require('../logger');
const { can } = require('../services/access/access');
const engine = require('../services/analyticsEngine');
const { buildStudentTermDetail } = require('../services/studentTermDetail');
const stats = require('../utils/statsUtils');
const { pickDefaultTerm } = require('../utils/defaultTerm');
const { toCamel } = require('./student.controller');
const q = require('../queries/studentOverview.queries');
const parentPortalQueries = require('../queries/parentPortal.queries');
const progressReportQueries = require('../queries/progressReports.queries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// JK/SK are graded on competencies (their own gradebooks and reports), so
// they have no numeric averages and never appear in the analytics matrix.
const COMPETENCY_GRADES = new Set(['JK', 'SK']);

const NOT_FOUND = { status: 'failed', message: 'Student not found' };

/** The student row, or null when it doesn't exist or isn't the caller's school. */
async function loadStudent(req) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query(q.selectStudent, [id]);
  const row = rows[0];
  if (!row || row.school !== req.user.school) return null;
  return row;
}

const isCompetency = (student) => COMPETENCY_GRADES.has(String(student.grade));

/** Numeric grades exist only for non-archived grade 1–8 students. */
const hasNumericGrades = (student) => !isCompetency(student) && !student.is_archived;

/** Present = PRESENT or LATE, matching analytics and the parent portal. */
function summarizeAttendance(days) {
  let presentDays = 0;
  let lateDays = 0;
  let absentDays = 0;
  for (const d of days) {
    if (d.status === 'PRESENT') presentDays += 1;
    else if (d.status === 'LATE') lateDays += 1;
    else if (d.status === 'ABSENT') absentDays += 1;
  }
  const totalDays = days.length;
  const pct = totalDays ? stats.round1(((presentDays + lateDays) / totalDays) * 100) : null;
  return { presentDays, lateDays, absentDays, totalDays, pct };
}

/** One term's headline numbers for the trend: average, subjects, attendance. */
function summarizeTerm(term, matrix, studentId, days) {
  const cross = matrix ? matrix.students.get(studentId) : null;
  const termDays = days.filter((d) => d.date >= term.start_date && d.date <= term.end_date);
  return {
    termId: term.term_id,
    name: term.name,
    startDate: term.start_date,
    endDate: term.end_date,
    isActive: Boolean(term.is_active),
    avg: cross ? stats.round1(engine.overallAvgForStudent(cross)) : null,
    subjects: cross ? cross.classes.map((c) => ({ subject: c.subject, pct: stats.round1(c.finalPct) })) : [],
    attendance: summarizeAttendance(termDays),
  };
}

const mapGuardian = (r) => ({
  linkId: r.parent_student_link_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  relation: r.relation,
  // A live account, an invite still out, or a contact with no portal access.
  status: r.parent_id ? 'linked' : r.invited_at ? 'invited' : 'none',
});

const mapReportFile = (r) => ({
  term: r.term,
  filePath: r.file_path,
  generatedAt: r.generated_at,
  emailSent: Boolean(r.email_sent),
  emailSentAt: r.email_sent_at,
});

// ────────────────────────────────────────────────────────────────────
// GET /api/students/:id/overview
// ────────────────────────────────────────────────────────────────────
const getStudentOverview = async (req, res) => {
  const { school } = req.user;

  try {
    const student = await loadStudent(req);
    if (!student) return res.status(404).json(NOT_FOUND);
    const studentId = student.student_id;

    const rowsOf = (sql, params) => db.query(sql, params).then((r) => r.rows);
    const [terms, enrollments, days, guardians, reportCards, progressReports, reportCardFb, progressFb] =
      await Promise.all([
        rowsOf(q.selectTerms, [school, student.school_year_id ?? null]),
        rowsOf(q.selectEnrollments, [studentId, school]),
        rowsOf(q.selectAttendanceDays, [studentId, school]),
        rowsOf(q.selectGuardianLinks, [studentId]),
        rowsOf(q.selectReportCards, [studentId, school]),
        rowsOf(q.selectProgressReports, [studentId, school]),
        rowsOf(parentPortalQueries.selectReportCardFeedbackByStudent, [studentId]),
        rowsOf(progressReportQueries.getStudentProgressReportFeedback, [studentId]),
      ]);

    // One cached matrix per term; skipped when the student can't be in them,
    // and without analytics (RBAC: term averages are grade data).
    const seesGrades = can(req, 'analytics');
    const matrices = hasNumericGrades(student) && seesGrades
      ? await Promise.all(terms.map((t) => engine.buildAnalyticsMatrix(school, t.term_id)))
      : terms.map(() => null);

    return res.status(200).json({
      status: 'success',
      data: {
        student: { ...toCamel(student), homeroomTeacherName: student.homeroom_teacher_name ?? null },
        gradingMode: isCompetency(student) ? 'competency' : 'numeric',
        defaultTermId: pickDefaultTerm(terms)?.term_id ?? null,
        terms: terms.map((t, i) => summarizeTerm(t, matrices[i], studentId, days)),
        enrollments: enrollments.map((c) => ({
          classId: c.class_id,
          subject: c.subject,
          grade: c.class_grade,
          teacherId: c.teacher_id,
          teacherName: c.teacher_name,
          termId: c.term_id,
        })),
        attendance: { summary: summarizeAttendance(days), days },
        guardianAccounts: guardians.map(mapGuardian),
        reports: {
          reportCards: reportCards.map(mapReportFile),
          progressReports: progressReports.map(mapReportFile),
          reportCardFeedback: (can(req, 'report_cards') ? reportCardFb : []).map((r) => ({
            classId: r.class_id,
            subject: r.subject,
            teacherName: r.teacher_name,
            term: r.term,
            workHabits: r.work_habits,
            behavior: r.behavior,
            comment: r.comment,
          })),
          progressFeedback: (can(req, 'report_cards') ? progressFb : []).map((r) => ({
            classId: r.class_id,
            subject: r.subject,
            teacherName: r.teacher_name,
            term: r.term,
            coreStandards: r.core_standards,
            workHabit: r.work_habit,
            behavior: r.behavior,
            comment: r.comment,
          })),
        },
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching student overview');
    return res.status(500).json({ status: 'failed', message: 'Error fetching student overview' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/students/:id/grades?termId=
// Same detail as GET /api/analytics/student/:id. termId defaults like every
// term picker (active → containing today → latest ended → first) and must be
// one of the student's own school-year terms. detail is null when the
// student has nothing graded numerically that term.
// ────────────────────────────────────────────────────────────────────
const getStudentGrades = async (req, res) => {
  const { school } = req.user;

  try {
    const student = await loadStudent(req);
    if (!student) return res.status(404).json(NOT_FOUND);

    const { rows: terms } = await db.query(q.selectTerms, [school, student.school_year_id ?? null]);
    const requested = req.query.termId;
    const term = requested ? terms.find((t) => t.term_id === requested) : pickDefaultTerm(terms);
    if (requested && !term) {
      return res.status(400).json({ status: 'failed', message: 'That term is not in this student\'s school year' });
    }
    if (!term || !hasNumericGrades(student)) {
      return res.status(200).json({ status: 'success', data: { termId: term?.term_id ?? null, detail: null } });
    }

    const detail = await buildStudentTermDetail(school, student.student_id, term.term_id);
    return res.status(200).json({ status: 'success', data: { termId: term.term_id, detail } });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching student grades');
    return res.status(500).json({ status: 'failed', message: 'Error fetching student grades' });
  }
};

module.exports = { getStudentOverview, getStudentGrades };
