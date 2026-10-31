const db = require("../config/database");
const reportsQueries = require("../queries/reports.queries");
const logger = require("../logger");
const { PDFDocument } = require("pdf-lib");
const { createPDFBuffer, launchPDFBrowser } = require("../utils/pdfGenerator");
const { getStudentSummaryHTML } = require("../templates/studentSummaryTemplate");
const { getStudentSummaryHTMLHorizontal } = require("../templates/studentSummaryTemplateHorizontal");
const { getStudentTermSummaryHTML } = require("../templates/studentTermSummaryTemplate");
const { computeClassGrade } = require("../services/gradeEngine");
const { classAccessGranted } = require("../middleware/access");

// Days absent, counted the same way on every summary page.
const DAYS_ABSENT_SQL = `
  SELECT COUNT(*) as days_absent
  FROM general_attendance
  WHERE student_id = $1 AND status = 'ABSENT'
`;

const countDaysAbsent = async (studentId) => {
  try {
    const { rows } = await db.query(DAYS_ABSENT_SQL, [studentId]);
    return parseInt(rows[0]?.days_absent || 0);
  } catch (err) {
    logger.warn('Could not fetch attendance data:', err.message);
    return 0;
  }
};

const summaryTemplateFor = (orientation) =>
  orientation === 'vertical' ? getStudentSummaryHTML : getStudentSummaryHTMLHorizontal;

const groupByClass = (rows) => {
  const byClass = new Map();
  for (const row of rows) {
    if (!byClass.has(row.class_id)) byClass.set(row.class_id, []);
    byClass.get(row.class_id).push(row);
  }
  return byClass;
};

