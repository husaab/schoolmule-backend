const db = require("../config/database");
const skQueries = require("../queries/sk.queries");
const studentQueries = require("../queries/student.queries");
const reportCardQueries = require("../queries/reportCard.queries");
const progressReportsQueries = require("../queries/progressReports.queries");
const schoolAssetsQueries = require("../queries/schoolAssets.queries");
const { createPDFBuffer, launchPDFBrowser } = require('../utils/pdfGenerator');
const supabase = require('../config/supabaseClient');
const logger = require("../logger");
const { getAlHaadiProgressReportSKHTML } = require('../templates/alHaadiProgressReportSKTemplate');
const { getAlHaadiReportCardSKHTML } = require('../templates/alHaadiReportCardSKTemplate');

// ============================================================
// Helper: Nest flat subject+standard rows into structured objects
// ============================================================
function nestSubjectsAndStandards(rows) {
  const subjectMap = new Map();
  for (const row of rows) {
    if (!subjectMap.has(row.subject_id)) {
      subjectMap.set(row.subject_id, {
        subjectId: row.subject_id,
        documentType: row.document_type,
        name: row.subject_name,
        sortOrder: row.subject_sort_order,
        standards: []
      });
    }
    if (row.standard_id) {
      subjectMap.get(row.subject_id).standards.push({
        standardId: row.standard_id,
        name: row.standard_name,
        description: row.standard_description,
        sortOrder: row.standard_sort_order
      });
    }
  }
  return Array.from(subjectMap.values());
}

// ============================================================
// Helper: Fetch school info + assets (shared across generation fns)
// ============================================================
async function fetchSchoolData(schoolCode) {
  let schoolInfo = { name: schoolCode, address: '', phone: '', email: '' };
  let schoolAssets = { logoUrl: null, principalSignatureUrl: null, schoolStampUrl: null };

  try {
    const code = schoolCode.replace(/\s+/g, '').toUpperCase();
    const { rows: schoolRows } = await db.query(
      `SELECT school_id, name, address, phone, email FROM schools WHERE school_code = $1`,
      [code]
    );
    if (schoolRows.length > 0) {
      schoolInfo = schoolRows[0];

      // Fetch assets
      const { rows: assetRows } = await db.query(
        schoolAssetsQueries.getSchoolAssetsBySchoolId,
        [schoolRows[0].school_id]
      );
      if (assetRows.length > 0) {
        const assets = assetRows[0];
        if (assets.logo_path) {
          const { data } = await supabase.storage.from('school-assets').createSignedUrl(assets.logo_path, 3600);
          schoolAssets.logoUrl = data?.signedUrl || null;
        }
        if (assets.principal_signature_path) {
          const { data } = await supabase.storage.from('school-assets').createSignedUrl(assets.principal_signature_path, 3600);
          schoolAssets.principalSignatureUrl = data?.signedUrl || null;
        }
        if (assets.school_stamp_path) {
          const { data } = await supabase.storage.from('school-assets').createSignedUrl(assets.school_stamp_path, 3600);
          schoolAssets.schoolStampUrl = data?.signedUrl || null;
        }
      }
    }
  } catch (err) {
    logger.warn('Could not fetch school data, using fallback');
  }

  return { schoolInfo, schoolAssets };
}

// ============================================================
// GET /subjects?documentType=progress_report&school=ALHAADIACADEMY
// ============================================================
const getSubjects = async (req, res) => {
  try {
    const { documentType, school } = req.query;
    if (!documentType || !school) {
      return res.status(400).json({ status: 'error', message: 'documentType and school are required' });
    }

    const { rows } = await db.query(skQueries.getSubjectsByDocumentType, [documentType, school]);
    const subjects = nestSubjectsAndStandards(rows);

    res.json({ status: 'success', data: subjects });
  } catch (error) {
    logger.error('Error fetching SK subjects:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch subjects' });
  }
};

