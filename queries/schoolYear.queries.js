const schoolYearQueries = {
  selectYearsBySchool: `
    SELECT school_year_id, school, school_id, label, start_date, end_date,
           is_active, created_from_year_id, created_at, updated_at
    FROM school_years
    WHERE school = $1
    ORDER BY start_date DESC
  `,

  selectYearById: `
    SELECT school_year_id, school, school_id, label, start_date, end_date,
           is_active, created_from_year_id, created_at, updated_at
    FROM school_years
    WHERE school_year_id = $1
  `,

  selectActiveYearBySchool: `
    SELECT school_year_id, school, school_id, label, start_date, end_date,
           is_active, created_from_year_id, created_at, updated_at
    FROM school_years
    WHERE school = $1 AND is_active = TRUE
  `,

  insertYear: `
    INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active, created_from_year_id)
    VALUES ($1, $2, $3, $4, $5, FALSE, $6)
    RETURNING *
  `,

  updateYear: `
    UPDATE school_years
    SET label = $2, start_date = $3, end_date = $4, updated_at = NOW()
    WHERE school_year_id = $1
    RETURNING *
  `,

  deleteYear: `
    DELETE FROM school_years
    WHERE school_year_id = $1 AND is_active = FALSE
    RETURNING school_year_id
  `,

  deactivateAllYearsForSchool: `
    UPDATE school_years SET is_active = FALSE, updated_at = NOW() WHERE school = $1
  `,

  setYearActive: `
    UPDATE school_years SET is_active = TRUE, updated_at = NOW()
    WHERE school_year_id = $1
    RETURNING *
  `,

  countTermsForYear: `
    SELECT COUNT(*)::int AS count FROM terms WHERE school_year_id = $1
  `,
};

module.exports = schoolYearQueries;
