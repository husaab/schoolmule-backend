// File: controllers/reportCard.controller.js

const db = require('../config/database');
const studentQueries = require('../queries/student.queries');
const assessmentQueries = require('../queries/assessment.queries');
const { getReportCardHTML } = require('../utils/reportCardTemplate');
const reportCardQueries = require('../queries/report_card.queries');
const { createPDFBuffer } = require('../utils/pdfGenerator');
const supabase = require('../config/supabaseClient'); // configure this file if not already
const logger = require('../logger');

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
    logger.error(err);
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
    logger.error(err);
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
    logger.error(err);
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
    logger.error('Bulk feedback transaction failed:', err);
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

  for (const studentId of studentIds) {
    try {
      const result = await generateSingleReportCard(studentId, term);
      successes.push({ studentId, message: result });
    } catch (err) {
      logger.error(`Failed to generate report card for ${studentId}`, err);
      failures.push({ studentId, error: err.message || 'Unknown error' });
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
 *   studentId: string
 * }
 */
const generateReportCard = async (req, res) => {
  const { studentId, term } = req.body;
    if (!studentId || !term) {
        return res.status(400).json({ status: 'failed', message: 'Missing studentId or term' });
    }

  try {
    // Fetch student info
    const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
    if (studentRows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Student not found' });
    }
    const student = studentRows[0];

    const { rows: teacherRows } = await db.query(`
        SELECT username
        FROM users
        WHERE user_id = $1
    `, [student.homeroom_teacher_id]);
    const teacherName = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

    // Calculate days of absence from general_attendance
    let daysOfAbsence = 0;
    try {
      const { rows: attendanceRows } = await db.query(`
        SELECT COUNT(*) as days_absent
        FROM general_attendance
        WHERE student_id = $1 AND status = 'absent'
      `, [studentId]);
      daysOfAbsence = parseInt(attendanceRows[0]?.days_absent || 0);
    } catch (err) {
      logger.warn('Could not fetch attendance data:', err.message);
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
      logger.debug('Schools table not available, using student.school as name');
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
      logger.debug('School assets not available');
    }

    // Fetch student assessments and compute average per subject
    const { rows: assessments } = await db.query(assessmentQueries.selectFinalGradesByStudent, [studentId]);
    const subjects = assessments.map(a => ({ subject: a.subject_name, grade: Number(a.final_grade).toFixed(1) }));

    // Fetch all class_ids for the student
    const { rows: classRows } = await db.query(`
    SELECT c.class_id, c.subject
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
    `, [studentId]);

    if (classRows.length === 0) {
    return res.status(404).json({ status: 'failed', message: 'Student not enrolled in any class' });
    }

    // Fetch all feedbacks for these classes for the given term
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

    // Render HTML → PDF
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

    const pdfBuffer = await createPDFBuffer(html);

    // Upload to Supabase bucket
    const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase(); // e.g., "Al Haadi Academy" → "ALHAADIACADEMY"
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

    if (error) {
      logger.error(error);
      return res.status(500).json({ status: 'failed', message: 'Upload to storage failed' });
    }

    return res.status(200).json({ status: 'success', message: 'Report card generated and uploaded' });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Internal server error' });
  }
};

const generateSingleReportCard = async (studentId, term) => {
  const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (studentRows.length === 0) throw new Error('Student not found');
  const student = studentRows[0];

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
      WHERE student_id = $1 AND status = 'absent'
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

  const { rows: assessments } = await db.query(assessmentQueries.selectFinalGradesByStudent, [studentId]);
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

  const pdfBuffer = await createPDFBuffer(html);
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
    logger.error(err);
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
    logger.error(err);
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
      console.error('Supabase delete error:', error);
      return res.status(500).json({ status: 'failed', message: 'Failed to delete file from storage' });
    }

    // Optional: Remove from database table
    await db.query('DELETE FROM report_cards WHERE file_path = $1', [filePath]);

    return res.status(200).json({ status: 'success', message: 'Report card deleted' });
  } catch (err) {
    console.error('Delete report card error:', err);
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
  getGeneratedReportCardsByStudentId
};
