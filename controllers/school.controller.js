// src/controllers/school.controller.js

const db = require('../config/database');
const schoolQueries = require('../queries/school.queries');
const logger = require('../logger');

/**
 * GET /api/schools
 * Get all schools
 */
const getAllSchools = async (req, res) => {
  try {
    const { rows } = await db.query(schoolQueries.selectAllSchools);
    return res.status(200).json({
      status: 'success',
      data: rows.map(s => ({
        schoolId: s.school_id,
        schoolCode: s.school_code,
        name: s.name,
        address: s.address,
        phone: s.phone,
        email: s.email,
        timezone: s.timezone,
        academicYearStartDate: s.academic_year_start_date,
        academicYearEndDate: s.academic_year_end_date,
        createdAt: s.created_at,
        lastUpdatedAt: s.last_updated_at
      }))
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
      data: {
        schoolId: school.school_id,
        schoolCode: school.school_code,
        name: school.name,
        address: school.address,
        phone: school.phone,
        email: school.email,
        timezone: school.timezone,
        academicYearStartDate: school.academic_year_start_date,
        academicYearEndDate: school.academic_year_end_date,
        createdAt: school.created_at,
        lastUpdatedAt: school.last_updated_at
      }
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
      data: {
        schoolId: school.school_id,
        schoolCode: school.school_code,
        name: school.name,
        address: school.address,
        phone: school.phone,
        email: school.email,
        timezone: school.timezone,
        academicYearStartDate: school.academic_year_start_date,
        academicYearEndDate: school.academic_year_end_date,
        createdAt: school.created_at,
        lastUpdatedAt: school.last_updated_at
      }
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
      data: {
        schoolId: school.school_id,
        schoolCode: school.school_code,
        name: school.name,
        address: school.address,
        phone: school.phone,
        email: school.email,
        timezone: school.timezone,
        academicYearStartDate: school.academic_year_start_date,
        academicYearEndDate: school.academic_year_end_date,
        createdAt: school.created_at,
        lastUpdatedAt: school.last_updated_at
      }
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
    academicYearEndDate
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

  try {
    const { rows } = await db.query(schoolQueries.updateSchool, [
      name,
      address || null,
      phone || null,
      email || null,
      timezone || 'America/New_York',
      academicYearStartDate || null,
      academicYearEndDate || null,
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
      data: {
        schoolId: school.school_id,
        schoolCode: school.school_code,
        name: school.name,
        address: school.address,
        phone: school.phone,
        email: school.email,
        timezone: school.timezone,
        academicYearStartDate: school.academic_year_start_date,
        academicYearEndDate: school.academic_year_end_date,
        createdAt: school.created_at,
        lastUpdatedAt: school.last_updated_at
      }
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