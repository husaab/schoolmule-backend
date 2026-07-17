const db = require('../config/database');
const logger = require('../logger');
const rolloverQueries = require('../queries/schoolYearRollover.queries');
const schoolYearQueries = require('../queries/schoolYear.queries');

const GRADE_PROGRESSION = {
  JK: 'SK', SK: '1',
  1: '2', 2: '3', 3: '4', 4: '5', 5: '6', 6: '7', 7: '8',
  8: null, // graduates
};

const previewRollover = async (req, res, next) => {
  try {
    let sourceYearId = req.query.sourceYearId || null;
    if (!sourceYearId) {
      const active = await db.query(schoolYearQueries.selectActiveYearBySchool, [req.user.school]);
      sourceYearId = active.rows[0]?.school_year_id;
    }
    if (!sourceYearId) {
      return res.status(400).json({ status: 'failed', message: 'No source year to roll over from' });
    }
    const yearRow = await db.query(schoolYearQueries.selectYearById, [sourceYearId]);
    if (yearRow.rows.length === 0 || yearRow.rows[0].school !== req.user.school) {
      return res.status(404).json({ status: 'failed', message: 'Source year not found' });
    }

    const students = await db.query(rolloverQueries.selectSourceStudents, [req.user.school, sourceYearId]);
    const classes = await db.query(rolloverQueries.selectSourceClasses, [req.user.school, sourceYearId]);
    const terms = await db.query(
      'SELECT name, start_date, end_date FROM terms WHERE school_year_id = $1 ORDER BY start_date', [sourceYearId]);

    const plusYear = (d) => {
      const dt = new Date(d);
      dt.setFullYear(dt.getFullYear() + 1);
      return dt.toISOString().slice(0, 10);
    };

    return res.status(200).json({
      status: 'success',
      data: {
        sourceYear: { schoolYearId: yearRow.rows[0].school_year_id, label: yearRow.rows[0].label },
        students: students.rows.map((s) => ({
          studentId: s.student_id,
          name: s.name,
          grade: s.grade,
          proposedGrade: GRADE_PROGRESSION[s.grade] ?? null,
          isGraduating: GRADE_PROGRESSION[s.grade] === null,
        })),
        classes: classes.rows.map((c) => ({
          classId: c.class_id, grade: c.grade, subject: c.subject,
          teacherName: c.teacher_name, termName: c.term_name,
        })),
        terms: terms.rows.map((t) => ({
          name: t.name, startDate: t.start_date, endDate: t.end_date,
          proposedStartDate: plusYear(t.start_date), proposedEndDate: plusYear(t.end_date),
        })),
      },
    });
  } catch (error) { next(error); }
};

