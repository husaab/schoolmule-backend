const express = require("express");
const { 
  getAllStudents, 
  getStudentById, 
  updateStudent, 
  createStudent, 
  deleteStudent,
  getDeletedStudents,
  restoreStudent,
  getArchivedStudents,
  archiveStudent,
  unarchiveStudent,
  getAllStudentsWithArchived
} = require("../controllers/student.controller");
const { getStudentOverview, getStudentGrades } = require("../controllers/studentOverview.controller");
const requireStaff = require("../middleware/requireStaff");
const { requirePermission } = require("../middleware/access");

const router = express.Router();

// Staff only: students and parents never read or edit the roster here
// (parents see their own children through /api/parent-portal). Every :id is
// also pinned to the caller's school in the controller.
router.use(requireStaff);

// RBAC. The roster is read by every area that works with students (pickers on
// attendance, report cards, forms, messaging, enrollment, student accounts);
// changing it is `students`. The profile's grades are analytics.
const readsRoster = requirePermission(
  "students", "attendance.daily", "attendance.classes", "report_cards", "users", "forms",
  "classes.all", "classes.manage", "messages.all", "announcements.school",
);
const managesStudents = requirePermission("students");

router.get("/", readsRoster, getAllStudents);
router.get("/archived", readsRoster, getArchivedStudents);
router.get("/all", readsRoster, getAllStudentsWithArchived);
// Recently deleted: whoever may delete may see and restore.
router.get("/deleted", managesStudents, getDeletedStudents);
router.get("/:id", readsRoster, getStudentById);
// The staff student profile (/students/[id]).
router.get("/:id/overview", managesStudents, getStudentOverview);
router.get("/:id/grades", requirePermission("analytics"), getStudentGrades);
router.patch("/:id", managesStudents, updateStudent);
router.post("/", managesStudents, createStudent);
router.delete("/:id", managesStudents, deleteStudent);
router.post("/:id/archive", managesStudents, archiveStudent);
router.post("/:id/unarchive", managesStudents, unarchiveStudent);
router.post("/:id/restore", managesStudents, restoreStudent);

module.exports = router;