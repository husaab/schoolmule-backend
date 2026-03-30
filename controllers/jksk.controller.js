const db = require("../config/database");
const jkskQueries = require("../queries/jksk.queries");
const studentQueries = require("../queries/student.queries");
const reportCardQueries = require("../queries/report_card.queries");
const progressReportsQueries = require("../queries/progressReports.queries");
const schoolAssetsQueries = require("../queries/school-assets.queries");
const { createPDFBuffer } = require('../utils/pdfGenerator');
const supabase = require('../config/supabaseClient');
const logger = require("../logger");
const { getAlHaadiProgressReportJKSKHTML } = require('../templates/alHaadiProgressReportJKSKTemplate');
const { getAlHaadiReportCardJKSKHTML } = require('../templates/alHaadiReportCardJKSKTemplate');

// ============================================================
// Helper: Nest flat domain+skill rows into structured objects
// ============================================================
function nestDomainsAndSkills(rows) {
  const domainMap = new Map();
  for (const row of rows) {
    if (!domainMap.has(row.domain_id)) {
      domainMap.set(row.domain_id, {
        domainId: row.domain_id,
        documentType: row.document_type,
        name: row.domain_name,
        sortOrder: row.domain_sort_order,
        skills: []
      });
    }
    if (row.skill_id) {
      domainMap.get(row.domain_id).skills.push({
        skillId: row.skill_id,
        name: row.skill_name,
        description: row.skill_description,
        sortOrder: row.skill_sort_order
      });
    }
  }
  return Array.from(domainMap.values());
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
// GET /domains?documentType=progress_report&school=ALHAADIACADEMY
// ============================================================
const getDomains = async (req, res) => {
  try {
    const { documentType, school } = req.query;
    if (!documentType || !school) {
      return res.status(400).json({ status: 'error', message: 'documentType and school are required' });
    }

    const { rows } = await db.query(jkskQueries.getSkillDomainsByDocumentType, [documentType, school]);
    const domains = nestDomainsAndSkills(rows);

    res.json({ status: 'success', data: domains });
  } catch (error) {
    logger.error('Error fetching JK/SK domains:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch domains' });
  }
};

// ============================================================
// POST /domains
// Body: { documentType, name, sortOrder, school }
// ============================================================
const createDomain = async (req, res) => {
  try {
    const { documentType, name, sortOrder, school } = req.body;
    if (!documentType || !name || !school) {
      return res.status(400).json({ status: 'error', message: 'documentType, name, and school are required' });
    }

    const { rows } = await db.query(jkskQueries.createDomain, [
      documentType, name, sortOrder ?? 0, school
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error creating JK/SK domain:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create domain' });
  }
};

// ============================================================
// PUT /domains/:domainId
// Body: { name, sortOrder }
// ============================================================
const updateDomain = async (req, res) => {
  try {
    const { domainId } = req.params;
    const { name, sortOrder } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }

    const { rows } = await db.query(jkskQueries.updateDomain, [domainId, name, sortOrder ?? 0]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error updating JK/SK domain:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update domain' });
  }
};

// ============================================================
// DELETE /domains/:domainId
// ============================================================
const deleteDomainHandler = async (req, res) => {
  try {
    const { domainId } = req.params;
    await db.query(jkskQueries.deleteDomain, [domainId]);
    res.json({ status: 'success', message: 'Domain deleted' });
  } catch (error) {
    logger.error('Error deleting JK/SK domain:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete domain' });
  }
};

// ============================================================
// POST /skills
// Body: { domainId, name, description, sortOrder }
// ============================================================
const createSkill = async (req, res) => {
  try {
    const { domainId, name, description, sortOrder } = req.body;
    if (!domainId || !name) {
      return res.status(400).json({ status: 'error', message: 'domainId and name are required' });
    }

    const { rows } = await db.query(jkskQueries.createSkill, [
      domainId, name, description || null, sortOrder ?? 0
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error creating JK/SK skill:', error);
    res.status(500).json({ status: 'error', message: 'Failed to create skill' });
  }
};

// ============================================================
// PUT /skills/:skillId
// Body: { name, description, sortOrder }
// ============================================================
const updateSkillHandler = async (req, res) => {
  try {
    const { skillId } = req.params;
    const { name, description, sortOrder } = req.body;
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }

    const { rows } = await db.query(jkskQueries.updateSkill, [
      skillId, name, description || null, sortOrder ?? 0
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error updating JK/SK skill:', error);
    res.status(500).json({ status: 'error', message: 'Failed to update skill' });
  }
};

// ============================================================
// DELETE /skills/:skillId
// ============================================================
const deleteSkillHandler = async (req, res) => {
  try {
    const { skillId } = req.params;
    await db.query(jkskQueries.deleteSkill, [skillId]);
    res.json({ status: 'success', message: 'Skill deleted' });
  } catch (error) {
    logger.error('Error deleting JK/SK skill:', error);
    res.status(500).json({ status: 'error', message: 'Failed to delete skill' });
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

    const { rows } = await db.query(jkskQueries.getSkillAssessmentsForStudent, [studentId, term, documentType]);

    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      skillId: r.skill_id,
      term: r.term,
      rating: r.rating,
      assessedBy: r.assessed_by,
      updatedAt: r.updated_at,
      skillName: r.skill_name,
      domainId: r.domain_id,
      domainName: r.domain_name
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching JK/SK assessments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch assessments' });
  }
};

// ============================================================
// POST /assessments/bulk
// Body: { entries: [{ studentId, skillId, term, rating, school, assessedBy }] }
// ============================================================
const bulkUpsertAssessments = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(jkskQueries.upsertSkillAssessment, [
        entry.studentId,
        entry.skillId,
        entry.term,
        entry.rating || null,
        entry.school,
        entry.assessedBy || null
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} assessments`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting JK/SK assessments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save assessments' });
  }
};

// ============================================================
// GET /learning-skills/:studentId?term=X
// ============================================================
const getLearningSkills = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ status: 'error', message: 'term is required' });
    }

    const { rows } = await db.query(jkskQueries.getLearningSkillsForStudent, [studentId, term]);
    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      term: r.term,
      skillName: r.skill_name,
      rating: r.rating,
      updatedAt: r.updated_at
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching JK/SK learning skills:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch learning skills' });
  }
};

// ============================================================
// POST /learning-skills/bulk
// Body: { entries: [{ studentId, term, skillName, rating, school }] }
// ============================================================
const bulkUpsertLearningSkills = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(jkskQueries.upsertLearningSkill, [
        entry.studentId,
        entry.term,
        entry.skillName,
        entry.rating || null,
        entry.school
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} learning skills`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting JK/SK learning skills:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save learning skills' });
  }
};

// ============================================================
// GET /domain-comments/:studentId?term=X
// ============================================================
const getDomainComments = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ status: 'error', message: 'term is required' });
    }

    const { rows } = await db.query(jkskQueries.getDomainCommentsForStudent, [studentId, term]);
    const data = rows.map(r => ({
      id: r.id,
      studentId: r.student_id,
      domainId: r.domain_id,
      term: r.term,
      comment: r.comment,
      domainName: r.domain_name,
      updatedAt: r.updated_at
    }));

    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Error fetching JK/SK domain comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch domain comments' });
  }
};

