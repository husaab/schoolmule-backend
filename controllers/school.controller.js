// src/controllers/school.controller.js

const db = require('../config/database');
const schoolQueries = require('../queries/school.queries');
const logger = require('../logger');
const { cleanEmailArray } = require('../utils/emailUtils');
const { schoolSender, senderAddress } = require('../services/email/senderIdentity');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One shape for every school response. `emailAddresses` is what parents see
// in the From line, derived from the sending settings (see senderIdentity).
const toSchoolPayload = (school) => {
  const sender = (role) => senderAddress(schoolSender({ school: school.school_code, schoolInfo: school, role }).from);
  return {
    schoolId: school.school_id,
    schoolCode: school.school_code,
    name: school.name,
    slug: school.slug,
    address: school.address,
    phone: school.phone,
    email: school.email,
    timezone: school.timezone,
    academicYearStartDate: school.academic_year_start_date,
    academicYearEndDate: school.academic_year_end_date,
    emailSendingDomain: school.email_sending_domain || null,
    emailReplyTo: Array.isArray(school.email_reply_to) ? school.email_reply_to : [],
    emailAddresses: { academics: sender('academics'), messages: sender('messages') },
    createdAt: school.created_at,
    lastUpdatedAt: school.last_updated_at,
  };
};

// Accepts an array or a comma/newline separated string. Returns the cleaned
// list, or { error } naming the first bad address. undefined = not provided.
const parseReplyTo = (raw) => {
  if (raw === undefined) return { list: undefined };
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\n;]+/);
  const list = Array.from(new Set(cleanEmailArray(items.map((e) => String(e ?? '').trim().toLowerCase()))));
  const bad = list.find((e) => !EMAIL_RE.test(e));
  if (bad) return { error: `"${bad}" is not a valid email address` };
  return { list };
};

/**
 * GET /api/schools
 * Get all schools
 */
const getAllSchools = async (req, res) => {
  try {
    const { rows } = await db.query(schoolQueries.selectAllSchools);
    return res.status(200).json({
      status: 'success',
      data: rows.map(toSchoolPayload)
    });
  } catch (error) {
    logger.error('Error fetching schools:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching schools'
    });
  }
};

/**
 * GET /api/schools/:code
 * Get school by code (enum)
 */
const getSchoolByCode = async (req, res) => {
  const { code } = req.params;
  
  if (!code) {
    return res.status(400).json({
      status: 'failed',
      message: 'School code is required'
    });
  }

  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [code]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'School not found'
      });
    }

    const school = rows[0];
    return res.status(200).json({
      status: 'success',
      data: toSchoolPayload(school)
    });
  } catch (error) {
    logger.error('Error fetching school by code:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching school'
    });
  }
};

/**
 * GET /api/schools/id/:id
 * Get school by ID
 */
const getSchoolById = async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'School ID is required'
    });
  }

  try {
    const { rows } = await db.query(schoolQueries.selectSchoolById, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'School not found'
      });
    }

    const school = rows[0];
    return res.status(200).json({
      status: 'success',
      data: toSchoolPayload(school)
    });
  } catch (error) {
    logger.error('Error fetching school by ID:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching school'
    });
  }
};

/**
 * POST /api/schools
 * Create new school
 */
const createSchool = async (req, res) => {
  const {
    schoolCode,
    name,
    address,
    phone,
    email,
    timezone,
    academicYearStartDate,
    academicYearEndDate
  } = req.body;

  // Validation
  if (!schoolCode) {
    return res.status(400).json({
      status: 'failed',
      message: 'School code is required'
    });
  }

  if (!name) {
    return res.status(400).json({
      status: 'failed',
      message: 'School name is required'
    });
  }

  try {
    const { rows } = await db.query(schoolQueries.insertSchool, [
      schoolCode,
      name,
      address || null,
      phone || null,
      email || null,
      timezone || 'America/New_York',
      academicYearStartDate || null,
      academicYearEndDate || null
    ]);

    const school = rows[0];
    return res.status(201).json({
      status: 'success',
      data: toSchoolPayload(school)
    });
  } catch (error) {
    if (error.code === '23505') { // Unique constraint violation
      return res.status(409).json({
        status: 'failed',
        message: 'School with this code already exists'
      });
    }
    
    logger.error('Error creating school:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error creating school'
    });
  }
};

/**
 * PUT /api/schools/:id
 * Update school
 */
const updateSchool = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    address,
    phone,
    email,
    timezone,
    academicYearStartDate,
    academicYearEndDate,
    emailReplyTo
  } = req.body;

  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'School ID is required'
    });
  }

  if (!name) {
    return res.status(400).json({
      status: 'failed',
      message: 'School name is required'
    });
  }

  // Where parent replies go. Omitted = unchanged; [] = only the school email.
  const replyTo = parseReplyTo(emailReplyTo);
  if (replyTo.error) {
    return res.status(400).json({ status: 'failed', message: replyTo.error });
  }

  try {
    const { rows } = await db.query(schoolQueries.updateSchool, [
      name,
      address || null,
      phone || null,
      email || null,
      timezone || 'America/New_York',
      academicYearStartDate || null,
      academicYearEndDate || null,
      replyTo.list ?? null,
      id
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'School not found'
      });
    }

    const school = rows[0];
    return res.status(200).json({
      status: 'success',
      data: toSchoolPayload(school)
    });
  } catch (error) {
    logger.error('Error updating school:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error updating school'
    });
  }
};

/**
 * DELETE /api/schools/:id
 * Delete school
 */
const deleteSchool = async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'School ID is required'
    });
  }

  try {
    const { rows } = await db.query(schoolQueries.deleteSchool, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'School not found'
      });
    }

    const school = rows[0];
    return res.status(200).json({
      status: 'success',
      message: 'School deleted successfully',
      data: {
        schoolId: school.school_id,
        schoolCode: school.school_code,
        name: school.name
      }
    });
  } catch (error) {
    logger.error('Error deleting school:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error deleting school'
    });
  }
};

module.exports = {
  getAllSchools,
  getSchoolByCode,
  getSchoolById,
  createSchool,
  updateSchool,
  deleteSchool
};