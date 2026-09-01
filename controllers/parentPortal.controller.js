// controllers/parentPortal.controller.js
//
// Parent-portal endpoints. Everything is scoped to the logged-in parent:
// school ALWAYS comes from req.user.school (the JWT) and per-student routes
// sit behind verifyParentOwnsStudent, so a parent can only ever read data
// for their own linked children. Grade math reuses the analytics engine
// (null-skip by default) so numbers match report cards and admin analytics —
// minus the cohort percentile/rank fields, which are not parent-facing.

const db = require('../config/database');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const stats = require('../utils/statsUtils');
const parentPortalQueries = require('../queries/parentPortal.queries');
const parentStudentQueries = require('../queries/parentStudent.queries');
const termQueries = require('../queries/term.queries');
const progressReportQueries = require('../queries/progressReports.queries');
const schoolCalendarQueries = require('../queries/schoolCalendar.queries');
const aiWeeklySummary = require('../services/aiWeeklySummary.service');
const { academicYearToRange } = require('../utils/agendaCalendar');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve the term to use: explicit ?termId= (accepts the 'all' sentinel),
 * otherwise a sensible default WITHIN the selected school year
 * (req.schoolYear, from the X-School-Year header): the active term if it
 * belongs to that year, else the term containing today, else the most
 * recently ended, else the first. Explicit termIds are checked against the
 * parent's school and the selected year so a probed or stale UUID resolves
 * to null instead of leaking another scope's data.
 * Returns { termId, row } where row is the full term row when available.
 */
async function resolveTerm(req) {
  const requested = req.query.termId;
  const yearId = req.schoolYear?.schoolYearId ?? null;

  if (requested === engine.ALL_TERMS) return { termId: engine.ALL_TERMS, row: null };
  if (requested) {
    const { rows } = await db.query(termQueries.selectTermById, [requested]);
    const row = rows[0];
    const wrongSchool = !row || row.school !== req.user.school;
    const wrongYear = row && yearId && row.school_year_id && row.school_year_id !== yearId;
    if (wrongSchool || wrongYear) return { termId: null, row: null };
    return { termId: row.term_id, row };
  }

  const { rows } = await db.query(termQueries.selectTermsBySchool, [req.user.school, yearId]);
  if (rows.length === 0) return { termId: null, row: null };

  const today = new Date().toISOString().slice(0, 10);
  const dateOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const row =
    rows.find((t) => t.is_active) ||
    rows.find((t) => dateOf(t.start_date) <= today && today <= dateOf(t.end_date)) ||
    rows.filter((t) => dateOf(t.end_date) < today).pop() ||
    rows[0];
  return { termId: row.term_id, row };
}

// Parents only ever see published work, and unpublished assessments are
// excluded from their averages entirely — the matrix is pruned before the
// grade engine runs, so finalPct is genuinely recomputed over the published
// subset rather than display-filtered. Teacher-facing consumers of the same
// engine pass nothing and are unaffected.
const PARENT_VIEW = { publishedOnly: true };

const mapEventToResponse = (event) => ({
  eventId: event.event_id,
  school: event.school,
  schoolId: event.school_id,
  title: event.title,
  category: event.category,
  startDate: event.start_date,
  endDate: event.end_date,
  isSchoolClosed: event.is_school_closed,
  notes: event.notes,
  createdAt: event.created_at,
  updatedAt: event.updated_at,
});

const mapProgressFeedback = (row) => ({
  classId: row.class_id,
  subject: row.subject,
  classGrade: row.class_grade,
  teacherName: row.teacher_name,
  term: row.term,
  coreStandards: row.core_standards,
  workHabit: row.work_habit,
  behavior: row.behavior,
  comment: row.comment,
  createdAt: row.created_at,
});

