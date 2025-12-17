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

const router = express.Router();

router.get("/", getAllStudents);
router.get("/archived", getArchivedStudents);
router.get("/all", getAllStudentsWithArchived);
router.get("/:id", getStudentById);
router.patch("/:id", updateStudent);
router.post("/", createStudent);
router.delete("/:id", deleteStudent);
router.post("/:id/archive", archiveStudent);
router.post("/:id/unarchive", unarchiveStudent);

module.exports = router;