// ============================================================
// POST /subjects
// Body: { documentType, name, sortOrder, school }
// ============================================================
const createSubject = async (req, res) => {
  try {
    const { documentType, name, sortOrder, school } = req.body;
    if (!documentType || !name || !school) {
      return res.status(400).json({ status: 'error', message: 'documentType, name, and school are required' });
    }

    const { rows } = await db.query(skQueries.createSubject, [
      documentType, name, sortOrder ?? 0, school
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error creating SK subject:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create subject' });
  }
};

// ============================================================
// PUT /subjects/:subjectId
// Body: { name, sortOrder }
// ============================================================
const updateSubject = async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { name, sortOrder } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }

    const { rows } = await db.query(skQueries.updateSubject, [subjectId, name, sortOrder ?? 0]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error updating SK subject:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update subject' });
  }
};

// ============================================================
// DELETE /subjects/:subjectId
// ============================================================
const deleteSubjectHandler = async (req, res) => {
  try {
    const { subjectId } = req.params;
    await db.query(skQueries.deleteSubject, [subjectId]);
    res.json({ status: 'success', message: 'Subject deleted' });
  } catch (error) {
    logger.error('Error deleting SK subject:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete subject' });
  }
};

// ============================================================
// POST /standards
// Body: { subjectId, name, description, sortOrder }
// ============================================================
const createStandard = async (req, res) => {
  try {
    const { subjectId, name, description, sortOrder } = req.body;
    if (!subjectId || !name) {
      return res.status(400).json({ status: 'error', message: 'subjectId and name are required' });
    }

    const { rows } = await db.query(skQueries.createStandard, [
      subjectId, name, description || null, sortOrder ?? 0
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error creating SK standard:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create standard' });
  }
};

// ============================================================
// PUT /standards/:standardId
// Body: { name, description, sortOrder }
// ============================================================
const updateStandardHandler = async (req, res) => {
  try {
    const { standardId } = req.params;
    const { name, description, sortOrder } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }

    const { rows } = await db.query(skQueries.updateStandard, [
      standardId, name, description || null, sortOrder ?? 0
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error updating SK standard:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update standard' });
  }
};

// ============================================================
// DELETE /standards/:standardId
// ============================================================
const deleteStandardHandler = async (req, res) => {
  try {
    const { standardId } = req.params;
    await db.query(skQueries.deleteStandard, [standardId]);
    res.json({ status: 'success', message: 'Standard deleted' });
  } catch (error) {
    logger.error('Error deleting SK standard:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete standard' });
  }
};

// ============================================================
// GET /assessments/:studentId?term=X&documentType=Y
// ============================================================
const getAssessments = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term, documentType } = req.query;
    if (!term || !documentType) {
      return res.status(400).json({ status: 'error', message: 'term and documentType are required' });
    }

    const { rows } = await db.query(skQueries.getStandardAssessmentsForStudent, [studentId, term, documentType]);

    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      standardId: r.standard_id,
      term: r.term,
      rating: r.rating,
      assessedBy: r.assessed_by,
      updatedAt: r.updated_at,
      standardName: r.standard_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching SK assessments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch assessments' });
  }
};

// ============================================================
// POST /assessments/bulk
// Body: { entries: [{ studentId, standardId, term, rating, school, assessedBy }] }
// ============================================================
const bulkUpsertAssessments = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(skQueries.upsertStandardAssessment, [
        entry.studentId,
        entry.standardId,
        entry.term,
        entry.rating || null,
        entry.school,
        entry.assessedBy || null
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} assessments`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting SK assessments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save assessments' });
  }
};

// ============================================================
// GET /subject-comments/:studentId?term=X
// ============================================================
const getSubjectComments = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ status: 'error', message: 'term is required' });
    }

    const { rows } = await db.query(skQueries.getSubjectCommentsForStudent, [studentId, term]);
    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      subjectId: r.subject_id,
      term: r.term,
      comment: r.comment,
      subjectName: r.subject_name,
      updatedAt: r.updated_at
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching SK subject comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch subject comments' });
  }
};

// ============================================================
// POST /subject-comments/bulk
// Body: { entries: [{ studentId, subjectId, term, comment, school }] }
// ============================================================
const bulkUpsertSubjectComments = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(skQueries.upsertSubjectComment, [
        entry.studentId,
        entry.subjectId,
        entry.term,
        entry.comment || null,
        entry.school
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} comments`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting SK subject comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save subject comments' });
  }
};

