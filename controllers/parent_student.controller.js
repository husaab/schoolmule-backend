const db = require("../config/database");
const parentStudentQueries = require("../queries/parent_student.queries");
const logger = require("../logger");

// GET /parent-students?school=X - Get all parent-student relations by school
const getAllParentStudents = async (req, res) => {
  try {
    const requestedSchool = req.query.school;
    if (!requestedSchool) {
      return res.status(400).json({
        status: "failed",
        message: "Missing required query parameter: school",
      });
    }

    const { rows } = await db.query(parentStudentQueries.selectParentStudentsBySchool, [requestedSchool]);

    logger.info(`All parent-student relations fetched successfully for school: ${requestedSchool}`);
    return res.status(200).json({
      status: "success",
      data: rows.map(ps => ({
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at,
        student: {
          name: ps.student_name,
          grade: ps.student_grade
        },
        parentUser: ps.parent_id ? {
          firstName: ps.parent_first_name,
          lastName: ps.parent_last_name,
          email: ps.parent_user_email
        } : null
      }))
    });
  } catch (error) {
    logger.error("Error fetching parent-student relations:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching parent-student relations",
    });
  }
};

// GET /parent-students/:id - Get parent-student relation by ID
const getParentStudentById = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query(parentStudentQueries.selectParentStudentById, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        status: "failed",
        message: `Parent-student relation with id ${id} not found`,
      });
    }

    const ps = rows[0];
    logger.info(`Parent-student relation fetched successfully: ${id}`);
    return res.status(200).json({
      status: "success",
      data: {
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at,
        student: {
          name: ps.student_name,
          grade: ps.student_grade
        },
        parentUser: ps.parent_id ? {
          firstName: ps.parent_first_name,
          lastName: ps.parent_last_name,
          email: ps.parent_user_email
        } : null
      }
    });
  } catch (error) {
    logger.error("Error fetching parent-student relation:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching parent-student relation",
    });
  }
};

// GET /parent-students/student/:studentId - Get all parent relations for a student
const getParentsByStudentId = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { rows } = await db.query(parentStudentQueries.selectParentsByStudentId, [studentId]);

    logger.info(`Parent relations fetched successfully for student: ${studentId}`);
    return res.status(200).json({
      status: "success",
      data: rows.map(ps => ({
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at,
        parentUser: ps.parent_id ? {
          firstName: ps.parent_first_name,
          lastName: ps.parent_last_name,
          email: ps.parent_user_email
        } : null
      }))
    });
  } catch (error) {
    logger.error("Error fetching parent relations for student:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching parent relations for student",
    });
  }
};

// GET /parent-students/parent/:parentId - Get all student relations for a parent
const getStudentsByParentId = async (req, res) => {
  try {
    const { parentId } = req.params;
    const { rows } = await db.query(parentStudentQueries.selectStudentsByParentId, [parentId]);

    logger.info(`Student relations fetched successfully for parent: ${parentId}`);
    return res.status(200).json({
      status: "success",
      data: rows.map(ps => ({
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at,
        student: {
          name: ps.student_name,
          grade: ps.student_grade,
          oen: ps.student_oen,
          homeroomTeacherId: ps.homeroom_teacher_id,
          homeroomTeacher: ps.homeroom_teacher_first_name && ps.homeroom_teacher_last_name ? {
            firstName: ps.homeroom_teacher_first_name,
            lastName: ps.homeroom_teacher_last_name
          } : null
        }
      }))
    });
  } catch (error) {
    logger.error("Error fetching student relations for parent:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error fetching student relations for parent",
    });
  }
};

// POST /parent-students - Create new parent-student relation
const createParentStudent = async (req, res) => {
  try {
    const {
      studentId,
      parentId,
      parentName,
      parentEmail,
      parentNumber,
      relation,
      school
    } = req.body;

    // Validate required fields
    if (!studentId || !school || !relation) {
      return res.status(400).json({
        status: "failed",
        message: "Missing required fields: studentId, school, and relation are required",
      });
    }

    // Check if relation already exists (if parentId is provided)
    if (parentId) {
      const { rows: existingRows } = await db.query(parentStudentQueries.checkExistingRelation, [studentId, parentId]);
      if (existingRows.length > 0) {
        return res.status(409).json({
          status: "failed",
          message: "Parent-student relation already exists",
        });
      }
    }

    const values = [
      studentId,
      parentId || null,
      parentName || null,
      parentEmail || null,
      parentNumber || null,
      relation,
      school
    ];

    const { rows } = await db.query(parentStudentQueries.createParentStudent, values);
    const ps = rows[0];

    logger.info(`Parent-student relation created successfully: ${ps.parent_student_link_id}`);
    return res.status(201).json({
      status: "success",
      data: {
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at
      }
    });
  } catch (error) {
    logger.error("Error creating parent-student relation:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error creating parent-student relation",
    });
  }
};

// PATCH /parent-students/:id - Update parent-student relation
const updateParentStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      parentId,
      parentName,
      parentEmail,
      parentNumber,
      relation
    } = req.body;

    const values = [
      parentId || null,
      parentName || null,
      parentEmail || null,
      parentNumber || null,
      relation,
      id
    ];

    const { rows, rowCount } = await db.query(parentStudentQueries.updateParentStudent, values);

    if (rowCount === 0) {
      return res.status(404).json({
        status: "failed",
        message: `Parent-student relation with id ${id} not found`,
      });
    }

    const ps = rows[0];
    logger.info(`Parent-student relation updated successfully: ${id}`);
    return res.status(200).json({
      status: "success",
      data: {
        parentStudentLinkId: ps.parent_student_link_id,
        studentId: ps.student_id,
        parentId: ps.parent_id,
        parentName: ps.parent_name,
        parentEmail: ps.parent_email,
        parentNumber: ps.parent_number,
        relation: ps.relation,
        school: ps.school,
        createdAt: ps.created_at
      }
    });
  } catch (error) {
    logger.error("Error updating parent-student relation:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error updating parent-student relation",
    });
  }
};

// DELETE /parent-students/:id - Delete parent-student relation
const deleteParentStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(parentStudentQueries.deleteParentStudent, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "failed",
        message: `Parent-student relation with id ${id} not found`,
      });
    }

    logger.info(`Parent-student relation deleted successfully: ${id}`);
    return res.status(200).json({
      status: "success",
      message: "Parent-student relation deleted successfully",
    });
  } catch (error) {
    logger.error("Error deleting parent-student relation:", error);
    return res.status(500).json({
      status: "failed",
      message: "Error deleting parent-student relation",
    });
  }
};

module.exports = {
  getAllParentStudents,
  getParentStudentById,
  getParentsByStudentId,
  getStudentsByParentId,
  createParentStudent,
  updateParentStudent,
  deleteParentStudent,
};