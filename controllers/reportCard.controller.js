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

    const { rows: teacherRows } = await db.query(    `
        SELECT username
        FROM users
        WHERE user_id = $1
    `, [student.homeroom_teacher_id]);
    const teacherName = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

    // Fetch student assessments and compute average per subject
    const { rows: assessments } = await db.query(assessmentQueries.selectFinalGradesByStudent, [studentId]);
    const subjects = assessments.map(a => ({ subject: a.subject_name, grade: Math.round(a.final_grade) }));

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
        schoolName: student.school,
        term,
        student: {
            name: student.name,
            grade: student.grade,
            oen: student.oen,
            homeroomTeacher: teacherName
        },
        subjects,
        feedbacks: feedbackRows
        });

    const pdfBuffer = await createPDFBuffer(html);

    // Upload to Supabase bucket
    const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase(); // e.g., "Al Haadi Academy" → "ALHAADIACADEMY"
    const fileName = `${schoolFolder}/${studentId}_report_card.pdf`;

    const { error } = await supabase
      .storage
      .from('report-cards')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

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

module.exports = {
  generateReportCard,
  upsertFeedback,
  getFeedback
};
