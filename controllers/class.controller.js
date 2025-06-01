// controllers/class.controller.js

const db = require("../config/database");
const classQueries = require("../queries/class.queries");
const logger = require("../logger");

//
// 1) GET /classes?school={school}
//    → List all classes for a given school
//
const getAllClasses = async (req, res) => {
  const requestedSchool = req.query.school;
  if (!requestedSchool) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required query parameter: school",
    });
  }

  try {
    const { rows } = await db.query(
      classQueries.selectClassesBySchool,
      [requestedSchool]
    );

    logger.info(`All classes fetched successfully for school="${requestedSchool}"`);
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => ({
        classId:             c.class_id,
        school:              c.school,
        grade:               c.grade,
        subject:             c.subject,
        homeroomTeacherName: c.homeroom_teacher_name,  // <— changed
        createdAt:           c.created_at,
        lastModifiedAt:      c.last_modified_at,
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching classes" });
  }
};

//
// 2) GET /classes/:id
//    → Fetch one class by ID
//
const getClassById = async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query(classQueries.selectClassById, [id]);
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ status: "failed", message: `Class with id ${id} not found` });
    }

    const c = rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        classId:             c.class_id,
        school:              c.school,
        grade:               c.grade,
        subject:             c.subject,
        homeroomTeacherName: c.homeroom_teacher_name,  // <— changed
        createdAt:           c.created_at,
        lastModifiedAt:      c.last_modified_at,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching class" });
  }
};

//
// 3) GET /classes/grade/:grade?school={school}
//    → List all classes by grade within a school
//
const getClassesByGrade = async (req, res) => {
  const { grade } = req.params;
  const requestedSchool = req.query.school;

  if (!requestedSchool) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required query parameter: school",
    });
  }
  if (!grade) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required path parameter: grade",
    });
  }

  try {
    const gradeInt = parseInt(grade, 10);
    const { rows } = await db.query(
      classQueries.selectClassesByGrade,
      [requestedSchool, gradeInt]
    );

    logger.info(
      `Classes fetched successfully for school="${requestedSchool}", grade=${gradeInt}`
    );
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => ({
        classId:             c.class_id,
        school:              c.school,
        grade:               c.grade,
        subject:             c.subject,
        homeroomTeacherName: c.homeroom_teacher_name,  // <— changed
        createdAt:           c.created_at,
        lastModifiedAt:      c.last_modified_at,
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching classes by grade" });
  }
};

//
// 4) GET /classes/teacher/:teacherName
//    → List all classes for a given teacher name
//
const getClassesByTeacher = async (req, res) => {
  const { teacherName } = req.params;
  if (!teacherName) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required path parameter: teacherName",
    });
  }

  try {
    const { rows } = await db.query(
      classQueries.selectClassesByTeacher,
      [teacherName]
    );

    logger.info(`Classes fetched successfully for teacherName="${teacherName}"`);
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => ({
        classId:             c.class_id,
        school:              c.school,
        grade:               c.grade,
        subject:             c.subject,
        homeroomTeacherName: c.homeroom_teacher_name,  // <— changed
        createdAt:           c.created_at,
        lastModifiedAt:      c.last_modified_at,
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching classes by teacher" });
  }
};

//
// 5) POST /classes
//    → Create a new class
//
const createClass = async (req, res) => {
  // Now expect homeroom_teacher_name instead of ID
  const { school, grade, subject, homeroom_teacher_name } = req.body;

  // Basic required‐field check
  if (!school || grade == null || !subject || !homeroom_teacher_name) {
    return res.status(400).json({
      status: "failed",
      message:
        "Missing required fields: school, grade, subject, homeroom_teacher_name",
    });
  }

  try {
    const vals = [school, grade, subject, homeroom_teacher_name];
    const { rows } = await db.query(classQueries.createClass, vals);

    logger.info(`Class created with id ${rows[0].class_id}`);
    return res.status(201).json({
      status: "success",
      data: {
        classId:             rows[0].class_id,
        school:              rows[0].school,
        grade:               rows[0].grade,
        subject:             rows[0].subject,
        homeroomTeacherName: rows[0].homeroom_teacher_name,  // <— changed
        createdAt:           rows[0].created_at,
        lastModifiedAt:      rows[0].last_modified_at,
      },
    });
  } catch (error) {
    // If you add a UNIQUE(school, grade, subject) constraint, catch code “23505” here
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error creating class" });
  }
};

//
// 6) PATCH /classes/:id
//    → Update class metadata
//
const updateClass = async (req, res) => {
  const { id } = req.params;
  const vals = [
    req.body.school ?? null,
    req.body.grade ?? null,
    req.body.subject ?? null,
    req.body.homeroom_teacher_name ?? null,  // <— changed param
    id,
  ];

  try {
    const { rows, rowCount } = await db.query(classQueries.updateClassById, vals);
    if (rowCount === 0) {
      return res
        .status(404)
        .json({ status: "failed", message: `Class with id ${id} not found` });
    }

    logger.info(`Class ${id} updated`);
    return res.status(200).json({
      status: "success",
      data: {
        classId:             rows[0].class_id,
        school:              rows[0].school,
        grade:               rows[0].grade,
        subject:             rows[0].subject,
        homeroomTeacherName: rows[0].homeroom_teacher_name,  // <— changed
        createdAt:           rows[0].created_at,
        lastModifiedAt:      rows[0].last_modified_at,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating class" });
  }
};

//
// 7) DELETE /classes/:id
//    → Delete a class
//
const deleteClass = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(classQueries.deleteClassById, [id]);
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ status: "failed", message: `Class with id ${id} not found` });
    }

    logger.info(`Class ${id} deleted`);
    return res.status(200).json({ status: "success", message: "Class deleted successfully" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting class" });
  }
};

//
// 8) GET /classes/:classId/students
//    → List all students in a class
//
const getStudentsInClass = async (req, res) => {
  const { classId } = req.params;
  try {
    const { rows } = await db.query(classQueries.selectStudentsInClass, [classId]);
    logger.info(`Fetched ${rows.length} students for class ${classId}`);
    return res.status(200).json({
      status: "success",
      data: rows.map((s) => ({
        studentId:         s.student_id,
        name:              s.name,
        school:            s.school,
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
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching students for class" });
  }
};

//
// 9) GET /classes/:classId/assessments
//    → List all assessments for a class
//
const getAssessmentsByClass = async (req, res) => {
  const { classId } = req.params;
  try {
    const { rows } = await db.query(classQueries.selectAssessmentsByClass, [classId]);
    logger.info(`Fetched ${rows.length} assessments for class ${classId}`);
    return res.status(200).json({
      status: "success",
      data: rows.map((a) => ({
        assessmentId:    a.assessment_id,
        classId:         a.class_id,
        name:            a.name,
        weightPercent:   parseFloat(a.weight_percent),
        createdAt:       a.created_at,
        lastModifiedAt:  a.last_modified_at,
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching assessments for class" });
  }
};

module.exports = {
  getAllClasses,
  getClassById,
  getClassesByGrade,
  getClassesByTeacher,
  createClass,
  updateClass,
  deleteClass,
  getStudentsInClass,
  getAssessmentsByClass,
};
