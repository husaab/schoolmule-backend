const db = require("../config/database");
const studentQueries = require("../queries/student.queries");
const studentAccountQueries = require("../queries/studentAccount.queries");
const { checkStudentEmails } = require("../services/classroom/emailProblems");
const { getSettings } = require("../services/classroom/classroomSettings");
const logger = require("../logger");
const { can } = require("../services/access/access");
const { withPhotoUrls } = require("../services/profile/photos");

// Student rows with photo_url: the photo on the student's login, while the school has student photos on.
const withStudentPhotos = (rows, school) => withPhotoUrls(rows, school, { role: "STUDENT" });

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

// The student's own address is where their SchoolMule invite goes, so it is
// part of student accounts: only someone who manages users (RBAC `users`, D13)
// may set it, and only for a student of their own school. (Others can still
// edit the rest of the student form.)
const STUDENT_EMAIL_ADMIN_ONLY =
  "Only people who manage student accounts can set a student's email. Use Admin Panel → Student accounts.";
const managesStudentAccounts = (req) => can(req, "users");
const carriesStudentEmail = (body) =>
  Boolean(body) && Object.prototype.hasOwnProperty.call(body, "studentEmail") && body.studentEmail !== undefined;

// The student's own address leaves the server only for those who manage
// student accounts (final review M6): many roles read /api/students, and the
// address is where the student's SchoolMule invite goes.
const hideStudentEmail = (req) => (student) => {
  if (managesStudentAccounts(req) || !student) return student;
  const { studentEmail, ...rest } = student;
  return rest;
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
  // The student's own pick, else the one a teacher set ({style, skin, bg}; null = neutral)
  avatar: s.avatar ?? null,
  // Signed URL of the photo on the student's login (null while the school has student photos off)
  photoUrl: s.photo_url ?? null,
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
      data: (await withStudentPhotos(rows, requestedSchool)).map(toCamel).map(hideStudentEmail(req))
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching students" });
  }
};

const getStudentById = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(studentQueries.selectStudentInSchool, [id, req.user.school]);

    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    const [student] = await withStudentPhotos(rows, req.user.school);
    return res.status(200).json({
      status: "success",
      data: hideStudentEmail(req)(toCamel(student))
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
  if (carriesStudentEmail(req.body) && !managesStudentAccounts(req)) {
    return res.status(403).json({ status: "failed", message: STUDENT_EMAIL_ADMIN_ONLY });
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
      data: hideStudentEmail(req)(toCamel(rows[0]))
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
  const carriesEmail = carriesStudentEmail(req.body);
  if (carriesEmail && !managesStudentAccounts(req)) {
    return res.status(403).json({ status: "failed", message: STUDENT_EMAIL_ADMIN_ONLY });
  }
  const email = carriesEmail ? parseStudentEmail(req.body.studentEmail) : { value: null };
  if (email.error) {
    return res.status(400).json({ status: "failed", message: email.error });
  }

  const vals = [
    name ?? null,
    homeroomTeacherId ?? null,
    grade ?? null,
    oen ?? null,
    req.user.school,
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
    if (carriesEmail) {
      // Only a student of the admin's own school.
      const { rows: found } = await db.query(studentAccountQueries.selectStudentWithLogin, [id, req.user.school]);
      if (found.length === 0) {
        return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
      }
      // A student with a SchoolMule login signs in with that address, so it is
      // changed on Student accounts (which updates both and revokes open
      // invite links) rather than here.
      const login = found[0];
      if (login.user_id && String(login.email || "").toLowerCase() !== (email.value ?? "")) {
        return res.status(409).json({
          status: "failed",
          message: "This student has a SchoolMule account. Change the email on Admin Panel → Student accounts.",
        });
      }
      // The same rule as Student accounts: never another account's, a parent's or another student's address.
      if (email.value && !login.user_id) {
        const settings = await getSettings(req.user.school);
        const checked = await checkStudentEmails({
          school: req.user.school, domains: settings.studentEmailDomains, items: [{ studentId: id, email: email.value }],
        });
        const problem = (checked.get(0)?.problems || []).find((p) => p.blocking);
        if (problem) return res.status(409).json({ status: "failed", code: problem.code.toUpperCase(), message: problem.message });
      }
    }

    const { rows, rowCount } = await db.query(studentQueries.updateStudentById, vals);

    if (rowCount === 0) {
      return res.status(404).json({ status: "failed", message: `Student with id ${id} not found` });
    }

    logger.info(`Student ${id} updated`);
    return res.status(200).json({
      status: "success",
      data: hideStudentEmail(req)(toCamel(rows[0]))
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating student" });
  }
};

const deleteStudent = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(studentQueries.deleteStudentById, [id, req.user.school]);
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
      data: (await withStudentPhotos(rows, requestedSchool)).map(toCamel).map(hideStudentEmail(req))
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
    const { userId, school } = req.user;

    // A student of the caller's school only.
    const checkResult = await db.query(studentQueries.selectStudentInSchool, [id, school]);
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
    const { rows } = await db.query(studentQueries.archiveStudent, [id, userId, school]);
    
    logger.info(`Student ${id} archived by user ${userId}`);
    return res.status(200).json({
      status: "success",
      message: "Student archived successfully",
      data: hideStudentEmail(req)(toCamel(rows[0]))
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

    // A student of the caller's school only.
    const checkResult = await db.query(studentQueries.selectStudentInSchool, [id, req.user.school]);
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
    const { rows } = await db.query(studentQueries.unarchiveStudent, [id, req.user.school]);
    
    logger.info(`Student ${id} unarchived`);
    return res.status(200).json({
      status: "success",
      message: "Student unarchived successfully",
      data: hideStudentEmail(req)(toCamel(rows[0]))
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
      data: (await withStudentPhotos(rows, requestedSchool)).map(toCamel).map(hideStudentEmail(req))
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
  getAllStudentsWithArchived,
  // Shared with studentOverview.controller so the profile's student shape matches.
  toCamel
};