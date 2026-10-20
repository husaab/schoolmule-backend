const express = require("express");
const { requirePermission, withAccess } = require("../middleware/access");
const { can } = require("../services/access/access");
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

// Anyone may read their own children (a parent, or staff who are also
// parents); anyone else's links are part of managing users (RBAC).
const requireSelfOrStaff = withAccess((req, res, next) => {
  if (req.params.parentId === req.user.userId || can(req, 'users')) return next();
  return res.status(403).json({ status: 'failed', message: 'Not authorized' });
});

// GET /parent-students/parent/:parentId - Get all student relations for a parent
// (the parent portal's ChildSwitcher calls this with the parent's own id)
router.get("/parent/:parentId", requireSelfOrStaff, getStudentsByParentId);

// Everything else is link administration: managing users.
router.use(requirePermission("users"));

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
