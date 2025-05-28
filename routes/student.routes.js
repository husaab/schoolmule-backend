const express = require("express");
const { getAllStudents, getStudentById, updateStudent, createStudent, deleteStudent } = require("../controllers/student.controller");

const router = express.Router();

router.get("/", getAllStudents);
router.get("/:id", getStudentById);
router.patch("/:id", updateStudent);
router.post("/", createStudent);
router.delete("/:id", deleteStudent);

module.exports = router;