// File: controllers/reportCard.controller.js

const db = require('../config/database');
const studentQueries = require('../queries/student.queries');
const { getReportCardHTML } = require('../templates/reportCardTemplate');
const { getAlHaadiT2ReportCardHTML } = require('../templates/alHaadiT2ReportCardTemplate');
const reportCardQueries = require('../queries/reportCard.queries');
const { createPDFBuffer, launchPDFBrowser } = require('../utils/pdfGenerator');
const supabase = require('../config/supabaseClient'); // configure this file if not already
const logger = require('../logger');
const { calculateStudentGrade } = require('../utils/gradeCalculator');
const { computeClassPctForStudent } = require('../services/studentViewEvaluator');
const studentViewQueries = require('../queries/studentView.queries');
const alHaadiT2Queries = require('../queries/alHaadiT2ReportCard.queries');

/**
 * Calculate final grades per subject for a student using JavaScript-based calculation
 * Handles exclusions, parent/child hierarchy, and weight scaling consistently with frontend
 *
 * @param {string} studentId - The student's UUID
 * @returns {Promise<Array<{subject_name: string, final_grade: number}>>}
 */
async function calculateSubjectGradesForStudent(studentId) {
  // 1. Get all classes the student is enrolled in
  const { rows: classRows } = await db.query(`
    SELECT c.class_id, c.subject
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
  `, [studentId]);

  if (classRows.length === 0) {
    return [];
  }

  // 2. For each class, calculate the grade using shared utility
  const classGrades = [];

  for (const cls of classRows) {
    // Get all assessments for this class
    const { rows: assessments } = await db.query(`
      SELECT
        assessment_id,
        name,
        weight_points,
        max_score,
        is_parent,
        parent_assessment_id
      FROM assessments
      WHERE class_id = $1
    `, [cls.class_id]);

    // Get student's scores with exclusion flag for ALL assessments (not just ones with scores)
    // This is critical: we need exclusion status even for assessments without scores
    // because parent-level exclusions don't have entries in student_assessments
    const { rows: studentScores } = await db.query(`
      SELECT
        a.assessment_id,
        sa.score,
        CASE WHEN sea.assessment_id IS NOT NULL THEN true ELSE false END as is_excluded
      FROM assessments a
      LEFT JOIN student_assessments sa
        ON sa.assessment_id = a.assessment_id
        AND sa.student_id = $1
      LEFT JOIN student_excluded_assessments sea
        ON sea.student_id = $1
        AND sea.class_id = a.class_id
        AND sea.assessment_id = a.assessment_id
      WHERE a.class_id = $2
    `, [studentId, cls.class_id]);

    // Calculate grade using shared utility
    const grade = calculateStudentGrade(assessments, studentScores);

    classGrades.push({
      subject: cls.subject,
      grade: grade
    });
  }

  // 3. Group by subject and average if multiple classes share a subject
  const subjectMap = new Map();
  for (const cg of classGrades) {
    if (!subjectMap.has(cg.subject)) {
      subjectMap.set(cg.subject, []);
    }
    subjectMap.get(cg.subject).push(cg.grade);
  }

  // Calculate average for each subject
  const results = [];
  for (const [subject, grades] of subjectMap) {
    const avgGrade = grades.reduce((sum, g) => sum + g, 0) / grades.length;
    results.push({
      subject_name: subject,
      final_grade: avgGrade
    });
  }

  // Sort by subject name for consistency
  results.sort((a, b) => a.subject_name.localeCompare(b.subject_name));

  return results;
}

// ────────────────────────────────────────────────────────────────────
// Al Haadi Academy Term-2 three-row report card (grades 1-8)
// ────────────────────────────────────────────────────────────────────
//
// The T2 variant shows First Term / Second Term / Final Term rows per
// subject. T1 and T2 percentages reuse computeClassPctForStudent (the
// student-view engine: null scores skipped, exclusions and parent/child
// hierarchies handled) so the card never disagrees with the student view.