const generateStudentSummaryReport = async (req, res) => {
  try {
    const { studentId, classId } = req.params;

    // Validate required parameters
    if (!studentId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and Class ID are required'
      });
    }

    logger.info(`Generating student summary report for student ${studentId} in class ${classId}`);

    // 1. Get student information
    logger.info(`Fetching student with ID: ${studentId}`);
    const studentResult = await db.query(reportsQueries.getStudentById, [studentId]);
    if (studentResult.rows.length === 0) {
      logger.error(`Student not found: ${studentId}`);
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    const student = studentResult.rows[0];
    logger.info(`Student found: ${student.name}`);

    // 2. Get class information
    logger.info(`Fetching class with ID: ${classId}`);
    const classResult = await db.query(reportsQueries.getClassInfo, [classId]);
    if (classResult.rows.length === 0) {
      logger.error(`Class not found: ${classId}`);
      return res.status(404).json({
        status: 'error',
        message: 'Class not found'
      });
    }
    const classInfo = classResult.rows[0];
    logger.info(`Class found: ${classInfo.subject} - Teacher: ${classInfo.teacher_name}`);

    // 3. Verify student is enrolled in the class
    logger.info(`Verifying student enrollment in class`);
    const enrollmentResult = await db.query(reportsQueries.verifyStudentEnrollment, [studentId, classId]);
    if (enrollmentResult.rows.length === 0) {
      logger.error(`Student ${student.name} is not enrolled in class ${classInfo.subject}`);
      return res.status(400).json({
        status: 'error',
        message: 'Student is not enrolled in this class'
      });
    }
    logger.info(`Student enrollment verified`);

    // 4. Get school information
    logger.info(`Fetching school information for school: ${student.school}`);
    const schoolResult = await db.query(reportsQueries.getSchoolInfoByCode, [student.school]);
    if (schoolResult.rows.length === 0) {
      logger.error(`School information not found for school: ${student.school}`);
      return res.status(404).json({
        status: 'error',
        message: 'School information not found'
      });
    }
    const schoolInfo = schoolResult.rows[0];
    logger.info(`School information found: ${schoolInfo.name}`);

    // 5. Get term information
    const termResult = await db.query(reportsQueries.getTermById, [classInfo.term_id]);
    if (termResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Term information not found'
      });
    }
    const term = termResult.rows[0];

    // 6. Get assessments for the class
    const assessmentsResult = await db.query(reportsQueries.getAssessmentsByClass, [classId]);
    const assessments = assessmentsResult.rows;

    // 7. Get student's scores for these assessments
    const scoresResult = await db.query(reportsQueries.getStudentAssessmentScores, [studentId, classId]);
    const studentScores = scoresResult.rows;

    // 8. Grade via the shared engine: graded work only (null = no evidence yet)
    const { pct: calculatedGrade, coverage } = computeClassGrade(assessments, studentScores);

    // 9. Get attendance data (days of absence)
    const daysOfAbsence = await countDaysAbsent(studentId);

    // 10. Generate PDF HTML (horizontal layout by default, use ?orientation=vertical for vertical)
    const orientation = req.query.orientation || 'horizontal';
    const templateFn = summaryTemplateFor(orientation);

    const htmlContent = templateFn({
      schoolInfo,
      student,
      classInfo,
      term,
      assessments,
      studentAssessments: studentScores,
      calculatedGrade,
      coverage,
      daysOfAbsence
    });

    // 11. Generate PDF buffer
    const pdfBuffer = await createPDFBuffer(htmlContent);

    // 12. Set response headers for PDF download
    const filename = `${student.name.replace(/\s+/g, '_')}_${classInfo.subject}_${term.name}_Summary.pdf`;
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // 13. Send PDF buffer
    res.send(pdfBuffer);

    logger.info(`Student summary report generated successfully for student ${studentId} in class ${classId}`);

  } catch (error) {
    logger.error('Error generating student summary report:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate student summary report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * POST /api/reports/student-summary/:studentId?termId=&orientation=
 * One student's summary for every class they're in that term, as one PDF: a
 * first page with each class's term grade, then each class's own summary page
 * (the same page the one-class report prints). A teacher without report_cards
 * gets only the classes they teach; none of them is a 403.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const generateStudentTermSummaryReport = async (req, res) => {
  const { studentId } = req.params;
  const termId = req.query.termId;
  if (!studentId || typeof termId !== 'string' || !termId) {
    return res.status(400).json({ status: 'error', message: 'Student ID and term ID are required' });
  }
  // A malformed id would fail the uuid cast as a 500; it's simply not found.
  if (!UUID.test(studentId)) return res.status(404).json({ status: 'error', message: 'Student not found' });
  if (!UUID.test(termId)) return res.status(404).json({ status: 'error', message: 'Term not found' });

  let browser = null;
  try {
    const school = req.user.school;
    const studentResult = await db.query(reportsQueries.getStudentById, [studentId]);
    const student = studentResult.rows[0];
    if (!student || student.school !== school) {
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }

    const termResult = await db.query(reportsQueries.getTermInSchool, [termId, school]);
    const term = termResult.rows[0];
    if (!term) return res.status(404).json({ status: 'error', message: 'Term not found' });

    const enrolled = (await db.query(reportsQueries.getStudentClassesForTerm, [studentId, termId, req.user.userId])).rows;
    if (enrolled.length === 0) {
      return res.status(404).json({ status: 'error', message: `${student.name} isn't in any ${term.name} classes` });
    }
    const classes = enrolled.filter((cls) => classAccessGranted(req, cls, ['report_cards']));
    if (classes.length === 0) {
      return res.status(403).json({ status: 'failed', message: 'Not authorized for these classes' });
    }

    const schoolResult = await db.query(reportsQueries.getSchoolInfoByCode, [student.school]);
    const schoolInfo = schoolResult.rows[0];
    if (!schoolInfo) return res.status(404).json({ status: 'error', message: 'School information not found' });

    const classIds = classes.map((c) => c.class_id);
    const [assessmentsResult, scoresResult, daysOfAbsence] = await Promise.all([
      db.query(reportsQueries.getAssessmentsByClasses, [classIds]),
      db.query(reportsQueries.getStudentAssessmentScoresByClasses, [studentId, classIds]),
      countDaysAbsent(studentId),
    ]);
    const assessmentsByClass = groupByClass(assessmentsResult.rows);
    const scoresByClass = groupByClass(scoresResult.rows);

    const orientation = req.query.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const templateFn = summaryTemplateFor(orientation);
    const pages = classes.map((classInfo) => {
      const assessments = assessmentsByClass.get(classInfo.class_id) || [];
      const studentAssessments = scoresByClass.get(classInfo.class_id) || [];
      const { pct, coverage } = computeClassGrade(assessments, studentAssessments);
      return { classInfo, assessments, studentAssessments, pct, coverage };
    });

    const coverHtml = getStudentTermSummaryHTML({
      schoolInfo,
      student,
      term,
      classes: pages.map((p) => ({
        subject: p.classInfo.subject,
        teacherName: p.classInfo.teacher_name,
        pct: p.pct,
        coverage: p.assessments.length > 0 ? p.coverage : null,
      })),
      daysOfAbsence,
      orientation,
    });
    const classHtmls = pages.map((p) => templateFn({
      schoolInfo,
      student,
      classInfo: p.classInfo,
      term,
      assessments: p.assessments,
      studentAssessments: p.studentAssessments,
      calculatedGrade: p.pct,
      coverage: p.coverage,
      daysOfAbsence,
    }));

    // One Chromium for every page; each class starts on a fresh page.
    browser = await launchPDFBrowser();
    const merged = await PDFDocument.create();
    for (const html of [coverHtml, ...classHtmls]) {
      const doc = await PDFDocument.load(await createPDFBuffer(html, { browser }));
      const copied = await merged.copyPages(doc, doc.getPageIndices());
      copied.forEach((page) => merged.addPage(page));
    }
    const pdfBuffer = Buffer.from(await merged.save());

    // Header-safe: a name with accents or another script would make setHeader throw.
    const safe = (text) => String(text).replace(/[^A-Za-z0-9.-]+/g, '_');
    const filename = `${safe(student.name)}_${safe(term.name)}_All_classes_Summary.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
    logger.info(`All-classes summary generated for student ${studentId}, term ${termId} (${classes.length} classes)`);
  } catch (error) {
    logger.error({ err: error }, 'Error generating all-classes student summary');
    res.status(500).json({ status: 'error', message: 'Failed to generate student summary report' });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};

module.exports = {
  generateStudentSummaryReport,
  generateStudentTermSummaryReport,
};