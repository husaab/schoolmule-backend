const db = require("../config/database");
const studentQueries = require("../queries/student.queries");
const studentAccountQueries = require("../queries/studentAccount.queries");
const logger = require("../logger");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The student's own address (students.student_email): trimmed and lowercased,
// '' and null both mean "none". { error } when it is not an address.
const parseStudentEmail = (raw) => {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== "string") return { error: "Enter a valid student email address" };
  const value = raw.trim().toLowerCase();
  if (value === "") return { value: null };
  if (!EMAIL_RE.test(value)) return { error: "Enter a valid student email address" };
  return { value };
};

// Convert database row to camelCase
const toCamel = (s) => ({
  studentId: s.student_id,
  name: s.name,
  homeroomTeacherId: s.homeroom_teacher_id,
  school: s.school,
  grade: s.grade,
  oen: s.oen,
  studentEmail: s.student_email ?? null,
  mother: {
    name: s.mother_name,
    email: s.mother_email,
    phone: s.mother_number,
  },
  father: {
    name: s.father_name,
    email: s.father_email,
    phone: s.father_number,
  },
  emergencyContact: s.emergency_contact,
  dateOfBirth: s.date_of_birth,
  address: s.address,
  healthCardNumber: s.health_card_number,
  medicalNotes: s.medical_notes,
  // Set when this student was created (or enriched) by importing a
  // registration form submission; null for manually-entered students.
  sourceSubmissionId: s.source_submission_id ?? null,
  createdAt: s.created_at,
  lastModifiedAt: s.last_modified_at,
  isArchived: s.is_archived,
  archivedAt: s.archived_at,
  archivedBy: s.archived_by,
});

