const express = require("express");
const requireStaff = require("../middleware/requireStaff");
const {
  getAllParentStudents,
  getParentStudentById,
  getParentsByStudentId,
  getStudentsByParentId,
  createParentStudent,
  updateParentStudent,
  deleteParentStudent
} = require("../controllers/parentStudent.controller");

const router = express.Router();

// A parent may only read their own children; staff may read anyone's.
const requireSelfOrStaff = (req, res, next) => {
  if (req.user.role !== 'PARENT' || req.params.parentId === req.user.userId) return next();
  return res.status(403).json({ status: 'failed', message: 'Not authorized' });
};

// GET /parent-students/parent/:parentId - Get all student relations for a parent
// (the parent portal's ChildSwitcher calls this with the parent's own id)
router.get("/parent/:parentId", requireSelfOrStaff, getStudentsByParentId);

// Everything else is link administration: staff only.
router.use(requireStaff);

// GET /parent-students - Get all parent-student relations for the caller's school
router.get("/", getAllParentStudents);

// GET /parent-students/:id - Get parent-student relation by ID
router.get("/:id", getParentStudentById);

// GET /parent-students/student/:studentId - Get all parent relations for a student
router.get("/student/:studentId", getParentsByStudentId);

// POST /parent-students - Create new parent-student relation
router.post("/", createParentStudent);

// PATCH /parent-students/:id - Update parent-student relation
router.patch("/:id", updateParentStudent);

// DELETE /parent-students/:id - Delete parent-student relation
router.delete("/:id", deleteParentStudent);

module.exports = router;
