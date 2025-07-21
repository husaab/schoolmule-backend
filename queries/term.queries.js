// src/queries/term.queries.js

const termQueries = {
  /**
   * Get all terms for a school (by enum)
   * Params: school (public.school enum)
   */
  selectTermsBySchool: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.school = $1
    ORDER BY t.start_date ASC
  `,

  /**
   * Get a single term by name and school
   * Params: termName, school
   */
  selectTermByNameAndSchool: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.name = $1 AND t.school = $2
    LIMIT 1
  `,

  /**
   * Get all terms for a school (by school_id)
   * Params: school_id (UUID)
   */
  selectTermsBySchoolId: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.school_id = $1
    ORDER BY t.start_date ASC
  `,

  /**
   * Get active term for a school
   * Params: school (public.school enum)
   */
  selectActiveTermBySchool: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.school = $1 
      AND t.is_active = TRUE
  `,

  /**
   * Get current term by date for a school
   * Params: school (public.school enum), date
   */
  selectCurrentTermBySchool: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.school = $1 
      AND $2::date BETWEEN t.start_date AND t.end_date
  `,

  /**
   * Get term by ID
   * Params: term_id (UUID)
   */
  selectTermById: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.term_id = $1
  `,

  /**
   * Create new term
   * Params: school, school_id, name, start_date, end_date, academic_year, is_active
   */
  insertTerm: `
    INSERT INTO terms (
      school, 
      school_id, 
      name, 
      start_date, 
      end_date, 
      academic_year, 
      is_active,
      updated_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING *
  `,

  /**
   * Update term
   * Params: name, start_date, end_date, academic_year, is_active, term_id
   */
  updateTerm: `
    UPDATE terms 
    SET 
      name = $1,
      start_date = $2,
      end_date = $3,
      academic_year = $4,
      is_active = $5,
      updated_at = NOW()
    WHERE term_id = $6
    RETURNING *
  `,

  /**
   * Delete term
   * Params: term_id (UUID)
   */
  deleteTerm: `
    DELETE FROM terms 
    WHERE term_id = $1
    RETURNING *
  `,

  /**
   * Deactivate all terms for a school (before setting new active term)
   * Params: school (public.school enum)
   */
  deactivateAllTermsForSchool: `
    UPDATE terms 
    SET 
      is_active = FALSE,
      updated_at = NOW()
    WHERE school = $1
    RETURNING *
  `,

  /**
   * Set term as active (will deactivate others first)
   * Params: term_id (UUID)
   */
  setTermActive: `
    UPDATE terms 
    SET 
      is_active = TRUE,
      updated_at = NOW()
    WHERE term_id = $1
    RETURNING *
  `,

  /**
   * Set term as inactive
   * Params: term_id (UUID)
   */
  setTermInactive: `
    UPDATE terms 
    SET 
      is_active = FALSE,
      updated_at = NOW()
    WHERE term_id = $1
    RETURNING *
  `,

  /**
   * Get terms for academic year
   * Params: school (public.school enum), academic_year
   */
  selectTermsByAcademicYear: `
    SELECT 
      t.term_id,
      t.school,
      t.school_id,
      t.name,
      t.start_date,
      t.end_date,
      t.academic_year,
      t.is_active,
      t.created_at,
      t.updated_at,
      s.name as school_name
    FROM terms t
    LEFT JOIN schools s ON t.school_id = s.school_id
    WHERE t.school = $1 
      AND t.academic_year = $2
    ORDER BY t.start_date ASC
  `
};

module.exports = termQueries;