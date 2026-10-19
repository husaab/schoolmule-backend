const express = require("express");
const { 
  getAllStudents, 
  getStudentById, 
  updateStudent, 
  createStudent, 
  deleteStudent,
  getArchivedStudents,
  archiveStudent,
  unarchiveStudent,
  getAllStudentsWithArchived
} = require("../controllers/student.controller");
const { getStudentOverview, getStudentGrades } = require("../controllers/studentOverview.controller");
const requireStaff = require("../middleware/requireStaff");

const router = express.Router();

// Staff only: students and parents never read or edit the roster here
// (parents see their own children through /api/parent-portal). Every :id is
// also pinned to the caller's school in the controller.
router.use(requireStaff);

router.get("/", getAllStudents);
router.get("/archived", getArchivedStudents);
router.get("/all", getAllStudentsWithArchived);
router.get("/:id", getStudentById);
// The staff student profile (/students/[id]).
router.get("/:id/overview", getStudentOverview);
router.get("/:id/grades", getStudentGrades);
router.patch("/:id", updateStudent);
router.post("/", createStudent);
router.delete("/:id", deleteStudent);
router.post("/:id/archive", archiveStudent);
router.post("/:id/unarchive", unarchiveStudent);

module.exports = router;