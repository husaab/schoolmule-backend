// controllers/progressSalaat.controller.js
//
// Salaat on the grades 1-8 progress report (schools.progress_salaat): Work
// Habits and Behaviour (E/G/S/N) and a comment per student per term, printed
// as a "Salaat" box after the subject cards. The student's homeroom teacher
// fills it in; staff holding classes.all can fill in anyone's.
//
//   GET /api/progress-reports/salaat?term=Term 1
//   PUT /api/progress-reports/salaat/:studentId { term, workHabit, behavior, comment }
//
// Every rating and the comment empty removes the entry.

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/progressSalaat.queries');
const { can } = require('../services/access/access');

const RATINGS = new Set(['E', 'G', 'S', 'N']);
const MAX_COMMENT = 2000;

const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

async function salaatOn(school) {
  const { rows } = await db.query(q.selectSchoolSalaat, [school]);
  return rows[0]?.progress_salaat === true;
}

const entryOut = (row) => ({
  workHabit: row?.work_habit || '',
  behavior: row?.behavior || '',
  comment: row?.comment || '',
  updatedAt: row?.updated_at || null,
});

/** '' / null / absent → null; a letter → itself; anything else → undefined (invalid). */
function rating(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toUpperCase();
  return RATINGS.has(v) ? v : undefined;
}

const getSalaat = async (req, res) => {
  try {
    const term = typeof req.query.term === 'string' ? req.query.term.trim() : '';
    if (!term) return failed(res, 400, 'term is required');

    const enabled = await salaatOn(req.user.school);
    const canEditAll = can(req, 'classes.all');
    if (!enabled) return res.json({ status: 'success', data: { enabled: false, canEditAll, students: [] } });

    const yearId = req.schoolYear ? req.schoolYear.schoolYearId : null;
    const { rows } = await db.query(q.selectRoster, [req.user.school, yearId, term, canEditAll ? null : req.user.userId]);
    return res.json({
      status: 'success',
      data: {
        enabled: true,
        canEditAll,
        students: rows.map((r) => ({
          studentId: r.student_id,
          name: r.name,
          grade: r.grade,
          homeroomTeacherId: r.homeroom_teacher_id,
          homeroomTeacher: r.homeroom_teacher || '',
          ...entryOut(r),
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading Salaat entries');
    return failed(res, 500, 'Could not load Salaat');
  }
};

const saveSalaat = async (req, res) => {
  try {
    const { studentId } = req.params;
    const body = req.body || {};
    const term = typeof body.term === 'string' ? body.term.trim() : '';
    if (!term) return failed(res, 400, 'term is required');

    const workHabit = rating(body.workHabit);
    const behavior = rating(body.behavior);
    if (workHabit === undefined || behavior === undefined) return failed(res, 400, 'Ratings are E, G, S or N');
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (comment.length > MAX_COMMENT) return failed(res, 400, `The comment is longer than ${MAX_COMMENT} characters`);

    if (!(await salaatOn(req.user.school))) return failed(res, 404, 'Salaat is not on for this school');

    let student;
    try {
      ({ rows: [student] } = await db.query(q.selectStudent, [studentId]));
    } catch (err) {
      student = null; // a malformed id fails the uuid cast
    }
    if (!student || student.school !== String(req.user.school)) return failed(res, 404, 'Student not found');
    if (!q.GRADES.includes(student.grade)) return failed(res, 400, 'Salaat is on the grades 1-8 progress report only');
    const own = student.homeroom_teacher_id && student.homeroom_teacher_id === req.user.userId;
    if (!own && !can(req, 'classes.all')) return failed(res, 403, "Only the student's homeroom teacher can fill in Salaat");

    if (!workHabit && !behavior && !comment) {
      await db.query(q.deleteEntry, [studentId, term]);
      return res.json({ status: 'success', data: entryOut(null) });
    }
    const { rows } = await db.query(q.upsertEntry, [studentId, term, workHabit, behavior, comment || null, req.user.userId]);
    return res.json({ status: 'success', data: entryOut(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error saving Salaat entry');
    return failed(res, 500, 'Could not save Salaat');
  }
};

module.exports = { getSalaat, saveSalaat };
