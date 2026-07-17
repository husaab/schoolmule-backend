// controllers/class.controller.js

const db = require("../config/database");
const classQueries = require("../queries/class.queries");
const bulkQueries = require("../queries/bulk.queries");
const studentQueries = require("../queries/student.queries");
const logger = require("../logger");
const { v4: uuidv4 } = require("uuid");

// ── Shared helper: fetch additional teachers for a single class ──
const fetchAdditionalTeachers = async (classId) => {
  const { rows } = await db.query(
    classQueries.selectAdditionalTeachersByClassId,
    [classId]
  );
  return rows.map((t) => ({
    teacherId: t.teacher_id,
    fullName:  `${t.first_name} ${t.last_name}`,
    email:     t.email,
    addedAt:   t.created_at,
  }));
};

// ── Shared helper: batch-fetch additional teachers for multiple classes ──
const batchFetchAdditionalTeachers = async (classIds) => {
  if (classIds.length === 0) return {};
  const { rows } = await db.query(
    classQueries.selectAdditionalTeachersByClassIds,
    [classIds]
  );
  const map = {};
  for (const t of rows) {
    if (!map[t.class_id]) map[t.class_id] = [];
    map[t.class_id].push({
      teacherId: t.teacher_id,
      fullName:  `${t.first_name} ${t.last_name}`,
      email:     t.email,
      addedAt:   t.created_at,
    });
  }
  return map;
};

// ── Shared helper: map a class row to camelCase response ──
const mapClassRow = (c, additionalTeachers = []) => ({
  classId:        c.class_id,
  school:         c.school,
  grade:          c.grade,
  subject:        c.subject,
  teacherName:    c.teacher_name,
  teacherId:      c.teacher_id,
  termId:         c.term_id,
  termName:       c.term_name,
  createdAt:      c.created_at,
  lastModifiedAt: c.last_modified_at,
  additionalTeachers,
});

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

    const classIds = rows.map((c) => c.class_id);
    const atMap = await batchFetchAdditionalTeachers(classIds);

    logger.info(`All classes fetched successfully for school="${requestedSchool}"`);
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => mapClassRow(c, atMap[c.class_id] || [])),
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

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res
      .status(400)
      .json({ status: "error", message: `Invalid class ID format` });
  }

  try {
    const { rows } = await db.query(classQueries.selectClassById, [id]);
    if (rows.length === 0) {
      return res
        .status(404)
        .json({ status: "failed", message: `Class with id ${id} not found` });
    }

    const c = rows[0];
    const additionalTeachers = await fetchAdditionalTeachers(id);
    return res.status(200).json({
      status: "success",
      data: mapClassRow(c, additionalTeachers),
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

    const classIds = rows.map((c) => c.class_id);
    const atMap = await batchFetchAdditionalTeachers(classIds);

    logger.info(
      `Classes fetched successfully for school="${requestedSchool}", grade=${gradeInt}`
    );
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => mapClassRow(c, atMap[c.class_id] || [])),
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

    const classIds = rows.map((c) => c.class_id);
    const atMap = await batchFetchAdditionalTeachers(classIds);

    logger.info(`Classes fetched successfully for teacherName="${teacherName}"`);
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => mapClassRow(c, atMap[c.class_id] || [])),
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
  const { school, grade, subject, teacherName, teacherId, termId, termName } = req.body;
  // Default true: enrollment is additive and idempotent, so callers that omit
  // the flag get the class ready-to-use
  const autoEnroll = req.body.autoEnroll !== false;

  // Validate required fields
  if (!school || grade == null || !subject || !teacherName || !teacherId || !termId || !termName) {
    return res.status(400).json({
      status: "failed",
      message:
        "Missing required fields: school, grade, subject, teacherName, teacherId, termId, termName"
    });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const vals = [school, grade, subject, teacherName, teacherId, termId, termName];
    const { rows } = await client.query(classQueries.createClass, vals);
    const newClass = rows[0];

    // Enroll every active student of the class's grade/school. The class is
    // brand-new, so no conflicts are possible and rowCount is the exact count.
    let enrolledCount = 0;
    if (autoEnroll) {
      const enrollResult = await client.query(bulkQueries.enrollAllInGrade, [
        newClass.class_id,
        newClass.grade,
        newClass.school,
      ]);
      enrolledCount = enrollResult.rowCount;
    }

    await client.query("COMMIT");

    logger.info(
      `Class created with id ${newClass.class_id}` +
      (autoEnroll ? ` (auto-enrolled ${enrolledCount} students)` : "")
    );
    return res.status(201).json({
      status: "success",
      data: {
        classId:      newClass.class_id,
        school:       newClass.school,
        grade:        newClass.grade,
        subject:      newClass.subject,
        teacherName:  newClass.teacher_name,
        teacherId:    newClass.teacher_id,
        termId:       newClass.term_id,
        termName:     newClass.term_name,
        createdAt:    newClass.created_at,
        lastModifiedAt: newClass.last_modified_at,
        autoEnrolled: autoEnroll,
        enrolledCount
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error creating class" });
  } finally {
    client.release();
  }
};

//
// 6) PATCH /classes/:id
//    → Update class metadata
//
const updateClass = async (req, res) => {
  const { id } = req.params;
  const {
    school          = null,
    grade           = null,
    subject         = null,
    teacherName     = null,
    teacherId       = null,
    termId          = null,
    termName        = null
  } = req.body;

  // Build the parameter array in the same order as `updateClassById`
  // (i.e. $1=school, $2=grade, $3=subject, $4=teacher_name, $5=teacher_id, $6=term_id, $7=term_name, $8=class_id)
  const vals = [
    school,
    grade,
    subject,
    teacherName,
    teacherId,
    termId,
    termName,
    id
  ];

  try {
    const { rows, rowCount } = await db.query(
      classQueries.updateClassById,
      vals
    );
    if (rowCount === 0) {
      return res
        .status(404)
        .json({ status: "failed", message: `Class with id ${id} not found` });
    }

    logger.info(`Class ${id} updated`);
    const c = rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        classId:      c.class_id,
        school:       c.school,
        grade:        c.grade,
        subject:      c.subject,
        teacherName:  c.teacher_name, 
        teacherId:    c.teacher_id,
        termId:       c.term_id,
        termName:     c.term_name,
        createdAt:    c.created_at,
        lastModifiedAt: c.last_modified_at
      }
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error updating class" });
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
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
        maxScore:           a.max_score,
        weightPoints:       a.weight_points,
        date:               a.date || null
      })),
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching assessments for class" });
  }
};

