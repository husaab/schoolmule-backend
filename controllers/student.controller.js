const db = require("../config/database");
const studentQueries = require("../queries/student.queries");
const logger = require("../logger");

const getAllStudents = async (req, res) => {
  try {
    const requestedSchool = req.query.school;
    if (!requestedSchool) {
      return res.status(400).json({
        status: "failed",
        message: "Missing required query parameter: school",
      });
    }
    const { rows } = await db.query(studentQueries.selectStudentsBySchool, [requestedSchool]);

    logger.info("All students fetched successfully");
    return res.status(200).json({
      status: "success",
      data: rows.map(s => ({
        studentId:         s.student_id,
        name:              s.name,
        homeroomTeacherId: s.homeroom_teacher_id,
        school: s.school,
        grade:             s.grade,
        oen:               s.oen,
        mother: {
          name:  s.mother_name,
          email: s.mother_email,
          phone: s.mother_number,
        },
        father: {
          name:  s.father_name,
          email: s.father_email,
          phone: s.father_number,
        },
        emergencyContact:  s.emergency_contact,
        createdAt:         s.created_at,
        lastModifiedAt:    s.last_modified_at,
      }))
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching students" });
  }
};

const getStudentById = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(studentQueries.selectStudentById, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    const s = rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        studentId:         s.student_id,
        name:              s.name,
        school: s.school,
        homeroomTeacherId: s.homeroom_teacher_id,
        grade:             s.grade,
        oen:               s.oen,
        mother: {
          name:  s.mother_name,
          email: s.mother_email,
          phone: s.mother_number,
        },
        father: {
          name:  s.father_name,
          email: s.father_email,
          phone: s.father_number,
        },
        emergencyContact:  s.emergency_contact,
        createdAt:         s.created_at,
        lastModifiedAt:    s.last_modified_at,
      }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching student" });
  }
};

const createStudent = async (req, res) => {
  const {
    name,
    homeroom_teacher_id,
    grade,
    oen,
    school,                // ← new
    mother_name,
    mother_email,
    mother_number,
    father_name,
    father_email,
    father_number,
    emergency_contact
    } = req.body;

  // Basic required-field check
  if (!name || grade == null || !school) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: name, grade, school"
    });
  }

  try {
    const vals = [
      name,
      homeroom_teacher_id || null,
      grade,
      oen,
      school,
      mother_name || null,
      mother_email || null,
      mother_number || null,
      father_name || null,
      father_email || null,
      father_number || null,
      emergency_contact
    ];
    const { rows } = await db.query(studentQueries.createStudent, vals);

    logger.info(`Student created with id ${rows[0].student_id}`);
    return res.status(201).json({
      status: "success",
      data: rows[0]   // raw DB row; you can map it like above if you want
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error creating student" });
  }
};

const updateStudent = async (req, res) => {
  const { id } = req.params;
  // pull in everything; missing → null for COALESCE in your SQL
  const vals = [
    req.body.name ?? null,
    req.body.homeroom_teacher_id ?? null,
    req.body.grade ?? null,
    req.body.oen ?? null,
    req.body.school ?? null,
    req.body.mother_name ?? null,
    req.body.mother_email ?? null,
    req.body.mother_number ?? null,
    req.body.father_name ?? null,
    req.body.father_email ?? null,
    req.body.father_number ?? null,
    req.body.emergency_contact ?? null,
    id
  ];

  try {
    const { rows, rowCount } = await db.query(studentQueries.updateStudentById, vals);

    if (rowCount === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    logger.info(`Student ${id} updated`);
    return res.status(200).json({
      status: "success",
      data: rows[0]
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating student" });
  }
};

const deleteStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(studentQueries.deleteStudentById, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    logger.info(`Student ${id} deleted`);
    return res.status(200).json({ status: "success", message: "Student deleted successfully" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting student" });
  }
};

module.exports = {
  getAllStudents,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent
};