/**
 * Resolve the school's Term 1 and Term 2 term rows for the academic year
 * implied by the term string the frontend sent.
 *
 * @param {string} school     school enum value (e.g. 'ALHAADIACADEMY')
 * @param {string} termString human term name, e.g. "Term 2" or "Term 2 2025-2026"
 * @returns {Promise<{ t1: object|null, t2: object|null }>}
 */
async function resolveAlHaadiTermPair(school, termString) {
  // T2: exact name match first, LIKE fallback for formatting drift.
  let t2 = null;
  const { rows: exactRows } = await db.query(
    alHaadiT2Queries.selectTermByNameAndSchool, [termString, school]
  );
  if (exactRows.length > 0) {
    t2 = exactRows[0];
  } else {
    const { rows: likeRows } = await db.query(
      alHaadiT2Queries.selectTermLike, [school, '%term 2%']
    );
    t2 = likeRows[0] || null;
  }

  // T1: same academic year as T2, falling back to the most recent Term 1.
  let t1 = null;
  if (t2) {
    const { rows: t1Rows } = await db.query(
      alHaadiT2Queries.selectTerm1ForAcademicYear, [school, t2.academic_year]
    );
    t1 = t1Rows[0] || null;
  }
  if (!t1) {
    const { rows: fallbackRows } = await db.query(
      alHaadiT2Queries.selectTermLike, [school, '%term 1%']
    );
    t1 = fallbackRows[0] || null;
  }

  logger.info(
    { school, termString, t1: t1?.term_id, t1Name: t1?.name, t2: t2?.term_id, t2Name: t2?.name },
    'Resolved Al Haadi T1/T2 term pair'
  );
  return { t1, t2 };
}

/**
 * Compute a student's per-subject percentage for ONE term using
 * computeClassPctForStudent semantics (null = zero graded work).
 * Multiple classes sharing a subject average their non-null pcts,
 * mirroring calculateSubjectGradesForStudent's grouping; all-null → null.
 *
 * @param {string} studentId
 * @param {string|null} termId  null → empty map (term not found)
 * @returns {Promise<Map<string, number|null>>}  subject → pct | null
 */
async function computeTermSubjectGrades(studentId, termId) {
  const subjectPcts = new Map(); // subject → Array<number|null>
  if (!termId) return new Map();

  const { rows: classRows } = await db.query(
    alHaadiT2Queries.selectStudentClassesForTerm, [studentId, termId]
  );

  for (const cls of classRows) {
    const { rows: scoreRows } = await db.query(
      studentViewQueries.selectScoresForClass, [cls.class_id]
    );

    // De-dupe the joined rows into an assessment list (same loop as
    // studentViewEvaluator.evaluateTerm).
    const seen = new Set();
    const assessments = [];
    for (const r of scoreRows) {
      if (seen.has(r.assessment_id)) continue;
      seen.add(r.assessment_id);
      assessments.push({
        assessment_id: r.assessment_id,
        name: r.assessment_name,
        weight_percent: r.weight_percent,
        weight_points: r.weight_points,
        max_score: r.max_score,
        is_parent: r.is_parent,
        parent_assessment_id: r.parent_assessment_id,
      });
    }

    const studentRows = scoreRows.filter((r) => r.student_id === studentId);
    const pct = computeClassPctForStudent(assessments, studentRows);

    if (!subjectPcts.has(cls.subject)) subjectPcts.set(cls.subject, []);
    subjectPcts.get(cls.subject).push(pct);
  }

  const result = new Map();
  for (const [subject, pcts] of subjectPcts) {
    const graded = pcts.filter((p) => p != null);
    result.set(
      subject,
      graded.length > 0 ? graded.reduce((s, p) => s + p, 0) / graded.length : null
    );
  }
  return result;
}

/**
 * Merge the per-term subject maps into the row model the T2 template renders.
 *
 *   Rule A — T1-only subject (e.g. Gr4-8 PE):   t2 missing → final null ("—")
 *   Rule B — T2 subject with no T1 record:      t1 missing → final null ("—")
 *   Rule E — zero graded work in a term:        map holds null → same as missing
 *   Final Term = (t1 + t2) / 2 ONLY when both are present.
 *
 * @param {Map<string, number|null>} t1Map
 * @param {Map<string, number|null>} t2Map
 * @returns {Array<{ subject: string, t1: number|null, t2: number|null, final: number|null }>}
 *          one entry per subject in the union of both maps, sorted alphabetically
 */