const addStudentToClass = async (req, res) => {
  const { classId } = req.params;
  const { studentId } = req.body;

  // Validate both IDs are provided
  if (!classId || !studentId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: classId and studentId",
    });
  }

  try {
    // (Optional) You may want to verify that classId and studentId both exist in their tables before inserting.
    const { rows } = await db.query(
      classQueries.createClassStudentRelation,
      [classId, studentId]
    );

    logger.info(`Student ${studentId} enrolled in class ${classId}`);
    return res.status(201).json({
      status: "success",
      data: {
        classId:   rows[0].class_id,
        studentId: rows[0].student_id,
      },
    });
  } catch (error) {
    logger.error(error);
    // Unique‐constraint violation (e.g., already enrolled) will come here with code “23505”
    if (error.code === "23505") {
      return res.status(409).json({
        status: "failed",
        message: `Student ${studentId} is already enrolled in class ${classId}`,
      });
    }
    return res
      .status(500)
      .json({ status: "failed", message: "Error enrolling student in class" });
  }
};

const removeStudentFromClass = async (req, res) => {
  const { classId, studentId } = req.params;

  if (!classId || !studentId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required path parameters: classId and studentId",
    });
  }

  try {
    const result = await db.query(
      classQueries.deleteClassStudentRelation,
      [classId, studentId]
    );

    if (result.rowCount === 0) {
      // Nothing was deleted → relationship didn’t exist
      return res.status(404).json({
        status: "failed",
        message: `No enrollment found for student ${studentId} in class ${classId}`,
      });
    }

    logger.info(`Student ${studentId} removed from class ${classId}`);
    return res.status(200).json({
      status: "success",
      message: `Student ${studentId} unenrolled from class ${classId}`,
    });
  } catch (error) {
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error removing student from class" });
  }
};

//
// 12) POST /classes/:classId/students/bulk
//     → Bulk‐enroll students, either “all in grade” or a given list
//
// controllers/class.controller.js

