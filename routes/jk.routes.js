const express = require('express');
const router = express.Router();
const jkController = require('../controllers/jk.controller');
const { requirePermission, requireStaffAccess } = require('../middleware/access');
const requireStudentAccess = require('../middleware/requireStudentAccess');

// RBAC. The JK set-up (what gets rated) is part of report cards; the
// ratings and comments of a student are their gradebook: the teachers who
// teach them, or classes.all; generating reports is report_cards, for students
// of the caller's school.
router.use(requireStaffAccess);
const setup = requirePermission('report_cards');
const paramStudent = requireStudentAccess({ studentIds: (req) => [req.params.studentId] });
const bodyStudent = requireStudentAccess({ studentIds: (req) => [req.body && req.body.studentId] });
const entryStudents = requireStudentAccess({
  studentIds: (req) => ((req.body && req.body.entries) || []).map((e) => e && e.studentId),
});
const reportStudents = [
  requirePermission('report_cards'),
  requireStudentAccess({
    keys: ['report_cards'],
    studentIds: (req) => [req.body && req.body.studentId, ...(Array.isArray(req.body && req.body.studentIds) ? req.body.studentIds : [])],
  }),
];

// Domains & Skills
router.get('/domains', jkController.getDomains);
router.post('/domains', setup, jkController.createDomain);
router.put('/domains/:domainId', setup, jkController.updateDomain);
router.delete('/domains/:domainId', setup, jkController.deleteDomainHandler);

// Skills CRUD
router.post('/skills', setup, jkController.createSkill);
router.put('/skills/:skillId', setup, jkController.updateSkillHandler);
router.delete('/skills/:skillId', setup, jkController.deleteSkillHandler);

// Skill Assessments (D/B/I/N or BG/DV/NI ratings)
router.get('/assessments/:studentId', paramStudent, jkController.getAssessments);
router.post('/assessments/bulk', entryStudents, jkController.bulkUpsertAssessments);

// Learning Skills (E/G/S/N - report card only)
router.get('/learning-skills/:studentId', paramStudent, jkController.getLearningSkills);
router.post('/learning-skills/bulk', entryStudents, jkController.bulkUpsertLearningSkills);

// Domain Comments (narrative - report card only)
router.get('/domain-comments/:studentId', paramStudent, jkController.getDomainComments);
router.post('/domain-comments/bulk', entryStudents, jkController.bulkUpsertDomainComments);

// Progress Report Comments (Academic Achievement / Socio-Emotional)
router.get('/progress-report-comments/:studentId', paramStudent, jkController.getProgressReportComments);
router.post('/progress-report-comments/bulk', entryStudents, jkController.bulkUpsertProgressReportComments);

// Teacher Assistant
router.get('/teacher-assistant/:studentId', paramStudent, jkController.getTeacherAssistant);
router.post('/teacher-assistant', bodyStudent, jkController.upsertTeacherAssistant);

// JK Progress Report Generation
router.post('/progress-report/generate', ...reportStudents, jkController.generateProgressReport);
router.post('/progress-report/generate/bulk', ...reportStudents, jkController.generateProgressReportsBulk);

// JK Report Card Generation
router.post('/report-card/generate', ...reportStudents, jkController.generateReportCard);
router.post('/report-card/generate/bulk', ...reportStudents, jkController.generateReportCardsBulk);

module.exports = router;
