// routes/class.router.js

const express = require("express");
const { getAllClasses, getClassById, getClassesByGrade, getClassesByTeacher, createClass,
  updateClass, deleteClass, getStudentsInClass, getAssessmentsByClass } = require("../controllers/class.controller");

const router = express.Router();


router.get("/", getAllClasses);
router.get("/:id", getClassById);
router.get("/grade/:grade", getClassesByGrade);
router.get("/teacher/:teacherName", getClassesByTeacher);

router.post("/", createClass);
router.patch("/:id", updateClass);
router.delete("/:id", deleteClass);

router.get("/:classId/students", getStudentsInClass);
router.get("/:classId/assessments", getAssessmentsByClass);

module.exports = router;