// ============================================================
// GET /teacher-assistant/:studentId?term=X
// ============================================================
const getTeacherAssistant = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ status: 'error', message: 'term is required' });
    }

    const { rows } = await db.query(skQueries.getTeacherAssistant, [studentId, term]);
    res.json({
      status: 'success',
      data: rows[0] ? {
        id: rows[0].id,
        studentId: rows[0].student_id,
        teacherAssistantName: rows[0].teacher_assistant_name,
        term: rows[0].term
      } : null
    });
  } catch (error) {
    logger.error('Error fetching SK teacher assistant:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch teacher assistant' });
  }
};

// ============================================================
// POST /teacher-assistant
// Body: { studentId, teacherAssistantName, term, school }
// ============================================================
const upsertTeacherAssistant = async (req, res) => {
  try {
    const { studentId, teacherAssistantName, term, school } = req.body;
    if (!studentId || !term || !school) {
      return res.status(400).json({ status: 'error', message: 'studentId, term, and school are required' });
    }

    const { rows } = await db.query(skQueries.upsertTeacherAssistant, [
      studentId,
      teacherAssistantName || null,
      term,
      school
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error upserting SK teacher assistant:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save teacher assistant' });
  }
};

// ============================================================
// GET /progress-report-comments/:studentId?term=X
// ============================================================
const getProgressReportComments = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ status: 'error', message: 'term is required' });
    }

    const { rows } = await db.query(skQueries.getProgressReportCommentsForStudent, [studentId, term]);
    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      term: r.term,
      sectionType: r.section_type,
      comment: r.comment,
      updatedAt: r.updated_at
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching SK progress report comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch progress report comments' });
  }
};

// ============================================================
// POST /progress-report-comments/bulk
// Body: { entries: [{ studentId, term, sectionType, comment, school }] }
// ============================================================
const bulkUpsertProgressReportComments = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(skQueries.upsertProgressReportComment, [
        entry.studentId,
        entry.term,
        entry.sectionType,
        entry.comment || null,
        entry.school
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} comments`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting SK progress report comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save progress report comments' });
  }
};

// ============================================================
// SK Progress Report Generation
// ============================================================
const generateSingleSKProgressReport = async (studentId, term) => {
  // 1. Get student
  const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (studentRows.length === 0) throw new Error('Student not found');
  const student = studentRows[0];

  // 2. Get homeroom teacher
  const { rows: teacherRows } = await db.query(
    `SELECT username FROM users WHERE user_id = $1`,
    [student.homeroom_teacher_id]
  );
  const homeroomTeacher = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

  // 3. Get teacher assistant
  const { rows: taRows } = await db.query(skQueries.getTeacherAssistant, [studentId, term]);
  const teacherAssistant = taRows.length > 0 ? taRows[0].teacher_assistant_name : null;

  // 4. Get days of absence
  let daysOfAbsence = 0;
  try {
    const { rows: attendanceRows } = await db.query(
      `SELECT COUNT(*) as days_absent FROM general_attendance WHERE student_id = $1 AND status = 'ABSENT'`,
      [studentId]
    );
    daysOfAbsence = parseInt(attendanceRows[0]?.days_absent || 0);
  } catch (err) { /* fallback to 0 */ }

  // 5. Get school info + assets
  const { schoolInfo, schoolAssets } = await fetchSchoolData(student.school);

  // 6. Get subjects + standards
  const { rows: subjectRows } = await db.query(
    skQueries.getSubjectsByDocumentType,
    ['progress_report', student.school]
  );
  const subjects = nestSubjectsAndStandards(subjectRows);

  // 7. Get assessments (ratings)
  const { rows: assessmentRows } = await db.query(
    skQueries.getStandardAssessmentsForStudent,
    [studentId, term, 'progress_report']
  );
  // Build standardId -> rating map
  const ratingMap = {};
  for (const row of assessmentRows) {
    ratingMap[row.standard_id] = row.rating;
  }

  // 8. Get subject comments
  const { rows: commentRows } = await db.query(
    skQueries.getSubjectCommentsForStudent,
    [studentId, term]
  );
  const commentMap = {};
  for (const row of commentRows) {
    commentMap[row.subject_id] = row.comment;
  }

  // 9. Generate HTML
  const htmlContent = getAlHaadiProgressReportSKHTML({
    schoolInfo,
    schoolAssets,
    student: {
      name: student.name,
      grade: student.grade,
      oen: student.oen,
      homeroomTeacher,
      teacherAssistant,
      daysOfAbsence
    },
    subjects,
    ratingMap,
    commentMap,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  // 10. Generate PDF
  const pdfBuffer = await createPDFBuffer(htmlContent);

  // 11. Upload to Supabase
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_sk_progress_report.pdf`;

  const { error } = await supabase.storage
    .from('progress-reports')
    .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (error) {
    logger.error('Supabase upload error:', error);
    throw new Error('Upload to storage failed');
  }

  // 12. Save record
  await db.query(progressReportsQueries.createProgressReport, [
    studentId, term, student.name, student.grade, fileName, student.school
  ]);

  return { studentId, studentName: student.name, term, filePath: fileName };
};

