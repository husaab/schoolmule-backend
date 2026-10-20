// routes/class.router.js

const express = require("express");
const { getAllClasses, getClassById, getClassesByGrade, getClassesByTeacher, createClass,
  updateClass, deleteClass, getStudentsInClass, getAssessmentsByClass, addStudentToClass, bulkEnrollStudentsToClass,
  removeStudentFromClass, bulkUnenrollStudentsFromClass, getClassesByTeacherId, duplicateClass,
  addTeacherToClass, removeTeacherFromClass } = require("../controllers/class.controller");

const { requireStaffAccess } = require("../middleware/access");
const requireClassOwnership = require("../middleware/requireClassOwnership");

const router = express.Router();

// RBAC. Staff only. Lists are scoped in the controller. Per class:
//   - its details: whoever teaches it, or works across classes (lists);
//   - its roster (with guardians' contacts): teachers of it, attendance for
//     every class, report cards, students or class management;
//   - its gradebook: teachers of it, or classes.all;
//   - changing it: teachers of it, or classes.manage (classes.all passes all).
router.use(requireStaffAccess);
const byParam = (name) => (req) => req.params[name];
const readsClass = (param) => requireClassOwnership.with({
  keys: ["classes.manage", "attendance.classes", "report_cards", "students", "users", "messages.all", "announcements.school", "scheduling"],
  classIdOf: byParam(param),
});
const readsRoster = requireClassOwnership.with({
  keys: ["attendance.classes", "report_cards", "students", "classes.manage"],
  classIdOf: byParam("classId"),
});
const managesClass = (param) => requireClassOwnership.with({ keys: ["classes.manage"], classIdOf: byParam(param) });

router.get("/", getAllClasses);
router.get("/:id", readsClass("id"), getClassById);
router.get("/grade/:grade", getClassesByGrade);
router.get("/teacher/:teacherName", getClassesByTeacher);
router.get("/teacher/id/:teacherId", getClassesByTeacherId);

router.post("/", createClass);
router.post("/:sourceClassId/duplicate", managesClass("sourceClassId"), duplicateClass);
router.patch("/:id", managesClass("id"), updateClass);
router.delete("/:id", managesClass("id"), deleteClass);

router.get("/:classId/assessments", requireClassOwnership, getAssessmentsByClass);

router.get("/:classId/students", readsRoster, getStudentsInClass);
// 2) Enroll a student
router.post("/:classId/students", managesClass("classId"), addStudentToClass);

// 3) Unenroll a student
router.delete("/:classId/students/:studentId", managesClass("classId"), removeStudentFromClass);

router.post("/:classId/students/bulk", managesClass("classId"), bulkEnrollStudentsToClass);
router.post("/:classId/students/bulk-unenroll", managesClass("classId"), bulkUnenrollStudentsFromClass);

// Additional teachers
router.post("/:classId/teachers", managesClass("classId"), addTeacherToClass);
router.delete("/:classId/teachers/:teacherId", managesClass("classId"), removeTeacherFromClass);

module.exports = router;
