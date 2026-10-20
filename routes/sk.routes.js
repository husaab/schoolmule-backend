const express = require('express');
const router = express.Router();
const skController = require('../controllers/sk.controller');
const { requirePermission, requireStaffAccess } = require('../middleware/access');
const requireStudentAccess = require('../middleware/requireStudentAccess');

// RBAC. The SK set-up (what gets rated) is part of report cards; the
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
    studentIds: (req) => [req.body && req.body.studentId, ...((req.body && req.body.studentIds) || [])],
  }),
];

// Subjects & Standards
router.get('/subjects', skController.getSubjects);
router.post('/subjects', setup, skController.createSubject);
router.put('/subjects/:subjectId', setup, skController.updateSubject);
router.delete('/subjects/:subjectId', setup, skController.deleteSubjectHandler);

// Standards CRUD
router.post('/standards', setup, skController.createStandard);
router.put('/standards/:standardId', setup, skController.updateStandardHandler);
router.delete('/standards/:standardId', setup, skController.deleteStandardHandler);

// Standard Assessments (E/P/DV/EM/NI/N/A or E/G/S/NI/NA ratings)
router.get('/assessments/:studentId', paramStudent, skController.getAssessments);
router.post('/assessments/bulk', entryStudents, skController.bulkUpsertAssessments);

// Subject Comments (narrative - report card only)
router.get('/subject-comments/:studentId', paramStudent, skController.getSubjectComments);
router.post('/subject-comments/bulk', entryStudents, skController.bulkUpsertSubjectComments);

// Teacher Assistant
router.get('/teacher-assistant/:studentId', paramStudent, skController.getTeacherAssistant);
router.post('/teacher-assistant', bodyStudent, skController.upsertTeacherAssistant);

// Progress Report Comments (Academic Achievement / Socio-Emotional)
router.get('/progress-report-comments/:studentId', paramStudent, skController.getProgressReportComments);
router.post('/progress-report-comments/bulk', entryStudents, skController.bulkUpsertProgressReportComments);

// SK Progress Report Generation
router.post('/progress-report/generate', ...reportStudents, skController.generateProgressReport);
router.post('/progress-report/generate/bulk', ...reportStudents, skController.generateProgressReportsBulk);

// SK Report Card Generation
router.post('/report-card/generate', ...reportStudents, skController.generateReportCard);
router.post('/report-card/generate/bulk', ...reportStudents, skController.generateReportCardsBulk);

module.exports = router;