// ============================================================
// POST /domain-comments/bulk
// Body: { entries: [{ studentId, domainId, term, comment, school }] }
// ============================================================
const bulkUpsertDomainComments = async (req, res) => {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', message: 'entries array is required' });
    }

    const results = [];
    for (const entry of entries) {
      const { rows } = await db.query(jkskQueries.upsertDomainComment, [
        entry.studentId,
        entry.domainId,
        entry.term,
        entry.comment || null,
        entry.school
      ]);
      results.push(rows[0]);
    }

    res.json({ status: 'success', message: `Saved ${results.length} comments`, data: { updated: results.length } });
  } catch (error) {
    logger.error('Error bulk upserting JK/SK domain comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save domain comments' });
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

    const { rows } = await db.query(jkskQueries.getTeacherAssistant, [studentId, term]);
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
    logger.error('Error fetching JK/SK teacher assistant:', error);
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

    const { rows } = await db.query(jkskQueries.upsertTeacherAssistant, [
      studentId,
      teacherAssistantName || null,
      term,
      school
    ]);

    res.json({ status: 'success', data: rows[0] });
  } catch (error) {
    logger.error('Error upserting JK/SK teacher assistant:', error);
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

    const { rows } = await db.query(jkskQueries.getProgressReportCommentsForStudent, [studentId, term]);
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
    logger.error('Error fetching JK/SK progress report comments:', error);
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
      const { rows } = await db.query(jkskQueries.upsertProgressReportComment, [
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
    logger.error('Error bulk upserting JK/SK progress report comments:', error);
    res.status(500).json({ status: 'error', message: 'Failed to save progress report comments' });
  }
};

// ============================================================
// JK/SK Progress Report Generation
// ============================================================
const generateSingleJKSKProgressReport = async (studentId, term) => {
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
  const { rows: taRows } = await db.query(jkskQueries.getTeacherAssistant, [studentId, term]);
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

  // 6. Get domains + skills
  const { rows: domainRows } = await db.query(
    jkskQueries.getSkillDomainsByDocumentType,
    ['progress_report', student.school]
  );
  const domains = nestDomainsAndSkills(domainRows);

  // 7. Get assessments (ratings)
  const { rows: assessmentRows } = await db.query(
    jkskQueries.getSkillAssessmentsForStudent,
    [studentId, term, 'progress_report']
  );
  // Build skillId -> rating map
  const ratingMap = {};
  for (const row of assessmentRows) {
    ratingMap[row.skill_id] = row.rating;
  }

  // 8. Generate HTML
  const htmlContent = getAlHaadiProgressReportJKSKHTML({
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
    domains,
    ratingMap,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  // 9. Generate PDF
  const pdfBuffer = await createPDFBuffer(htmlContent);

  // 10. Upload to Supabase
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_jksk_progress_report.pdf`;

  const { error } = await supabase.storage
    .from('progress-reports')
    .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (error) {
    logger.error('Supabase upload error:', error);
    throw new Error('Upload to storage failed');
  }

  // 11. Save record
  await db.query(progressReportsQueries.createProgressReport, [
    studentId, term, student.name, student.grade, fileName, student.school
  ]);

  return { studentId, studentName: student.name, term, filePath: fileName };
};

// ============================================================
// JK/SK Report Card Generation
// ============================================================
const generateSingleJKSKReportCard = async (studentId, term) => {
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
  const { rows: taRows } = await db.query(jkskQueries.getTeacherAssistant, [studentId, term]);
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

  // 6. Get domains + skills for report_card
  const { rows: domainRows } = await db.query(
    jkskQueries.getSkillDomainsByDocumentType,
    ['report_card', student.school]
  );
  const domains = nestDomainsAndSkills(domainRows);

  // 7. Get assessments for BOTH terms (report card shows Term 1 + Term 2)
  const ratingMapTerm1 = {};
  const ratingMapTerm2 = {};

  const { rows: t1Rows } = await db.query(
    jkskQueries.getSkillAssessmentsForStudent,
    [studentId, 'Term 1', 'report_card']
  );
  for (const row of t1Rows) ratingMapTerm1[row.skill_id] = row.rating;

  const { rows: t2Rows } = await db.query(
    jkskQueries.getSkillAssessmentsForStudent,
    [studentId, 'Term 2', 'report_card']
  );
  for (const row of t2Rows) ratingMapTerm2[row.skill_id] = row.rating;

  // 8. Get domain comments
  const { rows: commentRows } = await db.query(
    jkskQueries.getDomainCommentsForStudent,
    [studentId, term]
  );
  const commentMap = {};
  for (const row of commentRows) {
    commentMap[row.domain_id] = row.comment;
  }

  // 9. Get learning skills
  const { rows: learningSkillRows } = await db.query(
    jkskQueries.getLearningSkillsForStudent,
    [studentId, term]
  );
  const learningSkills = {};
  for (const row of learningSkillRows) {
    learningSkills[row.skill_name] = row.rating;
  }

  // 10. Generate HTML
  const htmlContent = getAlHaadiReportCardJKSKHTML({
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
    domains,
    ratingMapTerm1,
    ratingMapTerm2,
    commentMap,
    learningSkills,
    generatedDate: new Date().toLocaleDateString('en-CA')
  });

  // 11. Generate PDF
  const pdfBuffer = await createPDFBuffer(htmlContent);

  // 12. Upload to Supabase
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_jksk_report_card.pdf`;

  const { error } = await supabase.storage
    .from('report-cards')
    .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (error) {
    logger.error('Supabase upload error:', error);
    throw new Error('Upload to storage failed');
  }

  // 13. Save record
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

    const result = await generateSingleJKSKProgressReport(studentId, term);
    res.json({ status: 'success', message: 'JK/SK progress report generated', data: result });
  } catch (error) {
    logger.error('Error generating JK/SK progress report:', error);
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
        const result = await generateSingleJKSKProgressReport(studentId, term);
        generated.push({ studentId, message: 'Generated successfully' });
      } catch (err) {
        failed.push({ studentId, error: err.message });
      }
    }

    res.json({ status: 'completed', term, generated, failed });
  } catch (error) {
    logger.error('Error in bulk JK/SK progress report generation:', error);
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

    const result = await generateSingleJKSKReportCard(studentId, term);
    res.json({ status: 'success', message: 'JK/SK report card generated', data: result });
  } catch (error) {
    logger.error('Error generating JK/SK report card:', error);
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

    for (const studentId of studentIds) {
      try {
        await generateSingleJKSKReportCard(studentId, term);
        generated.push({ studentId, message: 'Generated successfully' });
      } catch (err) {
        failed.push({ studentId, error: err.message });
      }
    }

    res.json({ status: 'completed', term, generated, failed });
  } catch (error) {
    logger.error('Error in bulk JK/SK report card generation:', error);
    res.status(500).json({ status: 'error', message: 'Failed to generate report cards' });
  }
};

module.exports = {
  getDomains,
  createDomain,
  updateDomain,
  deleteDomainHandler,
  createSkill,
  updateSkillHandler,
  deleteSkillHandler,
  getAssessments,
  bulkUpsertAssessments,
  getLearningSkills,
  bulkUpsertLearningSkills,
  getDomainComments,
  bulkUpsertDomainComments,
  getTeacherAssistant,
  upsertTeacherAssistant,
  getProgressReportComments,
  bulkUpsertProgressReportComments,
  generateProgressReport,
  generateProgressReportsBulk,
  generateReportCard,
  generateReportCardsBulk,
  // Exported for use by existing controllers when detecting JK/SK
  generateSingleJKSKProgressReport,
  generateSingleJKSKReportCard
};