const bulkEnrollStudentsToClass = async (req, res) => {
  const { classId } = req.params;
  const { enrollAllInGrade, studentIds } = req.body;

  if (!classId) {
    return res
      .status(400)
      .json({ status: "failed", message: "Missing classId" });
  }

  try {
    // If enrollAllInGrade = true, insert every student in that class’s grade
    if (enrollAllInGrade) {
      // 1) Fetch this class’s grade
      const { rows: classRows } = await db.query(
        classQueries.selectClassById,
        [classId]
      );
      if (classRows.length === 0) {
        return res.status(404).json({
          status: "failed",
          message: `Class ${classId} not found`,
        });
      }
      const classGrade = classRows[0].grade;
      const classSchool = classRows[0].school;

      // 2) Insert all students in that grade
      await db.query(bulkQueries.enrollAllInGrade, [classId, classGrade, classSchool]);

      // 3) To figure out exactly which IDs were inserted, fetch all student_ids in that grade
      const { rows: studentRows } = await db.query(
        studentQueries.selectStudentsByGrade,
        [classGrade]
      );
      const gradeStudentIds = studentRows.map((r) => r.student_id);

      // 4) Now run “selectEnrolledSpecificStudents” to return every student_id among those
      const { rows: insertedRows } = await db.query(
        bulkQueries.selectEnrolledSpecificStudents,
        [classId, gradeStudentIds]
      );
      const newlyInsertedIds = insertedRows.map((r) => r.student_id);

      return res.status(201).json({
        status: "success",
        data: newlyInsertedIds.map((sid) => ({ classId, studentId: sid })),
      });
    }

    // Otherwise, we expect a (non­empty) array of studentIds
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({
        status: "failed",
        message:
          "Must supply non­empty studentIds array when enrollAllInGrade=false",
      });
    }

    // 5) Insert only the provided list
    // Here we pass a real `uuid[]` for $2; pg will automatically cast the JS array → uuid[].
    await db.query(bulkQueries.enrollSpecificStudents, [classId, studentIds]);

    // 6) Return exactly which studentIds were newly added
    const { rows: insertedRows2 } = await db.query(
      bulkQueries.selectEnrolledSpecificStudents,
      [classId, studentIds]
    );
    const newlyInsertedIds2 = insertedRows2.map((r) => r.student_id);

    return res.status(201).json({
      status: "success",
      data: newlyInsertedIds2.map((sid) => ({ classId, studentId: sid })),
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error during bulk enrollment",
    });
  }
};

const bulkUnenrollStudentsFromClass = async (req, res) => {
  const { classId } = req.params;
  if (!classId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing classId",
    });
  }

  try {
    // Delete every row in `class_students` where class_id = $1
    const result = await db.query(
      bulkQueries.unenrollAllFromClass,
      [classId]
    );

    logger.info(
      `Unenrolled all students from class ${classId} (deleted ${result.rowCount} rows)`
    );
    return res.status(200).json({
      status: "success",
      message: "All students unenrolled from class",
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error unenrolling all students",
    });
  }
};

const getClassesByTeacherId = async (req, res) => {
  const { teacherId } = req.params
  if (!teacherId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required path parameter: teacherId"
    })
  }

  try {
    // Run the new query
    const { rows } = await db.query(
      classQueries.selectClassesByTeacherId,
      [teacherId]
    )

    const classIds = rows.map((c) => c.class_id);
    const atMap = await batchFetchAdditionalTeachers(classIds);

    logger.info(`Classes fetched successfully for teacher_id="${teacherId}"`)
    return res.status(200).json({
      status: "success",
      data: rows.map((c) => mapClassRow(c, atMap[c.class_id] || []))
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: "failed", message: "Error fetching classes by teacherId" })
  }
}