function mergeTermSubjects(t1Map, t2Map) {
  const subjects = new Set([...t1Map.keys(), ...t2Map.keys()]);
  const rows = [];
  for (const subject of subjects) {
    const t1 = t1Map.get(subject) ?? null;
    const t2 = t2Map.get(subject) ?? null;
    const final = t1 != null && t2 != null ? (t1 + t2) / 2 : null;
    rows.push({ subject, t1, t2, final });
  }
  rows.sort((a, b) => a.subject.localeCompare(b.subject));
  return rows;
}

/**
 * POST /report-cards/feedback
 * Body: {
 *   studentId: string,
 *   classId: string,
 *   term: string,
 *   workHabits?: string,
 *   behavior?: string,
 *   comment?: string
 */
const upsertFeedback = async (req, res) => {
  const { studentId, classId, term, workHabits, behavior, comment } = req.body;

  if (!studentId || !classId || !term) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: studentId, classId, or term'
    });
  }

  try {
    await db.query(reportCardQueries.upsertFeedback, [
      studentId,
      classId,
      term,
      workHabits || null,
      behavior || null,
      comment || null
    ]);

    return res.status(200).json({
      status: 'success',
      message: 'Feedback saved successfully'
    });
  } catch (err) {
    logger.error({ err }, "Error saving feedback");
    return res.status(500).json({ status: 'failed', message: 'Error saving feedback' });
  }
};

/**
 * GET /report-cards/feedback?studentId=...&classId=...&term=...
 */
const getFeedback = async (req, res) => {
  const { studentId, classId, term } = req.query;

  if (!studentId || !classId || !term) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing query parameters: studentId, classId, or term'
    });
  }

  try {
    const { rows } = await db.query(reportCardQueries.selectFeedback, [
      studentId,
      classId,
      term
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Feedback not found' });
    }

    return res.status(200).json({
        status: 'success',
        data: {
            studentId: rows[0].student_id,
            classId: rows[0].class_id,
            term: rows[0].term,
            workHabits: rows[0].work_habits,
            behavior: rows[0].behavior,
            comment: rows[0].comment
        }
    });
  } catch (err) {
    logger.error({ err }, "Error fetching feedback");
    return res.status(500).json({ status: 'failed', message: 'Error fetching feedback' });
  }
};

/**
 * GET /report-cards/feedback/class/:classId?term=X
 * Get all feedback for a class for a specific term
 */
const getClassFeedback = async (req, res) => {
  const { classId } = req.params;
  const { term } = req.query;

  if (!classId || !term) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required parameters: classId or term'
    });
  }

  try {
    const { rows } = await db.query(reportCardQueries.selectFeedbackByClass, [classId, term]);

    const data = rows.map(row => ({
      studentId: row.student_id,
      studentName: row.student_name,
      classId: row.class_id,
      term: row.term,
      workHabits: row.work_habits,
      behavior: row.behavior,
      comment: row.comment
    }));

    return res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    logger.error({ err }, "Error fetching class feedback");
    return res.status(500).json({ status: 'failed', message: 'Error fetching class feedback' });
  }
};

/**
 * POST /report-cards/feedback/bulk
 * Upsert feedback for multiple students at once in a transaction
 * Body: { feedbackEntries: Array<{ studentId, classId, term, workHabits?, behavior?, comment? }> }
 */
