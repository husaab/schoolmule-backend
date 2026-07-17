// src/queries/schoolCalendar.queries.js

const schoolCalendarQueries = {
  /**
   * Get all events for a school within a date range (inclusive).
   * Range events overlap when start_date <= rangeEnd AND COALESCE(end_date, start_date) >= rangeStart.
   * Params: school (public.school enum), range_start (date), range_end (date)
   */
  selectEventsBySchoolAndRange: `
    SELECT
      e.event_id,
      e.school,
      e.school_id,
      e.title,
      e.category,
      e.start_date,
      e.end_date,
      e.is_school_closed,
      e.notes,
      e.created_at,
      e.updated_at
    FROM school_calendar_events e
    WHERE e.school = $1
      AND e.start_date <= $3
      AND COALESCE(e.end_date, e.start_date) >= $2
      AND ($4::uuid IS NULL OR e.school_year_id = $4)
    ORDER BY e.start_date ASC, e.title ASC
  `,

  /**
   * Get all events for a school
   * Params: school (public.school enum)
   */
  selectEventsBySchool: `
    SELECT
      e.event_id,
      e.school,
      e.school_id,
      e.title,
      e.category,
      e.start_date,
      e.end_date,
      e.is_school_closed,
      e.notes,
      e.created_at,
      e.updated_at
    FROM school_calendar_events e
    WHERE e.school = $1
      AND ($2::uuid IS NULL OR e.school_year_id = $2)
    ORDER BY e.start_date ASC, e.title ASC
  `,

  /**
   * Get a single event by ID
   * Params: event_id (UUID)
   */
  selectEventById: `
    SELECT
      e.event_id,
      e.school,
      e.school_id,
      e.title,
      e.category,
      e.start_date,
      e.end_date,
      e.is_school_closed,
      e.notes,
      e.created_at,
      e.updated_at
    FROM school_calendar_events e
    WHERE e.event_id = $1
  `,

  /**
   * Create new event
   * Params: school, school_id, title, category, start_date, end_date, is_school_closed, notes
   */
  insertEvent: `
    INSERT INTO school_calendar_events (
      school,
      school_id,
      title,
      category,
      start_date,
      end_date,
      is_school_closed,
      notes,
      school_year_id,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING *
  `,

  /**
   * Update event
   * Params: title, category, start_date, end_date, is_school_closed, notes, event_id
   */
  updateEvent: `
    UPDATE school_calendar_events
    SET
      title = $1,
      category = $2,
      start_date = $3,
      end_date = $4,
      is_school_closed = $5,
      notes = $6,
      updated_at = NOW()
    WHERE event_id = $7
    RETURNING *
  `,

  /**
   * Delete event
   * Params: event_id (UUID)
   */
  deleteEvent: `
    DELETE FROM school_calendar_events
    WHERE event_id = $1
    RETURNING *
  `
};

module.exports = schoolCalendarQueries;