//
// POST /classes/:sourceClassId/duplicate
//    → Duplicate a class with its assessments and student enrollments (no scores)
//
const duplicateClass = async (req, res) => {
  const { sourceClassId } = req.params;
  const { grade, subject, teacherName, teacherId, termId, termName } = req.body;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sourceClassId)) {
    return res
      .status(400)
      .json({ status: "error", message: "Invalid source class ID format" });
  }

  // Validate required body fields
  if (grade == null || !subject || !teacherName || !teacherId || !termId || !termName) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: grade, subject, teacherName, teacherId, termId, termName",
    });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1) Fetch source class
    const { rows: sourceRows } = await client.query(
      classQueries.selectClassById,
      [sourceClassId]
    );
    if (sourceRows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ status: "failed", message: `Source class ${sourceClassId} not found` });
    }
    const sourceClass = sourceRows[0];

    // 2) Insert new class using source's school
    const { rows: newClassRows } = await client.query(classQueries.createClass, [
      sourceClass.school,
      grade,
      subject,
      teacherName,
      teacherId,
      termId,
      termName,
    ]);
    const newClass = newClassRows[0];

    // 3) Fetch all assessments for source class (parents first)
    const { rows: sourceAssessments } = await client.query(
      classQueries.duplicateSelectAssessments,
      [sourceClassId]
    );

    // 4) Copy assessments in two passes: parents/standalone first, then children
    const idMap = {}; // oldId → newId
    let assessmentsCopied = 0;

    // Pass 1: parents and standalone (no parent_assessment_id)
    for (const a of sourceAssessments) {
      if (a.parent_assessment_id) continue;
      const newId = uuidv4();
      idMap[a.assessment_id] = newId;
      await client.query(classQueries.duplicateInsertAssessment, [
        newId,
        newClass.class_id,
        a.name,
        a.weight_percent,
        null, // parent_assessment_id
        a.is_parent,
        a.sort_order,
        a.max_score,
        a.weight_points,
      ]);
      assessmentsCopied++;
    }

    // Pass 2: children (have parent_assessment_id)
    for (const a of sourceAssessments) {
      if (!a.parent_assessment_id) continue;
      const newId = uuidv4();
      idMap[a.assessment_id] = newId;
      const newParentId = idMap[a.parent_assessment_id] || null;
      await client.query(classQueries.duplicateInsertAssessment, [
        newId,
        newClass.class_id,
        a.name,
        a.weight_percent,
        newParentId,
        a.is_parent,
        a.sort_order,
        a.max_score,
        a.weight_points,
      ]);
      assessmentsCopied++;
    }

    // 5) Copy student enrollments
    const { rows: sourceStudents } = await client.query(
      classQueries.duplicateSelectStudents,
      [sourceClassId]
    );
    const studentIds = sourceStudents.map((s) => s.student_id);
    let studentsCopied = 0;

    if (studentIds.length > 0) {
      await client.query(classQueries.duplicateEnrollStudents, [
        newClass.class_id,
        studentIds,
      ]);
      studentsCopied = studentIds.length;
    }

    // 6) Copy additional teacher assignments
    const { rows: sourceTeachers } = await client.query(
      classQueries.duplicateSelectClassTeachers,
      [sourceClassId]
    );
    const additionalTeacherIds = sourceTeachers.map((t) => t.teacher_id);
    if (additionalTeacherIds.length > 0) {
      await client.query(classQueries.duplicateInsertClassTeachers, [
        newClass.class_id,
        additionalTeacherIds,
      ]);
    }

    await client.query("COMMIT");

    logger.info(
      `Class ${sourceClassId} duplicated → ${newClass.class_id} (${assessmentsCopied} assessments, ${studentsCopied} students)`
    );

    return res.status(201).json({
      status: "success",
      data: {
        classId:        newClass.class_id,
        school:         newClass.school,
        grade:          newClass.grade,
        subject:        newClass.subject,
        teacherName:    newClass.teacher_name,
        teacherId:      newClass.teacher_id,
        termId:         newClass.term_id,
        termName:       newClass.term_name,
        createdAt:      newClass.created_at,
        lastModifiedAt: newClass.last_modified_at,
        assessmentsCopied,
        studentsCopied,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error(error);
    return res
      .status(500)
      .json({ status: "failed", message: "Error duplicating class" });
  } finally {
    client.release();
  }
};

//
// POST /classes/:classId/teachers
//    → Add an additional teacher to a class
//
const addTeacherToClass = async (req, res) => {
  const { classId } = req.params;
  const { teacherId } = req.body;

  if (!classId || !teacherId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: classId and teacherId",
    });
  }

  try {
    // Guard: prevent adding the primary teacher as an additional teacher
    const { rows: classRows } = await db.query(classQueries.selectClassById, [classId]);
    if (classRows.length === 0) {
      return res.status(404).json({ status: "failed", message: "Class not found" });
    }
    if (classRows[0].teacher_id === teacherId) {
      return res.status(409).json({
        status: "failed",
        message: "This teacher is already the primary teacher for this class",
      });
    }

    const { rows } = await db.query(classQueries.insertClassTeacher, [classId, teacherId]);

    if (rows.length === 0) {
      return res.status(409).json({
        status: "failed",
        message: "Teacher is already assigned to this class",
      });
    }

    logger.info(`Teacher ${teacherId} added to class ${classId}`);
    return res.status(201).json({
      status: "success",
      data: {
        classId:   rows[0].class_id,
        teacherId: rows[0].teacher_id,
        addedAt:   rows[0].created_at,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error adding teacher to class",
    });
  }
};

//
// DELETE /classes/:classId/teachers/:teacherId
//    → Remove an additional teacher from a class
//
const removeTeacherFromClass = async (req, res) => {
  const { classId, teacherId } = req.params;

  if (!classId || !teacherId) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required path parameters: classId and teacherId",
    });
  }

  try {
    const result = await db.query(classQueries.deleteClassTeacher, [classId, teacherId]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "failed",
        message: "No assignment found for this teacher in this class",
      });
    }

    logger.info(`Teacher ${teacherId} removed from class ${classId}`);
    return res.status(200).json({
      status: "success",
      message: "Teacher removed from class",
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      status: "failed",
      message: "Error removing teacher from class",
    });
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
  addStudentToClass,
  removeStudentFromClass,
  bulkEnrollStudentsToClass,
  bulkUnenrollStudentsFromClass,
  getClassesByTeacherId,
  duplicateClass,
  addTeacherToClass,
  removeTeacherFromClass,
};