function emptyGrades(studentId, termId, eng) {
  return {
    studentId,
    studentName: null,
    gradeLevel: null,
    termId,
    engine: eng,
    attendance: null,
    overall: null,
    classes: [],
    missingWork: [],
  };
}

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/summary?termId=&engine=
// One call powering the Overview page: every linked child with overall
// average, attendance, latest teacher feedback — plus the next school event.
// ────────────────────────────────────────────────────────────────────
const getSummary = async (req, res) => {
  const { school, userId } = req.user;

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const { termId } = await resolveTerm(req);

    const { rows: linkRows } = await db.query(parentStudentQueries.selectStudentsByParentId, [
      userId,
      req.schoolYear?.schoolYearId ?? null,
    ]);
    const children = linkRows.filter((r) => r.school === school);

    let matrix = null;
    let attendance = new Map();
    if (termId) {
      [matrix, attendance] = await Promise.all([
        engine.buildAnalyticsMatrix(school, termId, eng, PARENT_VIEW),
        engine.getAttendanceMap(school, termId),
      ]);
    }

    const childSummaries = await Promise.all(
      children.map(async (row) => {
        const cross = matrix ? matrix.students.get(row.student_id) : null;
        const att = attendance.get(row.student_id) || null;
        const { rows: fbRows } = await db.query(
          progressReportQueries.getStudentProgressReportFeedback,
          [row.student_id],
        );
        const latest = fbRows
          .slice()
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;

        return {
          studentId: row.student_id,
          name: row.student_name,
          grade: row.student_grade,
          relation: row.relation,
          homeroomTeacher: row.homeroom_teacher_first_name
            ? `${row.homeroom_teacher_first_name} ${row.homeroom_teacher_last_name || ''}`.trim()
            : null,
          overallAvg: cross ? stats.round1(engine.overallAvgForStudent(cross)) : null,
          classCount: cross ? cross.classes.length : 0,
          attendance: att
            ? { presentDays: att.presentDays, totalDays: att.totalDays, pct: att.pct }
            : null,
          latestFeedback: latest ? mapProgressFeedback(latest) : null,
        };
      }),
    );

    // Next upcoming (or in-progress) school event within the next year.
    const yearId = req.schoolYear?.schoolYearId || null;
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate())
      .toISOString()
      .slice(0, 10);
    const { rows: eventRows } = await db.query(schoolCalendarQueries.selectEventsBySchoolAndRange, [
      school,
      from,
      to,
      yearId,
    ]);
    const nextEvent = eventRows.length ? mapEventToResponse(eventRows[0]) : null;

    return res.status(200).json({
      status: 'success',
      data: { termId, nextEvent, children: childSummaries },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error('Error fetching parent portal summary:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching summary' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/students/:studentId/grades?termId=&engine=
// Same shape as analytics getStudentDetail minus the cohort percentile
// fields. A child with no graded work this term gets a friendly empty
// payload (200), not a 404 — the Overview renders every child regardless.
// ────────────────────────────────────────────────────────────────────
const getStudentGrades = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const { termId } = await resolveTerm(req);
    if (!termId) {
      return res.status(200).json({ status: 'success', data: emptyGrades(studentId, null, eng) });
    }

    const [matrix, attendance] = await Promise.all([
      engine.buildAnalyticsMatrix(school, termId, eng, PARENT_VIEW),
      engine.getAttendanceMap(school, termId),
    ]);

    // Shared with the AI weekly summary, so both read identical numbers.
    const breakdown = engine.getStudentClassBreakdown(matrix, studentId);
    if (!breakdown) {
      return res.status(200).json({ status: 'success', data: emptyGrades(studentId, termId, eng) });
    }

    const att = attendance.get(studentId) || null;

    return res.status(200).json({
      status: 'success',
      data: {
        studentId: breakdown.studentId,
        studentName: breakdown.studentName,
        gradeLevel: breakdown.gradeLevel,
        termId,
        engine: eng,
        attendance: att
          ? { presentDays: att.presentDays, totalDays: att.totalDays, pct: att.pct }
          : null,
        overall: {
          avg: stats.round1(breakdown.overallAvg),
          classCount: breakdown.classes.length,
          missingCount: breakdown.missingWork.length,
        },
        classes: breakdown.classes,
        missingWork: breakdown.missingWork,
      },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error('Error fetching parent portal grades:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching grades' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/students/:studentId/attendance?from=&to=&termId=
// Day-by-day history plus a summary. Default range = the resolved term.
// ────────────────────────────────────────────────────────────────────
const getStudentAttendance = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;

  try {
    let { from, to } = req.query;
    if (!from || !to) {
      const { row } = await resolveTerm(req);
      if (!row) {
        return res.status(200).json({
          status: 'success',
          data: {
            studentId,
            from: from || null,
            to: to || null,
            summary: { presentDays: 0, lateDays: 0, absentDays: 0, totalDays: 0, pct: null },
            days: [],
          },
        });
      }
      from = from || row.start_date;
      to = to || row.end_date;
    }

    const { rows } = await db.query(parentPortalQueries.selectStudentAttendanceRange, [
      studentId,
      school,
      from,
      to,
    ]);

    let presentDays = 0;
    let lateDays = 0;
    let absentDays = 0;
    for (const r of rows) {
      if (r.status === 'PRESENT') presentDays += 1;
      else if (r.status === 'LATE') lateDays += 1;
      else if (r.status === 'ABSENT') absentDays += 1;
    }
    const totalDays = rows.length;
    // Present = PRESENT or LATE, matching the analytics attendance convention.
    const pct = totalDays ? stats.round1(((presentDays + lateDays) / totalDays) * 100) : null;

    return res.status(200).json({
      status: 'success',
      data: {
        studentId,
        from,
        to,
        summary: { presentDays, lateDays, absentDays, totalDays, pct },
        days: rows.map((r) => ({ date: r.attendance_date, status: r.status })),
      },
    });
  } catch (error) {
    logger.error('Error fetching parent portal attendance:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching attendance' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/students/:studentId/feedback
// Progress-report feedback, report-card feedback and generated progress
// report PDFs for one child, across all classes and terms.
// ────────────────────────────────────────────────────────────────────
const getStudentFeedback = async (req, res) => {
  const { studentId } = req.params;

  try {
    const [progressFb, reportCardFb, progressReports] = await Promise.all([
      db.query(progressReportQueries.getStudentProgressReportFeedback, [studentId]),
      db.query(parentPortalQueries.selectReportCardFeedbackByStudent, [studentId]),
      db.query(progressReportQueries.getStudentProgressReports, [studentId]),
    ]);

    return res.status(200).json({
      status: 'success',
      data: {
        studentId,
        progressFeedback: progressFb.rows.map(mapProgressFeedback),
        reportCardFeedback: reportCardFb.rows.map((row) => ({
          classId: row.class_id,
          subject: row.subject,
          classGrade: row.class_grade,
          teacherName: row.teacher_name,
          term: row.term,
          workHabits: row.work_habits,
          behavior: row.behavior,
          comment: row.comment,
        })),
        progressReports: progressReports.rows.map((row) => ({
          term: row.term,
          filePath: row.file_path,
          generatedAt: row.generated_at,
        })),
      },
    });
  } catch (error) {
    logger.error('Error fetching parent portal feedback:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching feedback' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/calendar?academicYear=  |  ?from=&to=
// Same response shape as /api/calendar-events, but the school is forced
// from the JWT — parents cannot read another school's calendar.
// ────────────────────────────────────────────────────────────────────
const getCalendar = async (req, res) => {
  const { school } = req.user;
  const { academicYear, from, to } = req.query;

  try {
    const yearId = req.schoolYear?.schoolYearId || null;
    let rows;
    if (academicYear) {
      const range = academicYearToRange(academicYear);
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchoolAndRange, [
        school,
        range.from,
        range.to,
        yearId,
      ]));
    } else if (from && to) {
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchoolAndRange, [
        school,
        from,
        to,
        yearId,
      ]));
    } else {
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchool, [school, yearId]));
    }

    return res.status(200).json({ status: 'success', data: rows.map(mapEventToResponse) });
  } catch (error) {
    logger.error('Error fetching parent portal calendar:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching calendar events' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/recent-publications?limit=
// Newest published marks across every linked child, for the dashboard.
//
// Built from the published-only matrix rather than raw SQL so a category
// carries its rollup percentage — a category has no student_assessments
// row of its own, so a score-based query would drop it entirely.
// ────────────────────────────────────────────────────────────────────
const getRecentPublications = async (req, res) => {
  const { school, userId } = req.user;
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 50);

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const { termId } = await resolveTerm(req);

    const [{ rows: linkRows }, { rows: seenRows }] = await Promise.all([
      db.query(parentStudentQueries.selectStudentsByParentId, [
        userId,
        req.schoolYear?.schoolYearId ?? null,
      ]),
      db.query(parentPortalQueries.selectLastSeenByParent, [userId]),
    ]);

    const children = linkRows.filter((r) => r.school === school);
    if (!termId || children.length === 0) {
      return res.status(200).json({ status: 'success', data: { items: [], newCount: 0 } });
    }

    const lastSeenByStudent = new Map(seenRows.map((r) => [r.student_id, r.last_seen_at]));
    const matrix = await engine.buildAnalyticsMatrix(school, termId, eng, PARENT_VIEW);

    const items = [];
    for (const child of children) {
      const breakdown = engine.getStudentClassBreakdown(matrix, child.student_id);
      if (!breakdown) continue;

      const lastSeen = lastSeenByStudent.get(child.student_id);
      const lastSeenTime = lastSeen ? new Date(lastSeen).getTime() : null;

      for (const cls of breakdown.classes) {
        for (const a of cls.assessmentScores) {
          if (!a.publishedAt) continue;
          if (a.parentAssessmentId) continue; // the category represents its children
          if (a.isExcluded) continue;

          const pct = a.isParent
            ? a.rollupPct
            : a.score != null && a.maxScore
              ? stats.round1((a.score / a.maxScore) * 100)
              : null;
          if (pct == null) continue; // nothing to report yet

          const publishedTime = new Date(a.publishedAt).getTime();
          items.push({
            studentId: child.student_id,
            childName: child.student_name,
            classId: cls.classId,
            subject: cls.subject,
            assessmentId: a.assessmentId,
            assessmentName: a.name,
            score: a.score,
            maxScore: a.maxScore,
            pct,
            comment: a.parentComment,
            publishedAt: a.publishedAt,
            isNew: lastSeenTime == null || publishedTime > lastSeenTime,
          });
        }
      }
    }

    items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const trimmed = items.slice(0, limit);

    return res.status(200).json({
      status: 'success',
      data: { items: trimmed, newCount: trimmed.filter((i) => i.isNew).length },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error('Error fetching recent publications:', error);
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching recent publications' });
  }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/parent-portal/recent-publications/seen
// Clears the NEW badges for every child linked to this parent.
// ────────────────────────────────────────────────────────────────────
const markPublicationsSeen = async (req, res) => {
  try {
    const { rows } = await db.query(parentPortalQueries.markParentPublicationsSeen, [
      req.user.userId,
    ]);
    return res.status(200).json({
      status: 'success',
      data: { seenAt: rows[0]?.last_seen_at || new Date().toISOString() },
    });
  } catch (error) {
    logger.error('Error marking publications seen:', error);
    return res.status(500).json({ status: 'failed', message: 'Error updating seen state' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/parent-portal/students/:studentId/weekly-summary
//
// Always 200s. When generation fails or no OpenAI key is configured the
// payload carries content: null / unavailable: true, and the dashboard
// simply renders without the card.
// ────────────────────────────────────────────────────────────────────
const getWeeklySummary = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const { termId } = await resolveTerm(req);

    const summary = await aiWeeklySummary.getOrGenerateWeeklySummary({
      school,
      studentId,
      termId,
      engineName: eng,
    });

    return res.status(200).json({ status: 'success', data: { studentId, ...summary } });
  } catch (error) {
    // The dashboard must never break over a missing summary.
    logger.error('Error building weekly AI summary:', error);
    return res.status(200).json({
      status: 'success',
      data: {
        studentId,
        content: null,
        weekStart: null,
        weekEnd: null,
        generatedAt: null,
        unavailable: true,
      },
    });
  }
};

module.exports = {
  getSummary,
  getStudentGrades,
  getStudentAttendance,
  getStudentFeedback,
  getCalendar,
  getRecentPublications,
  markPublicationsSeen,
  getWeeklySummary,
};
