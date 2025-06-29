const express = require("express");
const { 
  getAllParentStudents, 
  getParentStudentById, 
  getParentsByStudentId,
  getStudentsByParentId,
  createParentStudent, 
  updateParentStudent, 
  deleteParentStudent 
} = require("../controllers/parent_student.controller");

const router = express.Router();

// GET /parent-students?school=X - Get all parent-student relations by school
router.get("/", getAllParentStudents);

// GET /parent-students/:id - Get parent-student relation by ID
router.get("/:id", getParentStudentById);

// GET /parent-students/student/:studentId - Get all parent relations for a student
router.get("/student/:studentId", getParentsByStudentId);

// GET /parent-students/parent/:parentId - Get all student relations for a parent
router.get("/parent/:parentId", getStudentsByParentId);

// POST /parent-students - Create new parent-student relation
router.post("/", createParentStudent);

// PATCH /parent-students/:id - Update parent-student relation
router.patch("/:id", updateParentStudent);

// DELETE /parent-students/:id - Delete parent-student relation
router.delete("/:id", deleteParentStudent);

module.exports = router;