const upsertBulkFeedback = async (req, res) => {
  const { feedbackEntries } = req.body;

  if (!Array.isArray(feedbackEntries) || feedbackEntries.length === 0) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing or empty feedbackEntries array'
    });
  }

  // Validate all entries first before starting transaction
  const validationErrors = [];
  for (let i = 0; i < feedbackEntries.length; i++) {
    const entry = feedbackEntries[i];
    if (!entry.studentId || !entry.classId || !entry.term) {
      validationErrors.push({ index: i, studentId: entry.studentId, error: 'Missing required fields' });
    }
  }

  if (validationErrors.length > 0) {
    return res.status(400).json({
      status: 'failed',
      message: 'Validation failed for some entries',
      data: {
        updated: 0,
        failed: validationErrors.length,
        errors: validationErrors
      }
    });
  }

  // Use a transaction for atomicity
  try {
    await db.query('BEGIN');

    let successCount = 0;

    for (const entry of feedbackEntries) {
      const { studentId, classId, term, workHabits, behavior, comment } = entry;

      // Handle empty strings explicitly - convert empty string to null for DB
      const workHabitsValue = workHabits === '' ? null : (workHabits || null);
      const behaviorValue = behavior === '' ? null : (behavior || null);
      const commentValue = comment === '' ? null : (comment || null);

      await db.query(reportCardQueries.upsertFeedback, [
        studentId,
        classId,
        term,
        workHabitsValue,
        behaviorValue,
        commentValue
      ]);
      successCount++;
    }

    await db.query('COMMIT');

    return res.status(200).json({
      status: 'success',
      message: `Saved ${successCount} feedback entries`,
      data: {
        updated: successCount,
        failed: 0
      }
    });
  } catch (err) {
    await db.query('ROLLBACK');
    logger.error({ err }, "Bulk feedback transaction failed");
    return res.status(500).json({
      status: 'failed',
      message: 'Error saving bulk feedback - all changes rolled back',
      data: {
        updated: 0,
        failed: feedbackEntries.length,
        errors: [{ error: err.message }]
      }
    });
  }
};

const generateReportCardsBulk = async (req, res) => {
  const { studentIds, term } = req.body;

  if (!Array.isArray(studentIds) || !term) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing or invalid studentIds or term'
    });
  }

  const successes = [];
  const failures = [];

  // One Chromium launch for the whole batch — each student renders in its
  // own page. Launching per student was the dominant bulk-generation cost.
  let browser = null;
  try {
    browser = await launchPDFBrowser();
  } catch (err) {
    logger.error({ err }, 'Failed to launch shared PDF browser, falling back to per-student launches');
  }

  try {
    for (const studentId of studentIds) {
      try {
        const result = await generateSingleReportCard(studentId, term, { browser });
        successes.push({ studentId, message: result });
      } catch (err) {
        logger.error({ err, studentId }, `Failed to generate report card for ${studentId}`);
        failures.push({ studentId, error: err.message || 'Unknown error' });
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.warn({ err }, 'Failed to close shared PDF browser');
      }
    }
  }

  return res.status(200).json({
    status: 'completed',
    term,
    generated: successes,
    failed: failures
  });
};


/**
 * POST /report-cards/generate
 * Body: {
 *   studentId: string,
 *   term: string
 * }
 *
 * Delegates to generateSingleReportCard — the same path the bulk endpoint
 * uses — so JK/SK routing and the Al Haadi T2 variant apply here too.
 */