const getAllStudents = async (req, res) => {
  try {
    const requestedSchool = req.user.school;
    const schoolYearId = req.schoolYear?.schoolYearId || null;
    const { rows } = await db.query(studentQueries.selectStudentsBySchool, [requestedSchool, schoolYearId]);

    logger.info("All students fetched successfully");
    return res.status(200).json({
      status: "success",
      data: rows.map(toCamel)
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

    return res.status(200).json({
      status: "success",
      data: toCamel(rows[0])
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching student" });
  }
};

const createStudent = async (req, res) => {
  const {
    name,
    homeroomTeacherId,
    grade,
    oen,
    mother = {},
    father = {},
    emergencyContact,
    dateOfBirth,
    address,
    healthCardNumber,
    medicalNotes,
    studentEmail
    } = req.body;
  const school = req.user.school;
  const schoolYearId = req.schoolYear?.schoolYearId || null;

  // Basic required-field check
  if (!name || grade == null || !school) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: name, grade, school"
    });
  }
  const email = parseStudentEmail(studentEmail);
  if (email.error) {
    return res.status(400).json({ status: "failed", message: email.error });
  }

  try {
    const vals = [
      name,
      homeroomTeacherId || null,
      grade,
      oen,
      school,
      mother.name || null,
      mother.email || null,
      mother.phone || null,
      father.name || null,
      father.email || null,
      father.phone || null,
      emergencyContact,
      schoolYearId,
      dateOfBirth || null,
      address || null,
      healthCardNumber || null,
      medicalNotes || null,
      email.value
    ];
    const { rows } = await db.query(studentQueries.createStudent, vals);

    logger.info(`Student created with id ${rows[0].student_id}`);
    return res.status(201).json({
      status: "success",
      data: toCamel(rows[0])
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error creating student" });
  }
};

const updateStudent = async (req, res) => {
  const { id } = req.params;
  // pull in everything; missing → null for COALESCE in your SQL
  const {
    name,
    grade,
    oen,
    school,
    homeroomTeacherId,
    mother = {},
    father = {},
    emergencyContact,
    dateOfBirth,
    address,
    healthCardNumber,
    medicalNotes,
  } = req.body;

  // studentEmail is only touched when the body carries it, so older callers
  // that never send it keep the stored address.
  const carriesEmail = Object.prototype.hasOwnProperty.call(req.body ?? {}, "studentEmail");
  const email = carriesEmail ? parseStudentEmail(req.body.studentEmail) : { value: null };
  if (email.error) {
    return res.status(400).json({ status: "failed", message: email.error });
  }

  const vals = [
    name ?? null,
    homeroomTeacherId ?? null,
    grade ?? null,
    oen ?? null,
    school ?? null,
    mother.name ?? null,
    mother.email ?? null,
    mother.phone ?? null,
    father.name ?? null,
    father.email ?? null,
    father.phone ?? null,
    emergencyContact ?? null,
    id,
    dateOfBirth ?? null,
    address ?? null,
    healthCardNumber ?? null,
    medicalNotes ?? null,
    carriesEmail,
    email.value,
  ];

  try {
    // A student with a SchoolMule login signs in with that address, so it is
    // changed on Student accounts (which updates both) rather than here.
    if (carriesEmail) {
      const { rows: linked } = await db.query(studentAccountQueries.selectLinkedAccountEmail, [id]);
      if (linked.length > 0 && String(linked[0].email || "").toLowerCase() !== (email.value ?? "")) {
        return res.status(409).json({
          status: "failed",
          message: "This student has a SchoolMule account. Change the email on Admin Panel → Student accounts.",
        });
      }
    }

    const { rows, rowCount } = await db.query(studentQueries.updateStudentById, vals);

    if (rowCount === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    logger.info(`Student ${id} updated`);
    return res.status(200).json({
      status: "success",
      data: toCamel(rows[0])
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

// Get archived students
const getArchivedStudents = async (req, res) => {
  try {
    const requestedSchool = req.user.school;
    const schoolYearId = req.schoolYear?.schoolYearId || null;

    const { rows } = await db.query(studentQueries.selectArchivedStudentsBySchool, [requestedSchool, schoolYearId]);
    
    logger.info("Archived students fetched successfully");
    return res.status(200).json({
      status: "success",
      data: rows.map(toCamel)
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching archived students" });
  }
};

// Archive a student
const archiveStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.user; // Get the user ID from the authenticated user
    
    // Check if student exists
    const checkResult = await db.query(studentQueries.selectStudentById, [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: `Student with id ${id} not found` 
      });
    }
    
    if (checkResult.rows[0].is_archived) {
      return res.status(400).json({ 
        status: "failed", 
        message: "Student is already archived" 
      });
    }
    
    // Archive the student
    const { rows } = await db.query(studentQueries.archiveStudent, [id, userId]);
    
    logger.info(`Student ${id} archived by user ${userId}`);
    return res.status(200).json({
      status: "success",
      message: "Student archived successfully",
      data: toCamel(rows[0])
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error archiving student" });
  }
};

// Unarchive a student
const unarchiveStudent = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if student exists
    const checkResult = await db.query(studentQueries.selectStudentById, [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: `Student with id ${id} not found` 
      });
    }
    
    if (!checkResult.rows[0].is_archived) {
      return res.status(400).json({ 
        status: "failed", 
        message: "Student is not archived" 
      });
    }
    
    // Unarchive the student
    const { rows } = await db.query(studentQueries.unarchiveStudent, [id]);
    
    logger.info(`Student ${id} unarchived`);
    return res.status(200).json({
      status: "success",
      message: "Student unarchived successfully",
      data: toCamel(rows[0])
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error unarchiving student" });
  }
};

// Get all students including archived (with filter)
const getAllStudentsWithArchived = async (req, res) => {
  try {
    const requestedSchool = req.user.school;
    const schoolYearId = req.schoolYear?.schoolYearId || null;

    const { rows } = await db.query(studentQueries.selectAllStudentsWithArchived, [requestedSchool, schoolYearId]);
    
    logger.info("All students (including archived) fetched successfully");
    return res.status(200).json({
      status: "success",
      data: rows.map(toCamel)
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching students" });
  }
};

module.exports = {
  getAllStudents,
  getStudentById,
  createStudent,
  updateStudent,
  deleteStudent,
  getArchivedStudents,
  archiveStudent,
  unarchiveStudent,
  getAllStudentsWithArchived
};