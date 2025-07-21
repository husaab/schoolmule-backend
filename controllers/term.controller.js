// src/controllers/term.controller.js

const db = require('../config/database');
const termQueries = require('../queries/term.queries');
const logger = require('../logger');

/**
 * Helper function to convert term row to camelCase
 */
const mapTermToResponse = (term) => ({
  termId: term.term_id,
  school: term.school,
  schoolId: term.school_id,
  name: term.name,
  startDate: term.start_date,
  endDate: term.end_date,
  academicYear: term.academic_year,
  isActive: term.is_active,
  createdAt: term.created_at,
  updatedAt: term.updated_at,
  schoolName: term.school_name
});

/**
 * GET /api/terms?school=SCHOOL_ENUM
 * Get all terms for a school
 */
const getTermsBySchool = async (req, res) => {
  const { school } = req.query;
  
  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School parameter is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectTermsBySchool, [school]);
    return res.status(200).json({
      status: 'success',
      data: rows.map(mapTermToResponse)
    });
  } catch (error) {
    logger.error('Error fetching terms by school:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching terms'
    });
  }
};

/**
 * GET /api/terms/school-id/:schoolId
 * Get all terms for a school by school_id
 */
const getTermsBySchoolId = async (req, res) => {
  const { schoolId } = req.params;
  
  if (!schoolId) {
    return res.status(400).json({
      status: 'failed',
      message: 'School ID is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectTermsBySchoolId, [schoolId]);
    return res.status(200).json({
      status: 'success',
      data: rows.map(mapTermToResponse)
    });
  } catch (error) {
    logger.error('Error fetching terms by school ID:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching terms'
    });
  }
};

/**
 * GET /api/terms/by-name?termName=TERM_NAME&school=SCHOOL_ENUM
 * Get a single term by name and school
 */
const getTermByNameAndSchool = async (req, res) => {
  const { termName, school } = req.query;
  
  if (!termName || !school) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term name and school are required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectTermByNameAndSchool, [termName, school]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error fetching term by name and school:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching term'
    });
  }
};

/**
 * GET /api/terms/active?school=SCHOOL_ENUM
 * Get active term for a school
 */
const getActiveTermBySchool = async (req, res) => {
  const { school } = req.query;
  
  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School parameter is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectActiveTermBySchool, [school]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'No active term found for this school'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error fetching active term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching active term'
    });
  }
};

/**
 * GET /api/terms/current?school=SCHOOL_ENUM&date=YYYY-MM-DD
 * Get current term by date for a school
 */
const getCurrentTermBySchool = async (req, res) => {
  const { school, date } = req.query;
  
  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School parameter is required'
    });
  }

  const currentDate = date || new Date().toISOString().split('T')[0];

  try {
    const { rows } = await db.query(termQueries.selectCurrentTermBySchool, [school, currentDate]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'No current term found for this school and date'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error fetching current term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching current term'
    });
  }
};

/**
 * GET /api/terms/:id
 * Get term by ID
 */
const getTermById = async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term ID is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectTermById, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error fetching term by ID:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching term'
    });
  }
};

/**
 * POST /api/terms
 * Create new term
 */
const createTerm = async (req, res) => {
  const {
    school,
    schoolId,
    name,
    startDate,
    endDate,
    academicYear,
    isActive
  } = req.body;

  // Validation
  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School is required'
    });
  }

  if (!name) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term name is required'
    });
  }

  if (!startDate || !endDate) {
    return res.status(400).json({
      status: 'failed',
      message: 'Start date and end date are required'
    });
  }

  if (!academicYear) {
    return res.status(400).json({
      status: 'failed',
      message: 'Academic year is required'
    });
  }

  try {
    // If setting this term as active, deactivate all other terms for this school first
    if (isActive) {
      await db.query(termQueries.deactivateAllTermsForSchool, [school]);
    }

    const { rows } = await db.query(termQueries.insertTerm, [
      school,
      schoolId || null,
      name,
      startDate,
      endDate,
      academicYear,
      isActive || false
    ]);

    return res.status(201).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    if (error.constraint === 'valid_date_range') {
      return res.status(400).json({
        status: 'failed',
        message: 'Start date must be before end date'
      });
    }
    
    logger.error('Error creating term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error creating term'
    });
  }
};

