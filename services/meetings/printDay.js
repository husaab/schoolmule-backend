// services/meetings/printDay.js
//
// "Print my day": one PDF for a teacher's meetings on one day. First the
// schedule, then each family's Student summary in meeting order, the same
// pages the Student summary report prints (reports.controller):
// - the classes the teacher teaches the child;
// - for the child's homeroom teacher, every class of the term, behind the
//   term grades page (what homeroom teachers usually bring).

const db = require('../../config/database');
const { PDFDocument } = require('pdf-lib');
const reportsQueries = require('../../queries/reports.queries');
const { createPDFBuffer, launchPDFBrowser } = require('../../utils/pdfGenerator');
const { getStudentSummaryHTMLHorizontal } = require('../../templates/studentSummaryTemplateHorizontal');
const { getStudentTermSummaryHTML } = require('../../templates/studentTermSummaryTemplate');
const { escapeHtml } = require('../../templates/emailLayout');
const { computeClassGrade } = require('../gradeEngine');
const S = require('./state');
const { timeLabel } = require('./slots');
const T = require('./time');
const { MeetingError } = require('./booking');

const DAYS_ABSENT_SQL = "SELECT COUNT(*)::int AS n FROM general_attendance WHERE student_id = $1 AND status = 'ABSENT'";

function scheduleHtml({ schoolName, teacherName, dayLabel, rows }) {
  const body = rows.map((r) => `
    <tr class="${r.muted ? 'muted' : ''}">
      <td class="t">${escapeHtml(r.time)}</td>
      <td><div class="w">${escapeHtml(r.title)}</div>${r.sub ? `<div class="s">${escapeHtml(r.sub)}</div>` : ''}</td>
    </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Helvetica,Arial,sans-serif;color:#0f172a;margin:0}
    h1{font-size:20px;margin:0 0 4px} .sub{color:#64748b;font-size:13px;margin:0 0 18px}
    table{width:100%;border-collapse:collapse} td{padding:8px 10px 8px 0;border-top:1px solid #e2e8f0;vertical-align:top;font-size:13px}
    .t{width:80px;font-weight:700;white-space:nowrap} .s{color:#64748b;font-size:12px;margin-top:2px}
    tr.muted td{color:#64748b}
  </style></head><body>
    <h1>${escapeHtml(teacherName)} · Parent–teacher meetings</h1>
    <p class="sub">${escapeHtml(dayLabel)} · ${escapeHtml(schoolName)}</p>
    <table>${body}</table>
  </body></html>`;
}

/** The summary pages (HTML) for one child, from this teacher's point of view. */
async function summaryPages({ teacher, studentId, term, schoolInfo, homeroom }) {
  const { rows: [student] } = await db.query(reportsQueries.getStudentById, [studentId]);
  if (!student) return [];
  const enrolled = (await db.query(reportsQueries.getStudentClassesForTerm, [studentId, term.term_id, teacher.id])).rows;
  const mine = new Set((teacher.classesByStudent.get(studentId) || []).map((c) => c.classId));
  const classes = homeroom ? enrolled : enrolled.filter((c) => mine.has(c.class_id));
  if (!classes.length) return [];
  const ids = classes.map((c) => c.class_id);
  const [assessments, scores, absent] = await Promise.all([
    db.query(reportsQueries.getAssessmentsByClasses, [ids]),
    db.query(reportsQueries.getStudentAssessmentScoresByClasses, [studentId, ids]),
    db.query(DAYS_ABSENT_SQL, [studentId]).catch(() => ({ rows: [{ n: 0 }] })),
  ]);
  const daysOfAbsence = absent.rows[0]?.n || 0;
  const pages = classes.map((classInfo) => {
    const a = assessments.rows.filter((r) => r.class_id === classInfo.class_id);
    const sc = scores.rows.filter((r) => r.class_id === classInfo.class_id);
    const { pct, coverage } = computeClassGrade(a, sc);
    return { classInfo, a, sc, pct, coverage };
  });
  const htmls = [];
  if (homeroom && pages.length > 1) {
    htmls.push(getStudentTermSummaryHTML({
      schoolInfo, student, term, daysOfAbsence, orientation: 'horizontal',
      classes: pages.map((p) => ({ subject: p.classInfo.subject, teacherName: p.classInfo.teacher_name, pct: p.pct, coverage: p.a.length ? p.coverage : null })),
    }));
  }
  for (const p of pages) {
    htmls.push(getStudentSummaryHTMLHorizontal({
      schoolInfo, student, classInfo: p.classInfo, term, assessments: p.a, studentAssessments: p.sc,
      calculatedGrade: p.pct, coverage: p.coverage, daysOfAbsence,
    }));
  }
  return htmls;
}

/** @returns {Promise<{ pdf: Buffer, filename: string }>} */
async function printDay({ school, eventId, teacherId, dayId }) {
  const state = await S.loadEvent(db, eventId, school);
  if (!state) throw new MeetingError(404, 'NOT_FOUND', 'These meetings were not found');
  const people = await S.loadPeople(db, state.event);
  S.orderBookings(state, people);
  const teacher = people.teachers.get(teacherId);
  const day = state.days.find((d) => d.day_id === dayId);
  if (!teacher || !day) throw new MeetingError(404, 'NOT_FOUND', 'No meetings that day');
  const bookings = state.bookings.filter((b) => b.teacher_id === teacherId && b.day_id === dayId).sort((a, b) => a.start_min - b.start_min);
  const plan = S.planFor(state, teacherId, day);
  const { rows: [schoolInfo] } = await db.query(reportsQueries.getSchoolInfoByCode, [school]);

  const rows = [
    ...bookings.map((b) => ({
      at: b.start_min,
      time: timeLabel(b.start_min),
      title: b.student_ids.map((id) => people.students.get(id)?.name).filter(Boolean).join(' & '),
      sub: [
        [...new Set(b.student_ids.flatMap((id) => people.students.get(id)?.guardians.map((g) => g.name).filter(Boolean) || []))].slice(0, 2).join(' & '),
        S.placeFor(state, people, b),
      ].filter(Boolean).join(' · '),
    })),
    ...plan.breaks.map((br) => ({ at: br.start, time: timeLabel(br.start), title: `Break until ${timeLabel(br.end)}`, muted: true })),
  ].sort((a, b) => a.at - b.at);

  const htmls = [scheduleHtml({ schoolName: schoolInfo?.name || school, teacherName: teacher.name, dayLabel: T.longDay(day.day_date), rows })];
  if (people.term) {
    const { rows: [term] } = await db.query(reportsQueries.getTermInSchool, [people.term.term_id, school]);
    for (const b of bookings) {
      for (const id of b.student_ids) {
        htmls.push(...await summaryPages({ teacher, studentId: id, term, schoolInfo, homeroom: teacher.homeroomIds.has(id) }));
      }
    }
  }

  const browser = await launchPDFBrowser();
  try {
    const merged = await PDFDocument.create();
    for (const html of htmls) {
      const doc = await PDFDocument.load(await createPDFBuffer(html, { browser }));
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach((page) => merged.addPage(page));
    }
    const safe = (text) => String(text).replace(/[^A-Za-z0-9.-]+/g, '_');
    return { pdf: Buffer.from(await merged.save()), filename: `Meetings_${safe(day.day_date)}_${safe(teacher.name)}.pdf` };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { printDay, scheduleHtml };