// ============================================================
// SK Report Card Generation
// ============================================================
const generateSingleSKReportCard = async (studentId, term, opts = {}) => {
  // 1. Get student
  const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (studentRows.length === 0) throw new Error('Student not found');
  const student = studentRows[0];

  // 2. Get homeroom teacher
  const { rows: teacherRows } = await db.query(
    `SELECT username FROM users WHERE user_id = $1`,
    [student.homeroom_teacher_id]
  );
  const homeroomTeacher = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

  // 3. Get teacher assistant
  const { rows: taRows } = await db.query(skQueries.getTeacherAssistant, [studentId, term]);
  const teacherAssistant = taRows.length > 0 ? taRows[0].teacher_assistant_name : null;

  // 4. Days of absence
  let daysOfAbsence = 0;
  try {
    const { rows: attendanceRows } = await db.query(
      `SELECT COUNT(*) as days_absent FROM general_attendance WHERE student_id = $1 AND status = 'ABSENT'`,
      [studentId]
    );
    daysOfAbsence = parseInt(attendanceRows[0]?.days_absent || 0);
  } catch (err) { /* fallback to 0 */ }

  // 5. School info + assets
  const { schoolInfo, schoolAssets } = await fetchSchoolData(student.school);

  // 6. Get subjects + standards for report_card
  const { rows: subjectRows } = await db.query(
    skQueries.getSubjectsByDocumentType,
    ['report_card', student.school]
  );
  const subjects = nestSubjectsAndStandards(subjectRows);

  // 7. Get assessments for BOTH terms (report card shows Term 1 + Term 2)
  const ratingMapTerm1 = {};
  const ratingMapTerm2 = {};

  const { rows: t1Rows } = await db.query(
    skQueries.getStandardAssessmentsForStudent,
    [studentId, 'Term 1', 'report_card']
  );
  for (const row of t1Rows) ratingMapTerm1[row.standard_id] = row.rating;

  const { rows: t2Rows } = await db.query(
    skQueries.getStandardAssessmentsForStudent,
    [studentId, 'Term 2', 'report_card']
  );
  for (const row of t2Rows) ratingMapTerm2[row.standard_id] = row.rating;

  // 8. Get subject comments
  const { rows: commentRows } = await db.query(
    skQueries.getSubjectCommentsForStudent,
    [studentId, term]
  );
  const commentMap = {};
  for (const row of commentRows) {
    commentMap[row.subject_id] = row.comment;
  }

  // 9. Generate HTML
  const htmlContent = getAlHaadiReportCardSKHTML({
    schoolInfo,
    schoolAssets,
    student: {
      name: student.name,
      grade: student.grade,
      oen: student.oen,
      homeroomTeacher,
      teacherAssistant,
      daysOfAbsence
    },
    term,
    subjects,
    ratingMapTerm1,
    ratingMapTerm2,
    commentMap,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  // 10. Generate PDF
  const pdfBuffer = await createPDFBuffer(htmlContent, { browser: opts.browser });

  // 11. Upload to Supabase
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_sk_report_card.pdf`;

  const { error } = await supabase.storage
    .from('report-cards')
    .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (error) {
    logger.error('Supabase upload error:', error);
    throw new Error('Upload to storage failed');
  }

  // 12. Save record
  await db.query(reportCardQueries.upsertGeneratedReportCard, [
    studentId, term, student.name, fileName, student.grade, student.school
  ]);

  return { studentId, studentName: student.name, term, filePath: fileName };
};

// ============================================================
// POST /progress-report/generate
// Body: { studentId, term }
// ============================================================
const generateProgressReport = async (req, res) => {
  try {
    const { studentId, term } = req.body;
    if (!studentId || !term) {
      return res.status(400).json({ status: 'error', message: 'studentId and term are required' });
    }

    const result = await generateSingleSKProgressReport(studentId, term);
    res.json({ status: 'success', message: 'SK progress report generated', data: result });
  } catch (error) {
    logger.error('Error generating SK progress report:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Failed to generate progress report' });
  }
};

// ============================================================
// POST /progress-report/generate/bulk
// Body: { studentIds: [], term }
// ============================================================
const generateProgressReportsBulk = async (req, res) => {
  try {
    const { studentIds, term } = req.body;
    if (!studentIds || !Array.isArray(studentIds) || !term) {
      return res.status(400).json({ status: 'error', message: 'studentIds array and term are required' });
    }

    const generated = [];
    const failed = [];

    for (const studentId of studentIds) {
      try {
        const result = await generateSingleSKProgressReport(studentId, term);
        generated.push({ studentId, message: 'Generated successfully' });
      } catch (err) {
        failed.push({ studentId, error: err.message });
      }
    }

    res.json({ status: 'completed', term, generated, failed });
  } catch (error) {
    logger.error('Error in bulk SK progress report generation:', error);
    res.status(500).json({ status: 'error', message: 'Failed to generate progress reports' });
  }
};

// ============================================================
// POST /report-card/generate
// Body: { studentId, term }
// ============================================================
const generateReportCard = async (req, res) => {
  try {
    const { studentId, term } = req.body;
    if (!studentId || !term) {
      return res.status(400).json({ status: 'error', message: 'studentId and term are required' });
    }

    const result = await generateSingleSKReportCard(studentId, term);
    res.json({ status: 'success', message: 'SK report card generated', data: result });
  } catch (error) {
    logger.error('Error generating SK report card:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Failed to generate report card' });
  }
};

// ============================================================
// POST /report-card/generate/bulk
// Body: { studentIds: [], term }
// ============================================================
const generateReportCardsBulk = async (req, res) => {
  try {
    const { studentIds, term } = req.body;
    if (!studentIds || !Array.isArray(studentIds) || !term) {
      return res.status(400).json({ status: 'error', message: 'studentIds array and term are required' });
    }

    const generated = [];
    const failed = [];

    // One Chromium launch for the whole batch (see utils/pdfGenerator.js).
    let browser = null;
    try {
      browser = await launchPDFBrowser();
    } catch (err) {
      logger.error({ err }, 'Failed to launch shared PDF browser, falling back to per-student launches');
    }

    try {
      for (const studentId of studentIds) {
        try {
          await generateSingleSKReportCard(studentId, term, { browser });
          generated.push({ studentId, message: 'Generated successfully' });
        } catch (err) {
          failed.push({ studentId, error: err.message });
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

    res.json({ status: 'completed', term, generated, failed });
  } catch (error) {
    logger.error('Error in bulk SK report card generation:', error);
    res.status(500).json({ status: 'error', message: 'Failed to generate report cards' });
  }
};

module.exports = {
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubjectHandler,
  createStandard,
  updateStandardHandler,
  deleteStandardHandler,
  getAssessments,
  bulkUpsertAssessments,
  getSubjectComments,
  bulkUpsertSubjectComments,
  getTeacherAssistant,
  upsertTeacherAssistant,
  getProgressReportComments,
  bulkUpsertProgressReportComments,
  generateProgressReport,
  generateProgressReportsBulk,
  generateReportCard,
  generateReportCardsBulk,
  // Exported for use by other controllers when detecting SK
  generateSingleSKProgressReport,
  generateSingleSKReportCard
};