/**
 * PUT /api/terms/:id
 * Update term
 */
const updateTerm = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    startDate,
    endDate,
    academicYear,
    isActive
  } = req.body;

  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term ID is required'
    });
  }

  if (!name) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term name is required'
    });
  }

  try {
    // If setting this term as active, first get the school and deactivate other terms
    if (isActive) {
      const { rows: currentTerm } = await db.query(termQueries.selectTermById, [id]);
      if (currentTerm.length > 0) {
        await db.query(termQueries.deactivateAllTermsForSchool, [currentTerm[0].school]);
      }
    }

    const { rows } = await db.query(termQueries.updateTerm, [
      name,
      startDate,
      endDate,
      academicYear,
      isActive || false,
      id
    ]);

    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    if (error.constraint === 'valid_date_range') {
      return res.status(400).json({
        status: 'failed',
        message: 'Start date must be before end date'
      });
    }
    
    logger.error('Error updating term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error updating term'
    });
  }
};

/**
 * PUT /api/terms/:id/activate
 * Set term as active (deactivates all other terms for the same school)
 */
const activateTerm = async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term ID is required'
    });
  }

  try {
    // First get the term to find its school
    const { rows: termRows } = await db.query(termQueries.selectTermById, [id]);
    
    if (termRows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    const school = termRows[0].school;

    // Deactivate all terms for this school
    await db.query(termQueries.deactivateAllTermsForSchool, [school]);

    // Activate this term
    const { rows } = await db.query(termQueries.setTermActive, [id]);

    return res.status(200).json({
      status: 'success',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error activating term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error activating term'
    });
  }
};

/**
 * PUT /api/terms/:id/status
 * Update term status (active/inactive)
 */
const updateTermStatus = async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term ID is required'
    });
  }

  if (typeof isActive !== 'boolean') {
    return res.status(400).json({
      status: 'failed',
      message: 'isActive must be a boolean value'
    });
  }

  try {
    // First get the term to find its school
    const { rows: termRows } = await db.query(termQueries.selectTermById, [id]);
    
    if (termRows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    const school = termRows[0].school;

    if (isActive) {
      // If activating, deactivate all other terms for this school first
      await db.query(termQueries.deactivateAllTermsForSchool, [school]);
      // Then activate this term
      const { rows } = await db.query(termQueries.setTermActive, [id]);
      return res.status(200).json({
        status: 'success',
        data: mapTermToResponse(rows[0])
      });
    } else {
      // If deactivating, just set this term to inactive
      const { rows } = await db.query(termQueries.setTermInactive, [id]);
      return res.status(200).json({
        status: 'success',
        data: mapTermToResponse(rows[0])
      });
    }
  } catch (error) {
    logger.error('Error updating term status:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error updating term status'
    });
  }
};

/**
 * DELETE /api/terms/:id
 * Delete term
 */
const deleteTerm = async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    return res.status(400).json({
      status: 'failed',
      message: 'Term ID is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.deleteTerm, [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Term not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Term deleted successfully',
      data: mapTermToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error deleting term:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error deleting term'
    });
  }
};

/**
 * GET /api/terms/academic-year?school=SCHOOL_ENUM&year=2024-2025
 * Get terms for a specific academic year
 */
const getTermsByAcademicYear = async (req, res) => {
  const { school, year } = req.query;
  
  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School parameter is required'
    });
  }

  if (!year) {
    return res.status(400).json({
      status: 'failed',
      message: 'Academic year parameter is required'
    });
  }

  try {
    const { rows } = await db.query(termQueries.selectTermsByAcademicYear, [school, year]);
    return res.status(200).json({
      status: 'success',
      data: rows.map(mapTermToResponse)
    });
  } catch (error) {
    logger.error('Error fetching terms by academic year:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching terms'
    });
  }
};

module.exports = {
  getTermsBySchool,
  getTermsBySchoolId,
  getTermByNameAndSchool,
  getActiveTermBySchool,
  getCurrentTermBySchool,
  getTermById,
  createTerm,
  updateTerm,
  activateTerm,
  updateTermStatus,
  deleteTerm,
  getTermsByAcademicYear
};