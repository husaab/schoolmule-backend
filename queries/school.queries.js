// src/queries/school.queries.js

const schoolQueries = {
  /**
   * Get all schools
   */
  selectAllSchools: `
    SELECT 
      school_id,
      school_code,
      name,
      slug,
      address,
      phone,
      email,
      timezone,
      academic_year_start_date,
      academic_year_end_date,
      email_sending_domain,
      email_sender_local,
      email_reply_to,
      created_at,
      last_updated_at
    FROM schools
    ORDER BY name ASC
  `,

  /**
   * Get school by code (enum)
   * Params: school_code (public.school enum)
   */
  selectSchoolByCode: `
    SELECT 
      school_id,
      school_code,
      name,
      slug,
      address,
      phone,
      email,
      timezone,
      academic_year_start_date,
      academic_year_end_date,
      email_sending_domain,
      email_sender_local,
      email_reply_to,
      created_at,
      last_updated_at
    FROM schools
    WHERE school_code = $1
  `,

  /**
   * Get school by ID
   * Params: school_id (UUID)
   */
  selectSchoolById: `
    SELECT 
      school_id,
      school_code,
      name,
      slug,
      address,
      phone,
      email,
      timezone,
      academic_year_start_date,
      academic_year_end_date,
      email_sending_domain,
      email_sender_local,
      email_reply_to,
      created_at,
      last_updated_at
    FROM schools
    WHERE school_id = $1
  `,

  /**
   * Create new school
   * Params: school_code, name, address, phone, email, timezone, academic_year_start_date, academic_year_end_date
   */
  insertSchool: `
    INSERT INTO schools (
      school_code, 
      name, 
      address, 
      phone, 
      email, 
      timezone, 
      academic_year_start_date, 
      academic_year_end_date,
      last_updated_at
    ) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    RETURNING *
  `,

  /**
   * Update school
   * Params: name, address, phone, email, timezone, academic_year_start_date, academic_year_end_date,
   *         email_reply_to (TEXT[] or NULL to leave unchanged), school_id
   */
  updateSchool: `
    UPDATE schools 
    SET 
      name = $1,
      address = $2,
      phone = $3,
      email = $4,
      timezone = $5,
      academic_year_start_date = $6,
      academic_year_end_date = $7,
      email_reply_to = COALESCE($8::text[], email_reply_to),
      last_updated_at = NOW()
    WHERE school_id = $9
    RETURNING *
  `,

  /**
   * Delete school
   * Params: school_id (UUID)
   */
  deleteSchool: `
    DELETE FROM schools 
    WHERE school_id = $1
    RETURNING *
  `
};

module.exports = schoolQueries;