const executeRollover = async (req, res, next) => {
  const client = await db.connect();
  try {
    const targetYearId = req.params.id;
    const { students = { mode: 'skip' }, classes = { mode: 'skip' }, terms = [],
            copyPlanner = false, copyCalendar = false } = req.body;

    const target = await client.query(schoolYearQueries.selectYearById, [targetYearId]);
    if (target.rows.length === 0 || target.rows[0].school !== req.user.school) {
      client.release();
      return res.status(404).json({ status: 'failed', message: 'Target year not found' });
    }
    const targetYear = target.rows[0];
    const sourceYearId = targetYear.created_from_year_id;
    if (!sourceYearId && (students.mode === 'rollover' || classes.mode === 'duplicate' || copyPlanner || copyCalendar)) {
      client.release();
      return res.status(400).json({ status: 'failed', message: 'This year has no source year to copy from' });
    }

    await client.query('BEGIN');
    const summary = {
      termsCreated: 0, studentsRolled: 0, studentsGraduated: 0,
      classesCreated: 0, plannerCopied: false, calendarEventsCopied: 0,
    };

    // 1. Terms — needed first so duplicated classes can attach by term name.
    const termIdByName = {};
    for (const t of terms) {
      const { rows } = await client.query(rolloverQueries.insertTermForYear, [
        req.user.school, targetYear.school_id, t.name, t.startDate, t.endDate,
        targetYear.label, targetYearId,
      ]);
      termIdByName[rows[0].name] = rows[0].term_id;
      summary.termsCreated += 1;
    }

    // 2. Students.
    if (students.mode === 'rollover') {
      const exclude = new Set(students.excludeStudentIds || []);
      const overrides = students.gradeOverrides || {};
      const already = await client.query(rolloverQueries.selectAlreadyRolled, [targetYearId]);
      const alreadyRolled = new Set(already.rows.map((r) => r.previous_student_id));
      const source = await client.query(rolloverQueries.selectSourceStudents, [req.user.school, sourceYearId]);

      for (const s of source.rows) {
        if (exclude.has(s.student_id) || alreadyRolled.has(s.student_id)) continue;
        const newGrade = overrides[s.student_id] ?? GRADE_PROGRESSION[s.grade] ?? null;
        if (newGrade === null) { summary.studentsGraduated += 1; continue; }
        const inserted = await client.query(rolloverQueries.insertRolledStudent, [
          s.name, s.homeroom_teacher_id, newGrade, s.oen, req.user.school,
          s.mother_name, s.mother_email, s.mother_number,
          s.father_name, s.father_email, s.father_number, s.emergency_contact,
          targetYearId, s.student_id,
        ]);
        await client.query(rolloverQueries.copyParentLinks, [inserted.rows[0].student_id, s.student_id]);
        summary.studentsRolled += 1;
      }
    }

    // 3. Classes — duplicated with empty rosters and no assessments.
    if (classes.mode === 'duplicate') {
      const exclude = new Set(classes.excludeClassIds || []);
      const source = await client.query(rolloverQueries.selectSourceClasses, [req.user.school, sourceYearId]);
      for (const c of source.rows) {
        if (exclude.has(c.class_id)) continue;
        const termId = c.term_name && termIdByName[c.term_name] ? termIdByName[c.term_name] : null;
        const termName = termId ? c.term_name : null;
        const { rows } = await client.query(rolloverQueries.insertRolledClass, [
          req.user.school, c.grade, c.subject, c.teacher_name, c.teacher_id,
          termId, termName, targetYearId,
        ]);
        await client.query(rolloverQueries.copyClassTeachers, [rows[0].class_id, c.class_id]);
        summary.classesCreated += 1;
      }
    }

    // 4. Planner config (not generated schedules, not courses).
    if (copyPlanner) {
      await client.query(rolloverQueries.copyPlannerSettings, [req.user.school, targetYearId, sourceYearId]);
      await client.query(rolloverQueries.copyPlannerTeachers, [req.user.school, targetYearId, sourceYearId]);
      await client.query(rolloverQueries.copyPlannerRooms, [req.user.school, targetYearId, sourceYearId]);
      await client.query(rolloverQueries.copyPlannerDayTemplates, [req.user.school, targetYearId, sourceYearId]);

      // class groups need an id map so fixed blocks can be remapped
      const groups = await client.query(rolloverQueries.selectPlannerClassGroups, [req.user.school, sourceYearId]);
      const groupIdMap = {};
      for (const g of groups.rows) {
        const { rows } = await client.query(rolloverQueries.insertPlannerClassGroup, [
          g.school, g.school_id, g.name, g.grade, g.sort_order, targetYearId,
        ]);
        groupIdMap[g.class_group_id] = rows[0].class_group_id;
      }
      const blocks = await client.query(rolloverQueries.selectPlannerFixedBlocks, [req.user.school, sourceYearId]);
      for (const b of blocks.rows) {
        const remapped = Array.isArray(b.class_group_ids)
          ? b.class_group_ids.map((id) => groupIdMap[id]).filter(Boolean)
          : b.class_group_ids;
        await client.query(rolloverQueries.insertPlannerFixedBlock, [
          b.school, b.school_id, b.label, b.day_of_week, b.start_min, b.end_min,
          JSON.stringify(remapped), targetYearId,
        ]);
      }
      summary.plannerCopied = true;
    }

    // 5. Calendar events, shifted +1 year.
    if (copyCalendar) {
      const { rowCount } = await client.query(rolloverQueries.copyCalendarEvents,
        [req.user.school, targetYearId, sourceYearId]);
      summary.calendarEventsCopied = rowCount;
    }

    await client.query('COMMIT');
    return res.status(200).json({ status: 'success', data: summary });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err: error }, 'Rollover failed, rolled back');
    next(error);
  } finally {
    client.release();
  }
};

module.exports = { previewRollover, executeRollover };
