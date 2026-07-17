// src/controllers/schoolCalendar.controller.js

const db = require('../config/database');
const schoolCalendarQueries = require('../queries/schoolCalendar.queries');
const logger = require('../logger');
const { academicYearToRange } = require('../utils/agendaCalendar');

/**
 * Helper function to convert event row to camelCase
 */
const mapEventToResponse = (event) => ({
  eventId: event.event_id,
  school: event.school,
  schoolId: event.school_id,
  title: event.title,
  category: event.category,
  startDate: event.start_date,
  endDate: event.end_date,
  isSchoolClosed: event.is_school_closed,
  notes: event.notes,
  createdAt: event.created_at,
  updatedAt: event.updated_at
});

/**
 * GET /api/calendar-events?school=SCHOOL_ENUM&academicYear=2025-2026
 * GET /api/calendar-events?school=SCHOOL_ENUM&from=2025-09-01&to=2025-09-30
 * Get events for a school, optionally within an academic year or date range
 */
const getEventsBySchool = async (req, res) => {
  const { school, academicYear, from, to } = req.query;

  if (!school) {
    return res.status(400).json({
      status: 'failed',
      message: 'School parameter is required'
    });
  }

  try {
    const yearId = req.schoolYear?.schoolYearId || null;
    let rows;
    if (academicYear) {
      const range = academicYearToRange(academicYear);
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchoolAndRange, [school, range.from, range.to, yearId]));
    } else if (from && to) {
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchoolAndRange, [school, from, to, yearId]));
    } else {
      ({ rows } = await db.query(schoolCalendarQueries.selectEventsBySchool, [school, yearId]));
    }

    return res.status(200).json({
      status: 'success',
      data: rows.map(mapEventToResponse)
    });
  } catch (error) {
    logger.error('Error fetching calendar events:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching calendar events'
    });
  }
};

/**
 * POST /api/calendar-events
 * Create a new calendar event
 */
const createEvent = async (req, res) => {
  const { school, title, category, startDate, endDate, isSchoolClosed, notes } = req.body;

  if (!school || !title || !startDate) {
    return res.status(400).json({
      status: 'failed',
      message: 'school, title and startDate are required'
    });
  }

  try {
    // Best-effort school_id resolution (school enum values match school_code)
    const { rows: schoolRows } = await db.query(
      'SELECT school_id FROM schools WHERE school_code = $1',
      [school]
    );
    const schoolId = schoolRows[0]?.school_id || null;

    const { rows } = await db.query(schoolCalendarQueries.insertEvent, [
      school,
      schoolId,
      title,
      category || 'event',
      startDate,
      endDate || null,
      isSchoolClosed === true,
      notes || null,
      req.schoolYear?.schoolYearId || null
    ]);

    return res.status(201).json({
      status: 'success',
      data: mapEventToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error creating calendar event:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error creating calendar event'
    });
  }
};

/**
 * PATCH /api/calendar-events/:eventId
 * Update a calendar event
 */
const updateEvent = async (req, res) => {
  const { eventId } = req.params;
  const { title, category, startDate, endDate, isSchoolClosed, notes } = req.body;

  try {
    const { rows: existingRows } = await db.query(schoolCalendarQueries.selectEventById, [eventId]);
    if (existingRows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Event not found'
      });
    }
    const existing = existingRows[0];

    const { rows } = await db.query(schoolCalendarQueries.updateEvent, [
      title ?? existing.title,
      category ?? existing.category,
      startDate ?? existing.start_date,
      endDate !== undefined ? endDate : existing.end_date,
      isSchoolClosed !== undefined ? isSchoolClosed === true : existing.is_school_closed,
      notes !== undefined ? notes : existing.notes,
      eventId
    ]);

    return res.status(200).json({
      status: 'success',
      data: mapEventToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error updating calendar event:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error updating calendar event'
    });
  }
};

/**
 * DELETE /api/calendar-events/:eventId
 * Delete a calendar event
 */
const deleteEvent = async (req, res) => {
  const { eventId } = req.params;

  try {
    const { rows } = await db.query(schoolCalendarQueries.deleteEvent, [eventId]);
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Event not found'
      });
    }

    return res.status(200).json({
      status: 'success',
      data: mapEventToResponse(rows[0])
    });
  } catch (error) {
    logger.error('Error deleting calendar event:', error);
    return res.status(500).json({
      status: 'failed',
      message: 'Error deleting calendar event'
    });
  }
};

module.exports = {
  getEventsBySchool,
  createEvent,
  updateEvent,
  deleteEvent
};
