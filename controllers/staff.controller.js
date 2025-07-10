/*
  controllers/staff.controller.js
  Controller for staff management operations
*/

const db = require("../config/database");
const staffQueries = require("../queries/staff.queries");
const logger = require("../logger");

// Convert database row to camelCase
const toCamel = row => ({
  staffId: row.staff_id,
  school: row.school,
  fullName: row.full_name,
  staffRole: row.staff_role,
  teachingAssignments: row.teaching_assignments,
  homeroomGrade: row.homeroom_grade,
  email: row.email,
  phone: row.phone,
  preferredContact: row.preferred_contact,
  phoneContactHours: row.phone_contact_hours,
  emailContactHours: row.email_contact_hours,
  createdAt: row.created_at
});

// GET /api/staff?school=<school>
const getStaffBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(staffQueries.selectStaffBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching staff" 
    });
  }
};

// GET /api/staff/:staffId
const getStaffById = async (req, res) => {
  const { staffId } = req.params;
  if (!staffId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: staffId" 
    });
  }

  try {
    const { rows } = await db.query(staffQueries.selectStaffById, [staffId]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Staff member not found" 
      });
    }
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching staff member" 
    });
  }
};

// POST /api/staff
const createStaff = async (req, res) => {
  const {
    school, fullName, staffRole, teachingAssignments,
    homeroomGrade, email, phone, preferredContact,
    phoneContactHours, emailContactHours
  } = req.body;

  if (!school || !fullName || !staffRole) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: school, fullName, staffRole" 
    });
  }

  try {
    // Format teachingAssignments for PostgreSQL JSONB
    const formattedAssignments = teachingAssignments 
      ? JSON.stringify(teachingAssignments)
      : null;

    const { rows } = await db.query(
      staffQueries.insertStaff,
      [
        school, fullName, staffRole, formattedAssignments,
        homeroomGrade || null, email || null, phone || null, 
        preferredContact || null, phoneContactHours || null, 
        emailContactHours || null
      ]
    );

    logger.info(`Staff member created: ${fullName} at ${school}`);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error creating staff member" 
    });
  }
};

// PATCH /api/staff/:staffId
const updateStaff = async (req, res) => {
  const { staffId } = req.params;
  const {
    school, fullName, staffRole, teachingAssignments,
    homeroomGrade, email, phone, preferredContact,
    phoneContactHours, emailContactHours
  } = req.body;

  if (!staffId || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing staffId or school" 
    });
  }

  try {
    // Format teachingAssignments for PostgreSQL JSONB
    const formattedAssignments = teachingAssignments 
      ? JSON.stringify(teachingAssignments)
      : teachingAssignments;

    const { rows } = await db.query(
      staffQueries.updateStaffById,
      [
        staffId, fullName, staffRole, formattedAssignments,
        homeroomGrade, email, phone, preferredContact,
        phoneContactHours, emailContactHours, school
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Staff member not found or unauthorized" 
      });
    }

    logger.info(`Staff member updated: ${staffId}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error updating staff member" 
    });
  }
};

// DELETE /api/staff/:staffId
const deleteStaff = async (req, res) => {
  const { staffId } = req.params;
  const { school } = req.body;

  if (!staffId || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing staffId or school" 
    });
  }

  try {
    const { rows } = await db.query(staffQueries.deleteStaffById, [staffId, school]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Staff member not found or unauthorized" 
      });
    }

    logger.info(`Staff member deleted: ${staffId}`);
    return res.status(200).json({ 
      status: "success", 
      message: "Staff member deleted" 
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error deleting staff member" 
    });
  }
};

module.exports = {
  getStaffBySchool,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff
};