const generateReportCard = async (req, res) => {
  const { studentId, term } = req.body;
  if (!studentId || !term) {
    return res.status(400).json({ status: 'failed', message: 'Missing studentId or term' });
  }

  try {
    const message = await generateSingleReportCard(studentId, term);
    return res.status(200).json({ status: 'success', message });
  } catch (err) {
    if (err.message === 'Student not found') {
      return res.status(404).json({ status: 'failed', message: 'Student not found' });
    }
    logger.error({ err }, "Report card generation failed");
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
};

const generateSingleReportCard = async (studentId, term, opts = {}) => {
  const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (studentRows.length === 0) throw new Error('Student not found');
  const student = studentRows[0];

  // Route JK/SK students to their dedicated report card generators
  if (student.grade === 'JK') {
    const { generateSingleJKReportCard } = require('./jk.controller');
    return generateSingleJKReportCard(studentId, term, opts);
  }
  if (student.grade === 'SK') {
    const { generateSingleSKReportCard } = require('./sk.controller');
    return generateSingleSKReportCard(studentId, term, opts);
  }

  // ── Al Haadi Academy Term-2 three-row variant (grades 1-8) ──
  const schoolCode = (student.school || '').replace(/\s+/g, '').toUpperCase();
  const isAlHaadiT2 =
    schoolCode === 'ALHAADIACADEMY' &&
    (term || '').toLowerCase().includes('term 2');
  if (isAlHaadiT2) {
    return generateAlHaadiT2ReportCard(studentId, term, student, opts);
  }

  const { rows: teacherRows } = await db.query(`
    SELECT username FROM users WHERE user_id = $1
  `, [student.homeroom_teacher_id]);
  const teacherName = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

  // Calculate days of absence from general_attendance
  let daysOfAbsence = 0;
  try {
    const { rows: attendanceRows } = await db.query(`
      SELECT COUNT(*) as days_absent
      FROM general_attendance
      WHERE student_id = $1 AND status = 'ABSENT'
    `, [studentId]);
    daysOfAbsence = parseInt(attendanceRows[0]?.days_absent || 0);
  } catch (err) {
    // Silently fallback to 0
  }

  // Fetch school info (gracefully fallback if table doesn't exist)
  let schoolInfo = {
    name: student.school,
    address: '',
    phone: '',
    email: ''
  };
  try {
    const schoolCode = student.school.replace(/\s+/g, '').toUpperCase();
    const { rows: schoolRows } = await db.query(`
      SELECT name, address, phone, email
      FROM schools WHERE school_code = $1
    `, [schoolCode]);
    if (schoolRows.length > 0) {
      schoolInfo = schoolRows[0];
    }
  } catch (err) {
    // Table may not exist yet, use fallback
  }

  // Fetch school assets and generate signed URLs (gracefully fallback)
  let schoolAssets = { logoUrl: null, principalSignatureUrl: null, schoolStampUrl: null };
  try {
    const schoolCode = student.school.replace(/\s+/g, '').toUpperCase();
    const { rows: assetRows } = await db.query(`
      SELECT logo_path, principal_signature_path, school_stamp_path
      FROM school_assets
      WHERE school_code = $1
    `, [schoolCode]);

    if (assetRows.length > 0) {
      const assets = assetRows[0];
      if (assets.logo_path) {
        const { data: logoData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.logo_path, 3600);
        schoolAssets.logoUrl = logoData?.signedUrl || null;
      }
      if (assets.principal_signature_path) {
        const { data: sigData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.principal_signature_path, 3600);
        schoolAssets.principalSignatureUrl = sigData?.signedUrl || null;
      }
      if (assets.school_stamp_path) {
        const { data: stampData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.school_stamp_path, 3600);
        schoolAssets.schoolStampUrl = stampData?.signedUrl || null;
      }
    }
  } catch (err) {
    // Table may not exist yet, use empty assets
  }

  // Use JavaScript calculation for consistent grade handling
  const assessments = await calculateSubjectGradesForStudent(studentId);
  const subjects = assessments.map(a => ({
    subject: a.subject_name,
    grade: Number(a.final_grade).toFixed(1)
  }));

  const { rows: classRows } = await db.query(`
    SELECT c.class_id, c.subject
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
  `, [studentId]);

  const feedbackRows = [];
  for (const cls of classRows) {
    const { rows: fbRows } = await db.query(reportCardQueries.selectFeedback, [
      studentId,
      cls.class_id,
      term
    ]);
    if (fbRows.length > 0) {
      feedbackRows.push({
        subject: cls.subject,
        ...fbRows[0]
      });
    }
  }

  const html = getReportCardHTML({
    schoolInfo,
    schoolAssets,
    term,
    student: {
      name: student.name,
      grade: student.grade,
      oen: student.oen,
      homeroomTeacher: teacherName,
      daysOfAbsence,
      school: student.school
    },
    subjects,
    feedbacks: feedbackRows,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  const pdfBuffer = await createPDFBuffer(html, { browser: opts.browser });
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name}_${term}_report_card.pdf`;

  const { error } = await supabase
    .storage
    .from('report-cards')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

    await db.query(reportCardQueries.upsertGeneratedReportCard, [
      studentId,
      term,
      student.name,
      fileName,
      student.grade,
      student.school
    ]);

  if (error) throw new Error('Upload to storage failed');

  return 'Report card generated and uploaded';
};

/**
 * Al Haadi Academy Term-2 report card (grades 1-8): three grade rows per
 * subject — First Term, Second Term, and Final Term = (T1 + T2) / 2.
 * Selected by generateSingleReportCard when school = ALHAADIACADEMY and the
 * term string contains "term 2". Same upload + record bookkeeping as the
 * standard path; only the subject computation and template differ.
 */
const generateAlHaadiT2ReportCard = async (studentId, term, student, opts = {}) => {
  const { rows: teacherRows } = await db.query(`
    SELECT username FROM users WHERE user_id = $1
  `, [student.homeroom_teacher_id]);
  const teacherName = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

  // Calculate days of absence from general_attendance
  let daysOfAbsence = 0;
  try {
    const { rows: attendanceRows } = await db.query(`
      SELECT COUNT(*) as days_absent
      FROM general_attendance
      WHERE student_id = $1 AND status = 'ABSENT'
    `, [studentId]);
    daysOfAbsence = parseInt(attendanceRows[0]?.days_absent || 0);
  } catch (err) {
    // Silently fallback to 0
  }

  // Fetch school info (gracefully fallback if table doesn't exist)
  let schoolInfo = {
    name: student.school,
    address: '',
    phone: '',
    email: ''
  };
  try {
    const schoolCode = student.school.replace(/\s+/g, '').toUpperCase();
    const { rows: schoolRows } = await db.query(`
      SELECT name, address, phone, email
      FROM schools WHERE school_code = $1
    `, [schoolCode]);
    if (schoolRows.length > 0) {
      schoolInfo = schoolRows[0];
    }
  } catch (err) {
    // Table may not exist yet, use fallback
  }

  // Fetch school assets and generate signed URLs (gracefully fallback)
  let schoolAssets = { logoUrl: null, principalSignatureUrl: null, schoolStampUrl: null };
  try {
    const schoolCode = student.school.replace(/\s+/g, '').toUpperCase();
    const { rows: assetRows } = await db.query(`
      SELECT logo_path, principal_signature_path, school_stamp_path
      FROM school_assets
      WHERE school_code = $1
    `, [schoolCode]);

    if (assetRows.length > 0) {
      const assets = assetRows[0];
      if (assets.logo_path) {
        const { data: logoData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.logo_path, 3600);
        schoolAssets.logoUrl = logoData?.signedUrl || null;
      }
      if (assets.principal_signature_path) {
        const { data: sigData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.principal_signature_path, 3600);
        schoolAssets.principalSignatureUrl = sigData?.signedUrl || null;
      }
      if (assets.school_stamp_path) {
        const { data: stampData } = await supabase.storage
          .from('school-assets')
          .createSignedUrl(assets.school_stamp_path, 3600);
        schoolAssets.schoolStampUrl = stampData?.signedUrl || null;
      }
    }
  } catch (err) {
    // Table may not exist yet, use empty assets
  }

  // Per-term subject grades via the student-view engine, merged into
  // { subject, t1, t2, final } rows (rules A/B/E live in mergeTermSubjects).
  const { t1, t2 } = await resolveAlHaadiTermPair(student.school, term);
  const [t1Map, t2Map] = await Promise.all([
    computeTermSubjectGrades(studentId, t1?.term_id || null),
    computeTermSubjectGrades(studentId, t2?.term_id || null),
  ]);
  const subjects = mergeTermSubjects(t1Map, t2Map);

  // Work Habits / Behaviour carry forward per term: the First Term row shows
  // the Term 1 feedback, the Second Term row Term 2's. Feedback rows are
  // keyed by the term name they were saved under, so T1 feedback is looked
  // up with t1.name (not the generation term string).
  const fetchTermFeedback = async (termRow, termName) => {
    const rows = [];
    if (!termRow) return rows;
    const { rows: termClasses } = await db.query(
      alHaadiT2Queries.selectStudentClassesForTerm, [studentId, termRow.term_id]
    );
    for (const cls of termClasses) {
      const { rows: fbRows } = await db.query(reportCardQueries.selectFeedback, [
        studentId,
        cls.class_id,
        termName
      ]);
      if (fbRows.length > 0) {
        rows.push({
          subject: cls.subject,
          ...fbRows[0]
        });
      }
    }
    return rows;
  };

  const [feedbacksT1, feedbacksT2] = await Promise.all([
    fetchTermFeedback(t1, t1?.name),
    fetchTermFeedback(t2, term),
  ]);

  const html = getAlHaadiT2ReportCardHTML({
    schoolInfo,
    schoolAssets,
    term,
    student: {
      name: student.name,
      grade: student.grade,
      oen: student.oen,
      homeroomTeacher: teacherName,
      daysOfAbsence,
      school: student.school
    },
    subjects,
    feedbacksT1,
    feedbacksT2,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  const pdfBuffer = await createPDFBuffer(html, { browser: opts.browser });
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name}_${term}_report_card.pdf`;

  const { error } = await supabase
    .storage
    .from('report-cards')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  await db.query(reportCardQueries.upsertGeneratedReportCard, [
    studentId,
    term,
    student.name,
    fileName,
    student.grade,
    student.school
  ]);

  if (error) throw new Error('Upload to storage failed');

  return 'Report card generated and uploaded';
};

/**
 * GET /report-cards/status?term=Term 1&school=SchoolName
 */
const getGeneratedReportCards = async (req, res) => {
  const { term, school } = req.query;

  if (!term || !school) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing query parameters: term and school are required'
    });
  }

  try {
    const { rows } = await db.query(
      reportCardQueries.selectGeneratedReportCards,
      [term, school]
    );

    return res.status(200).json({
      status: 'success',
      data: rows
    });
  } catch (err) {
    logger.error({ err }, "Error fetching report card status");
    return res.status(500).json({ status: 'failed', message: 'Error fetching report card status' });
  }
};

