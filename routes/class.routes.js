// routes/class.router.js

const express = require("express");
const { getAllClasses, getClassById, getClassesByGrade, getClassesByTeacher, createClass,
  updateClass, deleteClass, getStudentsInClass, getAssessmentsByClass,  addStudentToClass, bulkEnrollStudentsToClass,
  removeStudentFromClass, bulkUnenrollStudentsFromClass } = require("../controllers/class.controller");

const router = express.Router();


router.get("/", getAllClasses);
router.get("/:id", getClassById);
router.get("/grade/:grade", getClassesByGrade);
router.get("/teacher/:teacherName", getClassesByTeacher);

router.post("/", createClass);
router.patch("/:id", updateClass);
router.delete("/:id", deleteClass);

router.get("/:classId/assessments", getAssessmentsByClass);

router.get("/:classId/students", getStudentsInClass);
// 2) Enroll a student
router.post("/:classId/students", addStudentToClass);

// 3) Unenroll a student
router.delete("/:classId/students/:studentId", removeStudentFromClass);

router.post("/:classId/students/bulk", bulkEnrollStudentsToClass);
router.post("/:classId/students/bulk-unenroll", bulkUnenrollStudentsFromClass);

module.exports = router;