const getGeneratedReportCardsByStudentId = async (req, res) => {
  const { studentId, term, school } = req.query;

  if (!studentId || !term || !school) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing query parameters: studentId, term, and school are required'
    });
  }

  try {
    const { rows } = await db.query(
      reportCardQueries.selectGeneratedReportCardsByStudentId,
      [studentId, term, school]
    );

    return res.status(200).json({
      status: 'success',
      data: rows
    });
  } catch (err) {
    logger.error({ err }, "Error fetching generated report cards");
    return res.status(500).json({ status: 'failed', message: 'Error fetching report card status' });
  }
};

const deleteReportCard = async (req, res) => {
  const filePath = req.query.filePath;

  if (!filePath) {
    return res.status(400).json({ status: 'failed', message: 'filePath is required' });
  }

  try {
    // Delete from Supabase Storage
    const { error } = await supabase.storage
      .from('report-cards')
      .remove([filePath]);

    if (error) {
      logger.error({ err: error }, "Supabase delete error");
      return res.status(500).json({ status: 'failed', message: 'Failed to delete file from storage' });
    }

    // Optional: Remove from database table
    await db.query('DELETE FROM report_cards WHERE file_path = $1', [filePath]);

    return res.status(200).json({ status: 'success', message: 'Report card deleted' });
  } catch (err) {
    logger.error({ err }, "Delete report card error");
    return res.status(500).json({ status: 'failed', message: 'Server error' });
  }
};


module.exports = {
  generateReportCard,
  upsertFeedback,
  getFeedback,
  getClassFeedback,
  upsertBulkFeedback,
  generateReportCardsBulk,
  getGeneratedReportCards,
  deleteReportCard,
  getGeneratedReportCardsByStudentId,
  // exported for unit testing (Al Haadi T2 variant)
  mergeTermSubjects,
  computeTermSubjectGrades,
  resolveAlHaadiTermPair
};
